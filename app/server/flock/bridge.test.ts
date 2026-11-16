import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parse, channelDir, type Factory } from '../factory.ts';
import { Queue } from '../queue.ts';
import { QueueBridge, type SyncState } from './bridge.ts';
import { Sidecar } from './sidecar.ts';
import { startMockFlock } from './testing.ts';
import type { ClusterState } from './client.ts';

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch-test/bridge');
await fsp.rm(SCRATCH, { recursive: true, force: true });
await fsp.mkdir(SCRATCH, { recursive: true });
const flock = await startMockFlock(path.join(SCRATCH, 'secrets'));
after(() => flock.close());

/** producer -> remote -> consumer, in `mode`. */
function doc(baseDir: string, mode: 'queue' | 'topic', extraConsumer = false): Factory {
  return parse({
    id: 'f1', name: 'F', baseDir,
    loops: [
      { id: 'producer', prompt: 'p' },
      { id: 'remote', prompt: 'r', remote: { kind: 'flock', connection: 'fc-test' }, cluster: { size: 2 } },
      { id: 'consumer', prompt: 'c' },
      ...(extraConsumer ? [{ id: 'consumer2', prompt: 'c2' }] : []),
    ],
    wires: [
      { id: 'w1', from: 'producer', to: 'remote', mode },
      { id: 'w2', from: 'remote', to: 'consumer', mode },
      ...(extraConsumer ? [{ id: 'w3', from: 'remote', to: 'consumer2', mode }] : []),
    ],
  }, { id: 'f1', name: 'F', baseDir });
}

interface Rig {
  base: string;
  factory: Factory;
  bridge: QueueBridge;
  sidecar: Sidecar;
  state: { value: ClusterState };
  log: string[];
  uploads: number;
  syncs: SyncState[];
  inbox: Queue;
  out(loop: string): Queue;
}

async function rig(name: string, clusterId: string, mode: 'queue' | 'topic' = 'queue', extraConsumer = false): Promise<Rig> {
  const base = path.join(SCRATCH, name);
  await fsp.mkdir(base, { recursive: true });
  const factory = doc(base, mode, extraConsumer);
  const sidecar = new Sidecar(base);
  const state = { value: 'running' as ClusterState };
  const r: Rig = {
    base, factory, sidecar, state, log: [], uploads: 0, syncs: [],
    bridge: null as unknown as QueueBridge,
    inbox: new Queue(path.resolve(base, channelDir(factory.wires[0]))),
    out: (loop: string) => new Queue(path.resolve(base, channelDir(factory.wires.find((w) => w.to === loop)!))),
  };
  r.bridge = new QueueBridge({
    client: flock.client, clusterId, group: () => null, connectionId: 'fc-test', loopId: 'remote', baseDir: base, sidecar,
    factory: () => r.factory,
    clusterState: () => r.state.value,
    log: (l) => r.log.push(l),
    onUploaded: () => { r.uploads += 1; },
    onSync: (s) => r.syncs.push(s),
  });
  await flock.client.setConfig(clusterId, { concurrency: 2 });
  return r;
}

async function remoteKeys(clusterId: string, prefix: string): Promise<string[]> {
  return (await flock.client.queueListAll(clusterId, prefix)).map((f) => f.key);
}

test('ten local items are taken, uploaded once each and removed locally', async () => {
  const r = await rig('ten', 'kf-ten00001');
  for (let i = 0; i < 10; i++) await r.inbox.put({ producer: 'producer', payload: { i } });
  await r.bridge.start();
  await r.bridge.tick();
  r.bridge.stop();
  assert.equal(await r.inbox.count(), 0);
  const keys = await remoteKeys('kf-ten00001', 'queue/in/');
  assert.equal(keys.length, 10);
  assert.equal(r.uploads, 1);
  assert.equal(r.bridge.pending.outgoing, 0);
  // A second tick uploads nothing new.
  await r.bridge.tick();
  assert.equal((await remoteKeys('kf-ten00001', 'queue/in/')).length, 10);
});

test('an item left in outgoing/ by a crash is uploaded exactly once on restart', async () => {
  const r = await rig('crash', 'kf-crash0001');
  const item = await r.inbox.put({ producer: 'producer', payload: { crash: true } });
  // Simulate: taken into outgoing/, process died before the upload.
  const dir = await r.sidecar.bridgeDir('fc-test', 'kf-crash0001');
  await fsp.rename(path.join(r.inbox.dir, `${item.id}.json`), path.join(dir, 'outgoing', `${item.id}.json`));
  // And one that was uploaded but not yet removed locally (412 path).
  const item2 = await r.inbox.put({ producer: 'producer', payload: { crash: 2 } });
  const body2 = await fsp.readFile(path.join(r.inbox.dir, `${item2.id}.json`), 'utf8');
  await fsp.rename(path.join(r.inbox.dir, `${item2.id}.json`), path.join(dir, 'outgoing', `${item2.id}.json`));
  await flock.client.queuePut('kf-crash0001', `queue/in/${item2.id}.json`, body2, true);

  await r.bridge.start();
  await r.bridge.tick();
  r.bridge.stop();
  const keys = await remoteKeys('kf-crash0001', 'queue/in/');
  assert.deepEqual(keys.sort(), [`queue/in/${item.id}.json`, `queue/in/${item2.id}.json`].sort());
  assert.equal((await fsp.readdir(path.join(dir, 'outgoing'))).length, 0);
});

test('results appear downstream once, in queue mode and in topic mode, and move to claimed/out/', async () => {
  for (const mode of ['queue', 'topic'] as const) {
    const id = `kf-${mode}00001`;
    const r = await rig(`out-${mode}`, id, mode, true);
    await flock.client.setDirection(id, 'x');
    await flock.client.start(id);
    r.state.value = 'running';
    await r.inbox.put({ producer: 'producer', payload: { a: 1 } });
    await r.inbox.put({ producer: 'producer', payload: { a: 2 } });
    await r.bridge.start();
    await r.bridge.tick();
    // Let the mock's agents work, then collect.
    await new Promise((res) => setTimeout(res, 100));
    flock.tick(id);
    await r.bridge.catchUp();
    r.bridge.stop();
    const c1 = await r.out('consumer').list();
    const c2 = await r.out('consumer2').list();
    if (mode === 'queue') {
      // One shared folder for both consumers.
      assert.equal(r.out('consumer').dir, r.out('consumer2').dir);
      assert.equal(c1.length, 2);
    } else {
      assert.notEqual(r.out('consumer').dir, r.out('consumer2').dir);
      assert.equal(c1.length, 2);
      assert.equal(c2.length, 2);
    }
    assert.equal(c1[0].producer, 'remote');
    assert.ok(c1.every((i) => typeof i.payload === 'object'));
    assert.equal((await remoteKeys(id, 'queue/out/')).length, 0);
    assert.equal((await remoteKeys(id, 'queue/claimed/out/')).length, 2);
    assert.equal((await remoteKeys(id, 'queue/claimed/in/')).length, 2);
    // Collecting again changes nothing locally.
    await r.bridge.catchUp();
    assert.equal((await r.out('consumer').list()).length, 2);
    await flock.client.stop(id);
  }
});

test('an item with an artifact over the limit is parked locally in rejected/', async () => {
  const r = await rig('big', 'kf-big000001');
  const bigFile = path.join(r.base, 'big.txt');
  await fsp.writeFile(bigFile, 'x'.repeat(300_000));
  await r.inbox.put({ producer: 'producer', artifact: 'big.txt' });
  const small = path.join(r.base, 'small.txt');
  await fsp.writeFile(small, 'hello');
  await r.inbox.put({ producer: 'producer', artifact: 'small.txt' });
  await r.bridge.start();
  await r.bridge.tick();
  r.bridge.stop();
  const dir = await r.sidecar.bridgeDir('fc-test', 'kf-big000001');
  assert.equal((await fsp.readdir(path.join(dir, 'rejected'))).length, 1);
  const keys = await remoteKeys('kf-big000001', 'queue/in/');
  assert.equal(keys.length, 1);
  const body = await flock.client.readFile(`environment/kf-big000001/${keys[0]}`);
  assert.ok(body.includes('"artifactContent":"hello"'));
  assert.ok(r.log.some((l) => l.includes('rejected/')));
});

test('two bridges for two connections with the same cluster id keep separate folders', async () => {
  const base = path.join(SCRATCH, 'two');
  const sidecar = new Sidecar(base);
  const a = await sidecar.bridgeDir('fc-a', 'kf-same');
  const b = await sidecar.bridgeDir('fc-b', 'kf-same');
  assert.notEqual(a, b);
  await sidecar.put({ loopId: 'l', connection: 'fc-a', clusterId: 'kf-same' });
  await sidecar.put({ loopId: 'l', connection: 'fc-b', clusterId: 'kf-same' });
  assert.equal((await sidecar.entries()).length, 2);
});

test('1000 pre-existing results are collected over several passes; sync goes catching-up then live', async () => {
  const id = 'kf-catchup01';
  const r = await rig('catchup', id);
  await flock.control('produce', { cluster: id, count: 1000 });
  await r.bridge.start();
  await r.bridge.tick();
  const first = r.syncs[0];
  assert.equal(first, 'catching-up');
  await r.bridge.catchUp();
  await r.bridge.tick();
  r.bridge.stop();
  assert.equal((await r.out('consumer').list()).length, 1000);
  assert.equal((await remoteKeys(id, 'queue/out/')).length, 0);
  assert.equal(r.bridge.sync, 'live');
});

test('a result that is not JSON is parked in queue/rejected/ on the flock', async () => {
  const id = 'kf-badjson01';
  const r = await rig('badjson', id);
  flock.objects.set(`environment/${id}/queue/out/garbage.json`, { body: 'not json {', lastModified: new Date() });
  await r.bridge.start();
  await r.bridge.catchUp();
  r.bridge.stop();
  assert.equal((await remoteKeys(id, 'queue/rejected/')).length, 1);
  assert.equal((await remoteKeys(id, 'queue/out/')).length, 0);
  assert.equal((await r.out('consumer').list()).length, 0);
});

test('a result whose id or key would escape the wire folder is parked, and its artifact is dropped', async () => {
  const id = 'kf-traverse01';
  const r = await rig('traverse', id);
  const canary = path.join(r.base, 'pwned.json');
  const out = `environment/${id}/queue/out/`;
  // A traversal id with a well-formed key.
  flock.objects.set(`${out}ok1.json`, { body: JSON.stringify({ id: '../../pwned', payload: 1 }), lastModified: new Date() });
  // An absolute id, a dotfile id, and an id that is only a separator.
  flock.objects.set(`${out}ok2.json`, { body: JSON.stringify({ id: '/tmp/pwned', payload: 2 }), lastModified: new Date() });
  flock.objects.set(`${out}ok3.json`, { body: JSON.stringify({ id: '.hidden', payload: 3 }), lastModified: new Date() });
  // No id, and a key stem that is not a usable name: the fallback must be refused
  // too. (A stem with a separator cannot exist: the flock's scoped routes refuse
  // `..` and `/` in queue keys, so a legal-but-unusable stem is the case left.)
  flock.objects.set(`${out}.dotfile.json`, { body: JSON.stringify({ payload: 4 }), lastModified: new Date() });
  // A good id carrying an artifact pointing anywhere: delivered, artifact gone.
  flock.objects.set(`${out}good.json`, { body: JSON.stringify({ id: 'good-1', payload: 6, artifact: '/etc/passwd' }), lastModified: new Date() });
  await r.bridge.start();
  await r.bridge.catchUp();
  r.bridge.stop();

  await assert.rejects(fsp.stat(canary));
  const delivered = await r.out('consumer').list();
  assert.deepEqual(delivered.map((i) => i.id), ['good-1']);
  assert.equal('artifact' in delivered[0]!, false);
  assert.equal(delivered[0]!.payload, 6);
  const rejected = await remoteKeys(id, 'queue/rejected/');
  assert.equal(rejected.length, 4);
  assert.equal((await remoteKeys(id, 'queue/out/')).length, 0);
  // Nothing ended up beside the wire folder either.
  const names = await fsp.readdir(r.base);
  assert.ok(!names.some((n) => n.includes('pwned')), names.join(','));
});

test('offline flock: sync goes unreachable, nothing is lost, recovers', async () => {
  const id = 'kf-offline01';
  const r = await rig('offline', id);
  await r.inbox.put({ producer: 'producer', payload: { x: 1 } });
  await flock.control('offline', { on: true });
  await r.bridge.start();
  await r.bridge.tick();
  assert.equal(r.bridge.sync, 'unreachable');
  // Taken locally but not uploaded: still in outgoing/.
  const dir = await r.sidecar.bridgeDir('fc-test', id);
  assert.equal((await fsp.readdir(path.join(dir, 'outgoing'))).length, 1);
  await flock.control('offline', { on: false });
  await r.bridge.tick();
  r.bridge.stop();
  assert.equal(r.bridge.sync, 'live');
  assert.equal((await remoteKeys(id, 'queue/in/')).length, 1);
  assert.equal((await fsp.readdir(path.join(dir, 'outgoing'))).length, 0);
});
