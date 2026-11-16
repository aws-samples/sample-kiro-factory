import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { startMockFlock, until } from './testing.ts';
import { FlockApiError, QueueExistsError } from './client.ts';
import { CognitoAuth, MfaRequired, NotAuthorized, SecretStore } from './auth.ts';

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch-test/client');
await fsp.rm(SCRATCH, { recursive: true, force: true });
const flock = await startMockFlock(path.join(SCRATCH, 'secrets'));
after(() => flock.close());

test('list, models, limits', async () => {
  assert.deepEqual(await flock.client.listClusters(), []);
  const models = await flock.client.listModels();
  assert.ok(models.models.some((m) => m.model_id === 'claude-haiku-4.5'));
  assert.equal((await flock.client.limits()).concurrencyCap, 64);
});

test('config, direction, start, status reads clusterState, stop', async () => {
  const id = 'kf-aaaa1111';
  const cfg = await flock.client.setConfig(id, { concurrency: 2, autopause: false, model: 'claude-haiku-4.5' });
  assert.equal(cfg.concurrency, 2);
  await flock.client.setDirection(id, 'do the work');
  assert.equal(await flock.client.getDirection(id), 'do the work');
  await flock.client.start(id);
  let st = await flock.client.getStatus(id);
  assert.ok(st.clusterState === 'starting' || st.clusterState === 'running');
  assert.ok(await until(async () => (await flock.client.getStatus(id)).clusterState === 'running'));
  st = await flock.client.getStatus(id);
  assert.equal(st.agents.length, 2);
  await flock.client.stop(id);
  assert.ok(await until(async () => (await flock.client.getStatus(id)).clusterState === 'stopped'));
  const counters = await flock.counters();
  assert.equal(counters.clusters[id].stopCalls, 1);
});

test('the flock rejects a node count over its cap with its own words', async () => {
  await flock.control('cap', { concurrencyCap: 4 });
  await assert.rejects(flock.client.setConfig('kf-cap', { concurrency: 40 }), (e: unknown) => {
    assert.ok(e instanceof FlockApiError);
    assert.equal(e.status, 400);
    assert.equal(e.message, 'concurrency 40 exceeds the configured cap of 4');
    return true;
  });
  await flock.control('cap', { concurrencyCap: 64 });
});

test('queue routes: put, list with inline and paging, delete, if-none-match, scoping', async () => {
  const id = 'kf-queue001';
  await flock.client.setConfig(id, { concurrency: 2 });
  for (let i = 0; i < 25; i++) {
    await flock.client.queuePut(id, `queue/in/item-${String(i).padStart(3, '0')}.json`, JSON.stringify({ id: `item-${i}` }), true);
  }
  await assert.rejects(flock.client.queuePut(id, 'queue/in/item-000.json', '{}', true), QueueExistsError);
  await flock.client.queuePut(id, 'queue/in/item-000.json', '{"overwritten":true}');
  const page1 = await flock.client.queueList(id, { prefix: 'queue/in/', limit: 10, inline: true });
  assert.equal(page1.files.length, 10);
  assert.equal(page1.files[0].content, '{"overwritten":true}');
  assert.ok(page1.next);
  const all = await flock.client.queueListAll(id, 'queue/in/');
  assert.equal(all.length, 25);
  assert.equal(new Set(all.map((f) => f.key)).size, 25);
  await assert.rejects(flock.client.queuePut(id, 'store/x', 'x'), (e: unknown) => (e as FlockApiError).status === 403);
  await assert.rejects(flock.client.queuePut(id, 'queue/../x', 'x'), (e: unknown) => (e as FlockApiError).status === 403);
  const del = await flock.client.queueDelete(id, all.slice(0, 5).map((f) => f.key));
  assert.equal(del.deleted.length, 5);
  assert.equal((await flock.client.queueListAll(id, 'queue/in/')).length, 20);
  await assert.rejects(flock.client.queueList('kf-nothere', {}), (e: unknown) => (e as FlockApiError).status === 404);
});

test('hasQueueRoutes tells an old Lambda from a new one', async () => {
  assert.equal(await flock.client.hasQueueRoutes('kf-queue001'), true);
  assert.equal(await flock.client.hasQueueRoutes('kf-unknown'), true);
  await flock.control('no-queue-routes', { on: true });
  assert.equal(await flock.client.hasQueueRoutes('kf-queue001'), false);
  await flock.control('no-queue-routes', { on: false });
});

test('agents move in/ to claimed/in/ and write out/', async () => {
  const id = 'kf-agents01';
  await flock.client.setConfig(id, { concurrency: 2, autopause: true });
  await flock.client.setDirection(id, 'echo');
  await flock.client.queuePut(id, 'queue/in/a.json', '{"id":"a"}');
  await flock.client.queuePut(id, 'queue/in/b.json', '{"id":"b"}');
  await flock.client.queuePut(id, 'queue/in/c.json', '{"id":"c"}');
  await flock.client.start(id);
  await until(async () => (await flock.client.getStatus(id)).clusterState === 'running');
  flock.tick(id);
  assert.equal((await flock.client.queueListAll(id, 'queue/in/')).length, 1);
  assert.equal((await flock.client.queueListAll(id, 'queue/claimed/in/')).length, 2);
  assert.equal((await flock.client.queueListAll(id, 'queue/out/')).length, 2);
  flock.tick(id);
  assert.equal((await flock.client.queueListAll(id, 'queue/in/')).length, 0);
  // Three idle ticks with autopause on: the cluster pauses itself.
  flock.tick(id); flock.tick(id); flock.tick(id);
  const st = await flock.client.getStatus(id);
  assert.equal(st.clusterState, 'paused');
  assert.equal(st.stateReason, 'autopause');
  await flock.client.resume(id);
  assert.equal((await flock.client.getStatus(id)).clusterState, 'running');
  const stream = await flock.client.agentStream(id, 0, 'acp');
  assert.ok(stream.content?.includes('agent-0'));
  const sessions = await flock.client.acpSessions(id, 0);
  assert.ok(sessions.sessions.length >= 1);
  await flock.client.stop(id);
});

test('offline answers 503 as FlockApiError and recovers', async () => {
  await flock.control('offline', { on: true });
  await assert.rejects(flock.client.listClusters(), (e: unknown) => (e as FlockApiError).status === 503);
  await flock.control('offline', { on: false });
  assert.ok(Array.isArray(await flock.client.listClusters()));
});
test('with the mock pool in MFA mode, the real SDK client needs the authenticator code', async () => {
  await flock.control('mfa', { on: true });
  try {
    const port = new URL(flock.base).port;
    const secrets = new SecretStore(path.join(SCRATCH, 'secrets-mfa'));
    const params = { region: 'eu-central-1', userPoolId: 'eu-central-1_MockPool', clientId: 'mockclientid', username: 'tester' };
    const auth = new CognitoAuth('fc-mfa', params, secrets, { endpoint: new URL(`http://127.0.0.1:${port}/cognito`) });
    await assert.rejects(auth.signIn({ password: 'flock' }), MfaRequired);
    await assert.rejects(auth.signIn({ password: 'flock', mfaCode: '999999' }), NotAuthorized);
    await auth.signIn({ password: 'flock', mfaCode: '123456' });
    assert.equal(auth.state().signedIn, true);
  } finally {
    await flock.control('mfa', { on: false });
  }
});
