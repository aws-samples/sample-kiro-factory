import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, remoteClusterId, withoutTrustDeploy, CLUSTER_MAX, type Factory } from '../factory.ts';
import { startProblems, structuralProblems } from './validate.ts';
import { remoteTools } from './direction.ts';

const defaults = { id: 'f1', name: 'F', baseDir: '/tmp/f' };

const localDoc = {
  loops: [
    { id: 'a', name: 'A', prompt: 'hello @project', autoPause: true, tools: ['read'], x: 1, y: 2 },
    { id: 'b', name: 'B', prompt: 'x', cluster: { mode: 'scaled', size: 40, comms: 'isolated' }, worktree: true, x: 3, y: 4 },
  ],
  wires: [{ id: 'w', from: 'a', to: 'b' }],
};

test('a local-only document is unchanged by the remote rules', () => {
  const before = parse(localDoc, defaults);
  assert.equal(before.loops[0].remote, undefined);
  assert.deepEqual(before.loops[0].tools, ['read']);
  assert.equal(before.loops[1].cluster?.size, CLUSTER_MAX);
  assert.equal(before.loops[1].worktree, true);
  // Round-trips: parse(parse(x)) === parse(x).
  const again = parse(JSON.parse(JSON.stringify(before)), defaults);
  assert.deepEqual(again, before);
});

test('a remote loop is repaired to the forced shape', () => {
  const doc = {
    loops: [{
      id: 'r', name: 'R', prompt: 'work',
      remote: { kind: 'flock', connection: 'fc-1', neighbourRadius: 99, taskSize: 'large', browser: true },
      cluster: { mode: 'scaled', size: 40, comms: 'isolated' },
      tools: ['read'], mcp: ['aws-docs'], worktree: true, autoStop: true, stopAfterIterations: 5,
      intervalSeconds: 99999, x: 0, y: 0,
    }],
  };
  const f = parse(doc, defaults);
  const l = f.loops[0];
  assert.deepEqual(l.cluster, { mode: 'fixed', size: 40, comms: 'flock' });
  assert.equal(l.tools, undefined);
  assert.equal(l.mcp, undefined);
  assert.equal(l.worktree, undefined);
  assert.equal(l.autoStop, false);
  assert.equal(l.stopAfterIterations, undefined);
  assert.equal(l.intervalSeconds, 3600);
  assert.deepEqual(l.remote, { kind: 'flock', connection: 'fc-1', neighbourRadius: 20, taskSize: 'large', browser: true });
});

test('a remote loop keeps 40 nodes while a local cluster of 40 becomes 16', () => {
  const f = parse({
    loops: [
      { id: 'r', prompt: 'x', remote: { kind: 'flock', connection: 'c' }, cluster: { size: 40 } },
      { id: 'l', prompt: 'x', cluster: { size: 40 } },
    ],
  }, defaults);
  assert.equal(f.loops[0].cluster?.size, 40);
  assert.equal(f.loops[1].cluster?.size, CLUSTER_MAX);
});

test('a remote loop with no cluster gets the default size and radius 1', () => {
  const f = parse({ loops: [{ id: 'r', prompt: 'x', remote: { kind: 'flock', connection: 'c' } }] }, defaults);
  assert.deepEqual(f.loops[0].cluster, { mode: 'fixed', size: 3, comms: 'flock' });
  assert.equal(f.loops[0].remote?.neighbourRadius, 1);
});

test('remote: {} or a wrong kind is not a remote loop; an empty connection still is', () => {
  const f = parse({
    loops: [
      { id: 'a', prompt: 'x', remote: {} },
      { id: 'b', prompt: 'x', remote: { kind: 'lambda', connection: 'c' } },
      { id: 'c', prompt: 'x', remote: { kind: 'flock', connection: '' } },
    ],
  }, defaults);
  assert.equal(f.loops[0].remote, undefined);
  assert.equal(f.loops[1].remote, undefined);
  assert.equal(f.loops[2].remote?.connection, '');
  assert.equal(f.loops[2].cluster?.comms, 'flock');
});

test('remote autoPause survives, but autoStop and stopAfterIterations do not', () => {
  const f = parse({
    loops: [{ id: 'r', prompt: 'x', remote: { kind: 'flock', connection: 'c' }, autoPause: true, autoStop: true }],
  }, defaults);
  assert.equal(f.loops[0].autoPause, true);
  assert.equal(f.loops[0].autoStop, false);
});

test('remoteClusterId differs when only the connection differs and fits the flock regex', () => {
  const a = remoteClusterId('fc-1', 'f1', 'loop-1');
  const b = remoteClusterId('fc-2', 'f1', 'loop-1');
  assert.notEqual(a, b);
  assert.equal(a, remoteClusterId('fc-1', 'f1', 'loop-1'));
  assert.match(a, /^kf-[0-9a-f]{8}$/);
  assert.match(a, /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/);
});

function remoteFactory(prompt: string, extra: Partial<Factory> = {}): Factory {
  return parse({
    loops: [{ id: 'r', prompt, remote: { kind: 'flock', connection: 'c' }, model: 'm1' }],
    ...extra,
  }, defaults);
}

test('startProblems flags @project and unknown @names, allows reserved and parameters', () => {
  const f = remoteFactory('read @input, write @output, scratch @loop, @project, @aws-docs, @topic, mail me@x.com', {
    parameters: [{ name: 'topic', value: 'cats' }],
  } as Partial<Factory>);
  const problems = startProblems(f.loops[0], f);
  const fields = problems.map((p) => p.message);
  assert.equal(fields.filter((m) => m.includes('@project')).length, 1);
  assert.equal(fields.filter((m) => m.includes('@aws-docs')).length, 1);
  assert.equal(fields.filter((m) => m.includes('@topic')).length, 0);
  assert.equal(fields.filter((m) => m.includes('@input') || m.includes('@output') || m.includes('@loop')).length, 0);
  assert.equal(fields.filter((m) => m.includes('@x')).length, 0);
});

test('startProblems allows @environment and @browser always; @browser turns the browser on, @deploy does not turn deploy on', () => {
  const f = remoteFactory('read @environment, use @browser');
  assert.equal(startProblems(f.loops[0], f).length, 0);
  assert.deepEqual(remoteTools(f.loops[0]), { browser: true, trustDeploy: false });
  // PCSR F22: naming the deploy tool is a request the tick has to answer.
  const named = remoteFactory('read @environment, then @deploy it');
  assert.deepEqual(remoteTools(named.loops[0]), { browser: false, trustDeploy: false });
  const problems = startProblems(named.loops[0], named);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, 'remote.trustDeploy');
  assert.match(problems[0].message, /tick "trust deploy"/);
  const ticked = parse({
    loops: [{ id: 'r', prompt: 'read @environment, then @deploy it', remote: { kind: 'flock', connection: 'c', trustDeploy: true } }],
  }, defaults);
  assert.equal(startProblems(ticked.loops[0], ticked).length, 0);
  assert.deepEqual(remoteTools(ticked.loops[0]), { browser: false, trustDeploy: true });
});
test('withoutTrustDeploy strips the flag from every remote loop of a document from outside the app', () => {
  const input = {
    loops: [
      { id: 'a', prompt: 'x', remote: { kind: 'flock', connection: 'c', trustDeploy: true, browser: true } },
      { id: 'b', prompt: 'y', remote: { kind: 'flock', connection: 'c' } },
      { id: 'c', prompt: 'z' },
    ],
    wires: [],
  };
  const out = parse(withoutTrustDeploy(input), defaults);
  assert.equal(out.loops[0].remote?.trustDeploy, undefined);
  assert.equal(out.loops[0].remote?.browser, true);
  assert.equal(out.loops[1].remote?.trustDeploy, undefined);
  assert.equal(out.loops[2].remote, undefined);
  // The same document parsed as the app's own save keeps the tick.
  assert.equal(parse(input, defaults).loops[0].remote?.trustDeploy, true);
  assert.equal(withoutTrustDeploy('not a document'), 'not a document');
});
test('startProblems refuses a parameter that shadows a remote word', () => {
  const f = remoteFactory('work on @environment', { parameters: [{ name: 'environment', value: 'prod' }] } as Partial<Factory>);
  assert.equal(startProblems(f.loops[0], f).some((p) => p.field === 'parameters'), true);
});

test('startProblems checks the model against the catalog and the connection state', () => {
  const f = remoteFactory('work');
  assert.equal(startProblems(f.loops[0], f, { models: ['m1', 'm2'] }).length, 0);
  assert.equal(startProblems(f.loops[0], f, { models: ['m2'] }).some((p) => p.field === 'model'), true);
  assert.equal(startProblems(f.loops[0], f, { connectionExists: false }).some((p) => p.field === 'remote.connection'), true);
  assert.equal(startProblems(f.loops[0], f, { signedIn: false }).some((p) => p.message.includes('signed out')), true);
});

test('startProblems is silent for a local loop', () => {
  const f = parse({ loops: [{ id: 'a', prompt: '@project @aws-docs' }] }, defaults);
  assert.equal(startProblems(f.loops[0], f).length, 0);
});

test('structuralProblems names each forbidden field', () => {
  const raw = {
    id: 'r', remote: { kind: 'flock', connection: 'c' },
    tools: [], mcp: [], worktree: true, autoStop: true, stopAfterIterations: 3,
    cluster: { mode: 'scaled', comms: 'isolated' },
  };
  const fields = structuralProblems(raw).map((p) => p.field).sort();
  assert.deepEqual(fields, ['autoStop', 'cluster.comms', 'cluster.mode', 'mcp', 'stopAfterIterations', 'tools', 'worktree']);
  assert.equal(structuralProblems({ id: 'a', tools: [] }).length, 0);
});

test('the algorithm: amorphous is left out, swarm carries a clamped K, single allows one node, the rest need two', () => {
  const f = parse({
    loops: [
      { id: 'a', prompt: 'x', remote: { kind: 'flock', connection: 'c', algorithm: 'amorphous' }, cluster: { size: 1 } },
      { id: 's', prompt: 'x', remote: { kind: 'flock', connection: 'c', algorithm: 'swarm', swarmK: 99 }, cluster: { size: 4 } },
      { id: 'o', prompt: 'x', remote: { kind: 'flock', connection: 'c', algorithm: 'single' }, cluster: { size: 1 } },
      { id: 'm', prompt: 'x', remote: { kind: 'flock', connection: 'c', algorithm: 'mesh', swarmK: 2 }, cluster: { size: 1 } },
      { id: 'bad', prompt: 'x', remote: { kind: 'flock', connection: 'c', algorithm: 'ring' } },
    ],
  }, defaults);
  const [a, s, o, m, bad] = f.loops;
  assert.equal(a.remote?.algorithm, undefined);
  assert.equal(a.cluster?.size, 2);
  assert.equal(s.remote?.algorithm, 'swarm');
  assert.equal(s.remote?.swarmK, 3);
  assert.equal(o.remote?.algorithm, 'single');
  assert.equal(o.cluster?.size, 1);
  assert.equal(m.remote?.algorithm, 'mesh');
  assert.equal(m.remote?.swarmK, undefined);
  assert.equal(m.cluster?.size, 2);
  assert.equal(bad.remote?.algorithm, undefined);
  assert.deepEqual(startProblems(o, f), []);
  // A single that became a mesh by hand edit, still at one node, is refused at Start.
  const hand = { ...o, remote: { ...o.remote!, algorithm: 'mesh' as const } };
  assert.ok(startProblems(hand, f).some((p) => p.field === 'cluster.size'));
});
