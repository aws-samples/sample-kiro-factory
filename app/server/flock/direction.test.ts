import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSlug, parse } from '../factory.ts';
import { BROWSER_WORDS, DEPLOY_WORDS, buildRemoteDirection, promptFromDirection, queuePaths, readMarker } from './direction.ts';

const defaults = { id: 'f1', name: 'F', baseDir: '/tmp/f' };

test('the direction rewrites every remote word to its S3 path, and @browser, @deploy to their MCP servers', () => {
  const f = parse({
    loops: [{
      id: 'r', prompt: 'take @input, write @output, notes in @loop, context in @environment, open pages with @browser, ship with @deploy, topic @topic',
      remote: { kind: 'flock', connection: 'fc-1', browser: true },
    }],
    parameters: [{ name: 'topic', value: 'cats' }],
  }, defaults);
  const id = 'kf-0123abcd';
  const d = buildRemoteDirection(f.loops[0], f, id, 'fc-1');
  const p = queuePaths(id);
  assert.deepEqual(readMarker(d), { factoryId: 'f1', loopId: 'r', connectionId: 'fc-1' });
  for (const path of [p.inbox, p.outbox, p.scratch, p.environment]) assert.ok(d.includes(path), path);
  assert.ok(d.includes(BROWSER_WORDS));
  assert.ok(d.includes(DEPLOY_WORDS));
  assert.ok(d.includes('topic cats'));
  assert.equal(/@(input|output|loop|environment|browser|deploy|topic)\b/.test(d.split('## Queues')[0].replace(/^<!--.*-->\n/, '')), false);
  assert.equal(p.environment, `/environment/${id}/`);
});

test('promptFromDirection reads the prompt back with its tokens, and nothing else', () => {
  const f = parse({
    loops: [{ id: 'r', prompt: 'take @input, write @output, notes in @loop, see @environment, use @browser; topic @topic', remote: { kind: 'flock', connection: 'fc-1', browser: true } }],
    parameters: [{ name: 'topic', value: 'cats' }],
  }, defaults);
  const id = 'kf-0123abcd';
  const d = buildRemoteDirection(f.loops[0], f, id, 'fc-1');
  // Values do not go back to their parameter; every reserved word does.
  assert.equal(promptFromDirection(d, id), 'take @input, write @output, notes in @loop, see @environment, use @browser; topic cats');
  // Without the marker, without the queues block, with extra lines in the block: still the prompt.
  const p = queuePaths(id);
  assert.equal(promptFromDirection(`hello ${p.inbox}\n\n## Queues (added by Kiro Factory)\n\nedited by hand\n`, id), 'hello @input');
  assert.equal(promptFromDirection(`<!-- kirofactory: factory=f1; loop=r; connection=fc-1; do not remove -->\nonly this`, id), 'only this');
  // Nothing to read.
  assert.equal(promptFromDirection('', id), null);
  assert.equal(promptFromDirection('## Queues (added by Kiro Factory)\n\nx', id), null);
  assert.equal(promptFromDirection('<!-- kirofactory: factory=f1; loop=r; connection=fc-1; do not remove -->\n\n## Queues (added by Kiro Factory)\n', id), null);
});
test('groupSlug: lowercase, hyphens for everything else, trimmed, capped, id when nothing is left', () => {
  assert.equal(groupSlug('Factory 2', 'f-x1'), 'factory-2');
  assert.equal(groupSlug('Night Shift Factory', 'f-x1'), 'night-shift-factory');
  assert.equal(groupSlug('  --GW-topdown--  ', 'f-x1'), 'gw-topdown');
  assert.equal(groupSlug('Überweisung & Co.', 'f-x1'), 'berweisung-co');
  assert.equal(groupSlug('🚀', 'f-x1'), 'f-x1');
  assert.equal(groupSlug('F', 'f-x1'), 'f-x1');
  assert.equal(groupSlug('a'.repeat(40), 'f-x1').length, 32);
  // A document keeps the group it has; one without gets the slug of its name.
  const kept = parse({ id: 'f1', name: 'Renamed Later', remoteGroup: 'original-name', loops: [], wires: [] }, defaults);
  assert.equal(kept.remoteGroup, 'original-name');
  assert.equal(parse({ id: 'f1', name: 'Factory 2', loops: [], wires: [] }, defaults).remoteGroup, 'factory-2');
  assert.equal(parse({ id: 'f1', name: 'Factory 2', remoteGroup: '../x', loops: [], wires: [] }, defaults).remoteGroup, 'factory-2');
});
