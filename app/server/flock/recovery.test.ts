/**
 * The overnight cases, through the Host: the factory goes away and comes back,
 * tokens die, the flock disappears, the document is edited under a live
 * cluster. Every one ends with the mock having seen exactly the stop calls the
 * operator made - which, for most of them, is none.
 */
import './testenv.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Driver } from '../acp.ts';
import { parse, channelDir, remoteClusterId, DocumentError, type Factory } from '../factory.ts';
import { ConflictError, Host } from '../host.ts';
import { Queue } from '../queue.ts';
import type { LoopStatus } from '../runner.ts';
import { ConnectionStore } from './connections.ts';
import { Sidecar } from './sidecar.ts';
import { plainFetch, startMockFlock, until } from './testing.ts';

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch-test/recovery');
await fsp.rm(SCRATCH, { recursive: true, force: true });
await fsp.mkdir(SCRATCH, { recursive: true });
const flock = await startMockFlock(path.join(SCRATCH, 'secrets'));
after(() => flock.close());

/** A ConnectionStore with one connection to the mock, signed in. */
async function connected(name: string): Promise<{ store: ConnectionStore; cid: string }> {
  const home = path.join(SCRATCH, name, 'home');
  await fsp.mkdir(home, { recursive: true });
  const port = new URL(flock.base).port;
  const store = new ConnectionStore(path.join(home, 'flocks.json'), plainFetch, { cognitoEndpoint: new URL(`http://127.0.0.1:${port}/cognito`) });
  const view = await store.add({ apiUrl: flock.base, username: 'operator', password: 'flock' });
  return { store, cid: view.id };
}

function docFor(baseDir: string, id: string, cid: string, extra: Record<string, unknown> = {}): Factory {
  return parse({
    id, name: 'F', baseDir,
    loops: [
      { id: 'producer', prompt: 'p' },
      { id: 'remote', prompt: 'work @input to @output', remote: { kind: 'flock', connection: cid }, cluster: { size: 2 }, autoPause: false, ...extra },
      { id: 'consumer', prompt: 'c' },
    ],
    wires: [{ id: 'w1', from: 'producer', to: 'remote' }, { id: 'w2', from: 'remote', to: 'consumer' }],
  }, { id, name: 'F', baseDir });
}

const noDriver = {} as Driver;

async function host(_name: string, store: ConnectionStore, factory: Factory): Promise<{ host: Host; statuses: LoopStatus[] }> {
  const statuses: LoopStatus[] = [];
  const h = new Host(factory, noDriver, (event, data) => {
    if (event === 'status') statuses.push(data as LoopStatus);
  }, store);
  await h.prepare();
  return { host: h, statuses };
}

async function remoteState(h: Host): Promise<string | undefined> {
  return h.statusAll().find((s) => s.loop === 'remote')?.remote?.clusterState;
}

test('factory quits with the cluster running; restart reattaches, catches up, and the mock saw no stop', async () => {
  const { store, cid } = await connected('restart');
  const base = path.join(SCRATCH, 'restart', 'factory');
  const factory = docFor(base, 'f-restart', cid);
  const clusterId = remoteClusterId(cid, 'f-restart', 'remote');

  const a = await host('restart', store, factory);
  await a.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(a.host)) === 'running'));
  // The process ends. dispose() detaches; it must not stop.
  await a.host.dispose();
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);

  // Ten minutes pass (in spirit): the cluster produces three results.
  await flock.control('produce', { cluster: clusterId, count: 3 });

  const b = await host('restart', store, factory);
  // prepare() reconnects in the background.
  assert.ok(await until(async () => (await remoteState(b.host)) === 'running', 5000));
  const consumer = new Queue(path.resolve(base, channelDir(factory.wires[1])));
  assert.ok(await until(async () => (await consumer.count()) === 3, 5000));
  assert.equal((await flock.client.queueListAll(clusterId, 'queue/out/')).length, 0);
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);
  assert.ok(b.statuses.some((s) => s.remote?.sync === 'catching-up'));
  assert.ok(await until(() => b.host.statusAll().some((s) => s.remote?.sync === 'live')));
  // The card's Stop is Pause on a remote loop: the flock pauses, nothing stops.
  b.host.stopLoop('remote');
  assert.ok(await until(async () => (await remoteState(b.host)) === 'paused', 6000));
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);
  // Start on a paused cluster is Resume, not a fresh start.
  await b.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(b.host)) === 'running', 6000));
  // Only the zap (force stop) stops it.
  b.host.forceStopLoop('remote');
  assert.ok(await until(async () => (await remoteState(b.host)) === 'stopped', 6000));
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 1);
  await b.host.dispose();
});

test('refresh token dies: signed-out, cluster untouched; sign-in resumes', async () => {
  const { store, cid } = await connected('signout');
  const base = path.join(SCRATCH, 'signout', 'factory');
  const factory = docFor(base, 'f-signout', cid);
  const clusterId = remoteClusterId(cid, 'f-signout', 'remote');
  const h = await host('signout', store, factory);
  await h.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(h.host)) === 'running'));

  // The id token the session holds is about to expire and the refresh is dead.
  await flock.control('refresh-dies', { on: true });
  const session = await store.session(cid);
  (session as unknown as { expiresAt: number }).expiresAt = Date.now() + 1000;
  const remote = h.host.remoteOf('remote')!;
  assert.ok(await until(async () => {
    await remote.poll();
    return h.host.statusAll().some((s) => s.remote?.sync === 'signed-out');
  }, 5000));
  assert.equal(h.host.statusAll().find((s) => s.loop === 'remote')?.remote?.signedIn, false);
  // Last known state is kept on the card; the mock cluster is still running.
  assert.equal(await remoteState(h.host), 'running');
  assert.equal((await flock.counters()).clusters[clusterId].state, 'running');
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);

  // The operator signs in again; the mock's refresh works again too. The route
  // calls resumeSync() after a sign-in; so does this.
  await flock.control('refresh-dies', { on: false });
  await store.signIn(cid, { password: 'flock' });
  await flock.control('produce', { cluster: clusterId, count: 2 });
  await remote.resumeSync();
  assert.ok(await until(() => h.host.statusAll().some((s) => s.remote?.sync === 'live'), 8000));
  const consumer = new Queue(path.resolve(base, channelDir(factory.wires[1])));
  assert.ok(await until(async () => (await consumer.count()) === 2, 8000));
  await h.host.dispose();
});

test('sidecar lost: the document plus the marker on the flock re-attach the cluster', async () => {
  const { store, cid } = await connected('sidecar');
  const base = path.join(SCRATCH, 'sidecar', 'factory');
  const factory = docFor(base, 'f-sidecar', cid);
  const clusterId = remoteClusterId(cid, 'f-sidecar', 'remote');
  const a = await host('sidecar', store, factory);
  await a.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(a.host)) === 'running'));
  await a.host.dispose();
  await fsp.rm(path.join(base, '.kirofactory', 'remote.json'));
  await flock.control('produce', { cluster: clusterId, count: 1 });

  const b = await host('sidecar', store, factory);
  assert.ok(await until(async () => (await remoteState(b.host)) === 'running', 5000));
  assert.ok(await until(async () => (await new Sidecar(base).get(cid, clusterId)) !== undefined, 5000));
  const consumer = new Queue(path.resolve(base, channelDir(factory.wires[1])));
  assert.ok(await until(async () => (await consumer.count()) === 1, 5000));
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);
  await b.host.dispose();
});

test('cluster deleted remotely during the gap: entry gone, nothing recreated', async () => {
  const { store, cid } = await connected('gone');
  const base = path.join(SCRATCH, 'gone', 'factory');
  const factory = docFor(base, 'f-gone', cid);
  const clusterId = remoteClusterId(cid, 'f-gone', 'remote');
  const a = await host('gone', store, factory);
  await a.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(a.host)) === 'running'));
  await a.host.dispose();
  // Somebody stops and deletes it in the flock UI.
  await flock.client.stop(clusterId);
  await until(async () => (await flock.client.getStatus(clusterId)).clusterState === 'stopped');
  await flock.client.deleteCluster(clusterId);

  const startCalls = (await flock.counters()).clusters[clusterId]?.startCalls;
  const b = await host('gone', store, factory);
  assert.ok(await until(async () => (await new Sidecar(base).get(cid, clusterId))?.lastState === 'gone', 5000));
  assert.equal(await remoteState(b.host), 'gone');
  assert.equal(flock.clusters.has(clusterId), false);
  assert.equal((await flock.counters()).clusters[clusterId]?.startCalls, startCalls);
  await b.host.dispose();
});

test('editing the connection or disabling a live remote loop is refused; structural fields are a 400', async () => {
  const { store, cid } = await connected('edit');
  const base = path.join(SCRATCH, 'edit', 'factory');
  const factory = docFor(base, 'f-edit', cid);
  const h = await host('edit', store, factory);
  await h.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(h.host)) === 'running'));

  const raw = JSON.parse(JSON.stringify(factory)) as { loops: Record<string, unknown>[] };
  const changedConn = { ...raw, loops: raw.loops.map((l) => (l.id === 'remote' ? { ...l, remote: { kind: 'flock', connection: 'fc-other' } } : l)) };
  await assert.rejects(h.host.replace(changedConn), ConflictError);
  const disabled = { ...raw, loops: raw.loops.map((l) => (l.id === 'remote' ? { ...l, disabled: true } : l)) };
  await assert.rejects(h.host.replace(disabled), ConflictError);
  const withTools = { ...raw, loops: raw.loops.map((l) => (l.id === 'remote' ? { ...l, tools: ['read'] } : l)) };
  await assert.rejects(h.host.replace(withTools), DocumentError);

  // An ordinary edit goes through and reaches the cluster.
  const newPrompt = { ...raw, loops: raw.loops.map((l) => (l.id === 'remote' ? { ...l, prompt: 'changed words @input' } : l)) };
  await h.host.replace(newPrompt);
  const clusterId = remoteClusterId(cid, 'f-edit', 'remote');
  assert.ok(await until(async () => (await flock.client.getDirection(clusterId)).includes('changed words')));
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);
  await h.host.dispose();
});

test('removing the loop from the document detaches; the cluster keeps running', async () => {
  const { store, cid } = await connected('removeloop');
  const base = path.join(SCRATCH, 'removeloop', 'factory');
  const factory = docFor(base, 'f-removeloop', cid);
  const clusterId = remoteClusterId(cid, 'f-removeloop', 'remote');
  const h = await host('removeloop', store, factory);
  await h.host.startLoop('remote');
  assert.ok(await until(async () => (await remoteState(h.host)) === 'running'));
  const raw = JSON.parse(JSON.stringify(factory)) as { loops: Record<string, unknown>[]; wires: unknown[] };
  await h.host.replace({ ...raw, loops: raw.loops.filter((l) => l.id !== 'remote'), wires: [] });
  assert.equal(h.host.remoteOf('remote'), undefined);
  assert.equal((await flock.counters()).clusters[clusterId].state, 'running');
  assert.equal((await flock.counters()).clusters[clusterId].stopCalls, 0);
  await h.host.dispose();
  await flock.client.stop(clusterId);
});
test('a stopped remote loop pointed at another connection starts on that connection, not the cached one', async () => {
  // Two connections to the same mock flock; what matters is which id the cluster is derived from.
  const { store, cid } = await connected('repoint');
  const second = await store.add({ apiUrl: flock.base, username: 'other', password: 'flock', name: 'Second' });
  const base = path.join(SCRATCH, 'repoint', 'factory');
  const factory = docFor(base, 'f-repoint', cid);
  const h = await host('repoint', store, factory);
  await h.host.startLoop('remote');
  const firstCluster = remoteClusterId(cid, 'f-repoint', 'remote');
  assert.ok(await until(async () => (await remoteState(h.host)) === 'running'));
  h.host.forceStopLoop('remote');
  assert.ok(await until(async () => !(h.host.remoteOf('remote')?.isLive() ?? false)));
  // Re-point in the document (what the panel's picker does) and start again.
  const raw = JSON.parse(JSON.stringify(h.host.doc())) as { loops: Record<string, unknown>[] };
  await h.host.replace({ ...raw, loops: raw.loops.map((l) => (l.id === 'remote' ? { ...l, remote: { kind: 'flock', connection: second.id } } : l)) });
  await h.host.startLoop('remote');
  const secondCluster = remoteClusterId(second.id, 'f-repoint', 'remote');
  assert.notEqual(secondCluster, firstCluster);
  assert.ok(await until(async () => (await flock.counters()).clusters[secondCluster]?.state === 'running'));
  assert.equal(h.host.remoteOf('remote')!.clusterId, secondCluster);
  assert.equal((await flock.counters()).clusters[firstCluster].startCalls, 1);
  await h.host.dispose();
  await flock.client.stop(secondCluster);
});
