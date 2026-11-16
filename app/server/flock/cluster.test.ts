import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { parse, channelDir, remoteClusterId, type Factory } from '../factory.ts';
import { Queue } from '../queue.ts';
import type { LoopStatus, OutputLine } from '../runner.ts';
import { RemoteCluster, RemoteStartError } from './cluster.ts';
import { Sidecar } from './sidecar.ts';
import { startMockFlock, until } from './testing.ts';

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch-test/cluster');
await fsp.rm(SCRATCH, { recursive: true, force: true });
await fsp.mkdir(SCRATCH, { recursive: true });
const flock = await startMockFlock(path.join(SCRATCH, 'secrets'));
after(() => flock.close());

function doc(baseDir: string, id: string, extra: Record<string, unknown> = {}): Factory {
  return parse({
    id, name: 'F', baseDir,
    loops: [
      { id: 'producer', prompt: 'p' },
      { id: 'remote', prompt: 'do @input into @output', remote: { kind: 'flock', connection: 'fc-test' }, cluster: { size: 2 }, autoPause: true, model: 'claude-haiku-4.5', ...extra },
      { id: 'consumer', prompt: 'c' },
    ],
    wires: [{ id: 'w1', from: 'producer', to: 'remote' }, { id: 'w2', from: 'remote', to: 'consumer' }],
  }, { id, name: 'F', baseDir });
}

interface Rig {
  base: string;
  factory: Factory;
  statuses: LoopStatus[];
  output: OutputLine[];
  make(): RemoteCluster;
  clusterId: string;
}

async function rig(name: string, extra: Record<string, unknown> = {}): Promise<Rig> {
  const base = path.join(SCRATCH, name);
  await fsp.mkdir(base, { recursive: true });
  const factoryId = `f-${name}`;
  const r: Rig = {
    base, factory: doc(base, factoryId, extra), statuses: [], output: [],
    clusterId: remoteClusterId('fc-test', factoryId, 'remote'),
    make: () => new RemoteCluster({
      loopId: 'remote', connectionId: 'fc-test', connectionName: 'Mock', apiUrl: flock.base,
      client: flock.client, auth: flock.auth, sidecar: new Sidecar(base),
      factory: () => r.factory,
      // What Host.patchLoop does, minus the save: the patch goes through `parse`.
      patchLoop: async (loopId, patch) => {
        r.factory = parse(
          { ...r.factory, loops: r.factory.loops.map((l) => (l.id === loopId ? { ...l, ...patch } : l)) },
          { id: r.factory.id, name: r.factory.name, baseDir: r.factory.baseDir },
        );
      },
      emit: ((event: string, data: unknown) => {
        if (event === 'status') r.statuses.push(data as LoopStatus);
        else r.output.push(data as OutputLine);
      }) as RemoteCluster['d' & keyof RemoteCluster] extends never ? never : (event: 'status' | 'output', data: never) => void,
    }),
  };
  return r;
}

test('start writes config and direction, starts, and the card shows N running members', async () => {
  const r = await rig('start');
  const rc = r.make();
  await rc.start();
  const cfg = await flock.client.getConfig(r.clusterId);
  assert.equal(cfg.concurrency, 2);
  assert.equal(cfg.algorithm, 'amorphous');
  assert.equal(cfg.autopause, true);
  assert.equal(cfg.model, 'claude-haiku-4.5');
  assert.equal(cfg.trustDeploy, false);
  const direction = await flock.client.getDirection(r.clusterId);
  assert.ok(direction.startsWith('<!-- kirofactory: factory=f-start; loop=remote; connection=fc-test;'));
  // The one-letter name 'F' is too short for a group, so the factory id is the group and the folder nests under it.
  assert.ok(direction.includes(`/environment/${r.factory.remoteGroup}/${r.clusterId}/queue/in/`), direction);
  assert.ok(direction.includes('claimed/in/'));
  assert.ok((await flock.client.queueListAll(r.clusterId, 'queue/PROTOCOL.md')).length === 1);
  assert.ok(await until(() => rc.state === 'running'));
  const st = rc.statuses();
  assert.equal(st.length, 2);
  assert.equal(st[0].state, 'running');
  assert.equal(st[0].remote?.clusterState, 'running');
  assert.equal(st[0].remote?.uiUrl, `${flock.base}/?cluster=${r.clusterId}`);
  assert.equal(st[1].member, 1);
  // Stop lands.
  await rc.stop();
  assert.ok(await until(() => rc.state === 'stopped', 5000));
  rc.detach();
  const counters = await flock.counters();
  assert.equal(counters.clusters[r.clusterId].stopCalls, 1);
});

test('detach never stops the cluster; a fresh RemoteCluster re-attaches and catches up', async () => {
  const r = await rig('detach');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  // Work arrives while attached...
  const inbox = new Queue(path.resolve(r.base, channelDir(r.factory.wires[0])));
  await inbox.put({ producer: 'producer', payload: { n: 1 } });
  rc.detach(); // the factory "quits"
  // ...and the cluster keeps producing while the factory is away.
  await flock.control('produce', { cluster: r.clusterId, count: 3 });
  const before = await flock.counters();
  assert.equal(before.clusters[r.clusterId].stopCalls, 0);
  assert.equal(before.clusters[r.clusterId].state, 'running');

  const rc2 = r.make();
  await rc2.attach();
  assert.equal(rc2.state, 'running');
  const consumer = new Queue(path.resolve(r.base, channelDir(r.factory.wires[1])));
  assert.ok(await until(async () => (await consumer.count()) === 3));
  assert.equal((await flock.client.queueListAll(r.clusterId, 'queue/out/')).length, 0);
  // The local item that was waiting went up too.
  assert.ok(await until(async () => (await flock.client.queueListAll(r.clusterId, 'queue/in/')).length + (await flock.client.queueListAll(r.clusterId, 'queue/claimed/in/')).length >= 1));
  assert.ok(r.output.some((l) => l.text.includes('reconnected')));
  const after2 = await flock.counters();
  assert.equal(after2.clusters[r.clusterId].stopCalls, 0);
  await rc2.stop();
  await until(() => rc2.state === 'stopped', 5000);
  rc2.detach();
});

test('autopause plus new input resumes the cluster once', async () => {
  const r = await rig('autopause');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  flock.tick(r.clusterId); flock.tick(r.clusterId); flock.tick(r.clusterId);
  // poll() shares an in-flight request, so one call may answer from before the
  // ticks; ask until the answer reflects them.
  assert.ok(await until(async () => { await rc.poll(); return rc.state === 'paused'; }));
  assert.equal(rc.statuses()[0].pausedFor, 'work');
  const inbox = new Queue(path.resolve(r.base, channelDir(r.factory.wires[0])));
  await inbox.put({ producer: 'producer', payload: { wake: true } });
  assert.ok(await until(() => rc.state === 'running', 6000));
  assert.equal((await flock.counters()).clusters[r.clusterId].resumeCalls, 1);
  await rc.forceStop();
  rc.detach();
});

test('a size over the flock cap fails Start with the flock message, and nothing was started', async () => {
  await flock.control('cap', { concurrencyCap: 1 });
  const r = await rig('cap');
  const rc = r.make();
  await assert.rejects(rc.start(), (e: unknown) => {
    assert.ok(e instanceof RemoteStartError);
    assert.equal(e.message, 'concurrency 2 exceeds the configured cap of 1');
    return true;
  });
  await flock.control('cap', { concurrencyCap: 64 });
  assert.equal((await flock.counters()).clusters[r.clusterId]?.startCalls ?? 0, 0);
});

test('a prompt with @project or a model not in the catalog is refused before any flock write', async () => {
  const r = await rig('invalid', { prompt: 'look at @project and @aws-docs', model: 'nope' });
  const rc = r.make();
  await assert.rejects(rc.start(), (e: unknown) => {
    const m = (e as Error).message;
    assert.ok(m.includes('@project'));
    assert.ok(m.includes('@aws-docs'));
    assert.ok(m.includes('nope'));
    return true;
  });
  assert.equal(flock.clusters.has(r.clusterId), false);
});

test('a flock without the queue routes is refused with the update message', async () => {
  const r = await rig('noroutes');
  const rc = r.make();
  await flock.control('no-queue-routes', { on: true });
  await assert.rejects(rc.start(), /Update your flock to use remote loops/);
  await flock.control('no-queue-routes', { on: false });
  assert.equal(rc.statuses()[0].remote?.problem?.includes('Update your flock'), true);
});

test('"After N hours" stops the cluster when overdue at reconnect; no run mode never stops it', async () => {
  const r = await rig('runUntil', { stopAfterHours: 0.0001 }); // 0.36 s
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  rc.detach();
  await new Promise((res) => setTimeout(res, 500));
  const rc2 = r.make();
  await rc2.attach();
  assert.ok(await until(() => rc2.state === 'stopping' || rc2.state === 'stopped', 5000));
  assert.ok(r.output.some((l) => l.text.includes('run time')));
  rc2.detach();
});

test('pushDocument updates the direction and every synced setting on a live cluster', async () => {
  const r = await rig('push');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  r.factory = doc(r.base, 'f-push', {
    prompt: 'new words', autoPause: false, intervalSeconds: 60, cluster: { size: 4 },
    remote: { kind: 'flock', connection: 'fc-test', algorithm: 'swarm', swarmK: 2, taskSize: 'large' },
  });
  await rc.pushDocument();
  assert.ok((await flock.client.getDirection(r.clusterId)).includes('new words'));
  const cfg = await flock.client.getConfig(r.clusterId);
  assert.equal(cfg.autopause, false);
  assert.equal(cfg.loopIntervalSeconds, 60);
  assert.equal(cfg.concurrency, 4);
  assert.equal(cfg.algorithm, 'swarm');
  assert.equal(cfg.swarmK, 2);
  assert.equal(cfg.taskSize, 'large');
  assert.ok(r.output.some((l) => l.text.includes('next start')));
  await rc.forceStop();
  rc.detach();
});

test('the algorithm travels: single allows one node, swarm sends K, and the flock reads them back', async () => {
  const r = await rig('algo', { cluster: { size: 1 }, remote: { kind: 'flock', connection: 'fc-test', algorithm: 'single' } });
  assert.equal(r.factory.loops[1].cluster?.size, 1);
  const rc = r.make();
  await rc.start();
  const cfg = await flock.client.getConfig(r.clusterId);
  assert.equal(cfg.algorithm, 'single');
  assert.equal(cfg.concurrency, 1);
  assert.ok(await until(() => rc.state === 'running'));
  assert.equal(rc.statuses().length, 1);
  await rc.forceStop();
  rc.detach();
});

test('settings and direction edited on the flock come back into the document', async () => {
  const r = await rig('pull');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  // An operator on the flock's dashboard changes the config and the direction.
  await flock.client.setConfig(r.clusterId, { autopause: false, loopIntervalSeconds: 90, algorithm: 'mesh', concurrency: 5, model: null });
  const p = `/environment/${r.factory.remoteGroup}/${r.clusterId}`;
  await flock.client.setDirection(r.clusterId, `<!-- kirofactory: factory=f-pull; loop=remote; connection=fc-test; do not remove -->\nread ${p}/queue/in/ and write ${p}/queue/out/, notes in ${p}/loop/agent-<your agent number>/\n\n## Queues (added by Kiro Factory)\n\nwhatever the operator left of this\n`);
  await rc.pullFromFlock();
  const loop = r.factory.loops[1];
  assert.equal(loop.autoPause, false);
  assert.equal(loop.intervalSeconds, 90);
  assert.equal(loop.remote?.algorithm, 'mesh');
  assert.equal(loop.cluster?.size, 5);
  assert.equal(loop.model, undefined);
  assert.equal(loop.prompt, 'read @input and write @output, notes in @loop');
  // The direction on the flock is whole again: marker, prompt, the factory's queue block.
  const direction = await flock.client.getDirection(r.clusterId);
  assert.ok(direction.startsWith('<!-- kirofactory: factory=f-pull'));
  assert.ok(direction.includes('move it to'));
  assert.equal(direction.includes('whatever the operator left'), false);
  // Agreed now: another pull changes nothing, and a push with no local edit sends nothing.
  const before = JSON.stringify(r.factory.loops[1]);
  await rc.pullFromFlock();
  await rc.pushDocument();
  assert.equal(JSON.stringify(r.factory.loops[1]), before);
  assert.equal((await flock.client.getConfig(r.clusterId)).algorithm, 'mesh');
  // A local edit after that wins over the agreed state and reaches the flock.
  r.factory = doc(r.base, 'f-pull', { prompt: 'local again', autoPause: false, intervalSeconds: 90, cluster: { size: 5 }, remote: { kind: 'flock', connection: 'fc-test', algorithm: 'mesh' }, model: undefined });
  await rc.pushDocument();
  assert.ok((await flock.client.getDirection(r.clusterId)).includes('local again'));
  // An emptied direction is put back rather than taken as an empty prompt.
  await flock.client.setDirection(r.clusterId, '   ');
  await rc.pullFromFlock();
  assert.equal(r.factory.loops[1].prompt, 'local again');
  assert.ok((await flock.client.getDirection(r.clusterId)).includes('local again'));
  await rc.forceStop();
  rc.detach();
});

test('a reconnecting factory takes the flock\'s settings as the newer ones', async () => {
  const r = await rig('adopt');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  rc.detach();
  await flock.client.setConfig(r.clusterId, { autopause: false, taskSize: 'xlarge' });
  const rc2 = r.make();
  await rc2.attach();
  assert.equal(r.factory.loops[1].autoPause, false);
  assert.equal(r.factory.loops[1].remote?.taskSize, 'xlarge');
  await rc2.forceStop();
  rc2.detach();
});

test('destroy stops, unregisters, and optionally removes the S3 folder', async () => {
  const r = await rig('destroy');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  await rc.destroy(true);
  assert.equal(flock.clusters.has(r.clusterId), false);
  assert.equal([...flock.objects.keys()].some((k) => k.includes(`/${r.clusterId}/`)), false);
  assert.equal(await new Sidecar(r.base).get('fc-test', r.clusterId), undefined);
});
test('the options travel: browser, trust deploy and reflect reach the flock and come back', async () => {
  const r = await rig('options', { remote: { kind: 'flock', connection: 'fc-test', browser: true, trustDeploy: true, selfOptimizing: true } });
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  const cfg = await flock.client.getConfig(r.clusterId);
  assert.equal(cfg.browserAutomation, true);
  assert.equal(cfg.trustDeploy, true);
  assert.equal(cfg.selfOptimizing, true);
  // Unticked on the flock's dashboard: the fields leave the document rather than becoming false.
  await flock.client.setConfig(r.clusterId, { browserAutomation: false, trustDeploy: false, selfOptimizing: false });
  await rc.pullFromFlock();
  assert.deepEqual(r.factory.loops[1].remote, { kind: 'flock', connection: 'fc-test', neighbourRadius: 1 });
  // Ticked here again: the push carries them, and says they wait for the next start.
  r.factory = doc(r.base, 'f-options', { remote: { kind: 'flock', connection: 'fc-test', trustDeploy: true } });
  await rc.pushDocument();
  assert.equal((await flock.client.getConfig(r.clusterId)).trustDeploy, true);
  assert.ok(r.output.some((o) => o.text.includes('trustDeploy: the flock applies these on the next start')));
  await rc.forceStop();
  rc.detach();
});

test('the deployment group travels: start sets it, the paths nest under it, and the record folder is the group\'s', async () => {
  const r = await rig('group');
  assert.equal(r.factory.remoteGroup, 'f-group');
  const rc = r.make();
  await rc.start();
  await until(() => rc.state === 'running');
  const cfg = await flock.client.getConfig(r.clusterId);
  assert.equal(cfg.everforgeGroup, 'f-group');
  assert.ok((await flock.client.getDirection(r.clusterId)).includes(`/environment/f-group/${r.clusterId}/queue/out/`));
  // The bridge lists and reads through the scoped routes, which the mock nests the same way.
  assert.ok([...flock.objects.keys()].some((k) => k.startsWith(`environment/f-group/${r.clusterId}/queue/`)));
  await rc.forceStop();
  rc.detach();
});
