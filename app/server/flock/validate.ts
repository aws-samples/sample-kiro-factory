/**
 * What a remote loop may and may not say.
 *
 * A remote loop runs on a Kiro Flock, where the agent has the flock's fixed tool
 * set, no checkout of the project, no skills, no steering files and no MCP
 * servers from this machine. A prompt that names any of those is a prompt that
 * promises the agent something it will not have, and the honest answer is to
 * refuse it *before* anything is sent - at save for the fields, at Start for the
 * prompt - rather than let the cluster start and fail an hour in.
 *
 * Pure. No I/O, no flock call: everything here is answerable from the document
 * and, optionally, the flock's model catalog. The same rules are mirrored in
 * `web/types.ts` (`remoteProblems`) so the panel can show them inline; the two
 * must agree or the panel allows what the server refuses.
 *
 * Two layers, by when they can be checked:
 *
 * - **structural** problems are fields that cannot exist on a remote loop. The
 *   parse already drops them, so a document that reaches `Host.replace` never
 *   has them; this check exists for a client that sends them anyway, and it is
 *   a 400 because the request was wrong, not the document.
 * - **start** problems are things that only matter when the cluster is about to
 *   run: prompt tokens that name a local resource, a model the flock does not
 *   offer, a connection that is not there. They are reported at Start as a 409
 *   with the whole list, so the operator fixes everything in one pass.
 */
import { REMOTE_RESERVED, TOKEN } from '../mcp.ts';
import { remoteMinSize, type Factory, type Loop } from '../factory.ts';

export interface Problem {
  loop: string;
  /** The field at fault, or `prompt` for a token in the operator's text. */
  field: string;
  message: string;
}

/**
 * Fields a remote loop may not carry. `parse` drops them silently; a request body
 * that still has them is a client that did not read the document back, and a 400
 * tells it so. Checked against the *raw* loop, since by the time it is parsed
 * they are gone.
 */
export function structuralProblems(rawLoop: Record<string, unknown>): Problem[] {
  const id = typeof rawLoop.id === 'string' ? rawLoop.id : '?';
  const remote = rawLoop.remote;
  if (typeof remote !== 'object' || remote === null) return [];
  const out: Problem[] = [];
  const say = (field: string, message: string) => out.push({ loop: id, field, message });
  if (Array.isArray(rawLoop.tools)) say('tools', 'remote agents use the flock\'s fixed tool set');
  if (Array.isArray(rawLoop.mcp)) say('mcp', 'remote agents cannot load MCP servers from this machine');
  if (rawLoop.worktree === true) say('worktree', 'remote agents have no checkout of the project');
  if (rawLoop.autoStop === true) say('autoStop', 'the flock has no "agent declares done" handshake');
  if (typeof rawLoop.stopAfterIterations === 'number') {
    say('stopAfterIterations', 'the flock has no single iteration count across nodes');
  }
  const cluster = rawLoop.cluster;
  if (typeof cluster === 'object' && cluster !== null) {
    const c = cluster as Record<string, unknown>;
    if (c.mode !== undefined && c.mode !== 'fixed') say('cluster.mode', 'remote clusters are always fixed');
    if (c.comms !== undefined && c.comms !== 'flock') say('cluster.comms', 'remote clusters always use flock comms');
  }
  return out;
}

export interface StartContext {
  /** Model ids the flock offers. Omit to skip the model check. */
  models?: readonly string[];
  /** Whether the loop's connection exists. Omit to skip the check. */
  connectionExists?: boolean;
  /** Whether the connection is signed in. Omit to skip the check. */
  signedIn?: boolean;
}

/**
 * Everything that must hold before a remote loop starts.
 *
 * The prompt is scanned with the same `TOKEN` the local runner uses, so the two
 * agree on what a reference is. `@input`, `@output`, `@loop` and `@environment`
 * are rewritten by the direction builder and are fine. `@browser` and `@deploy`
 * are fine too: naming a tool turns it on (`remoteTools`), so a direction never
 * promises one the node lacks. `@project` is refused:
 * there is no checkout. A parameter name is fine: it is substituted before the
 * direction is pushed - unless it shadows one of the remote words, which would
 * substitute a value where the agent expects a path. Anything else is refused,
 * because the only other things an `@` can name locally are MCP servers, skills
 * and steering files, and none of them exist remotely.
 */
export function startProblems(loop: Loop, factory: Factory, ctx: StartContext = {}): Problem[] {
  const out: Problem[] = [];
  const say = (field: string, message: string) => out.push({ loop: loop.id, field, message });
  if (loop.remote === undefined) return out;

  if (ctx.connectionExists === false) say('remote.connection', `connection ${loop.remote.connection} not found`);
  else if (ctx.signedIn === false) say('remote.connection', 'connection is signed out');

  const params = new Set((factory.parameters ?? []).map((p) => p.name.toLowerCase()));
  for (const name of params) {
    if (REMOTE_RESERVED.has(name)) say('parameters', `a parameter named ${name} shadows @${name}, which is a path on the flock for a remote loop`);
  }
  const seen = new Set<string>();
  for (const m of loop.prompt.matchAll(TOKEN)) {
    const token = m[1].toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    if (token === 'project') {
      say('prompt', '@project names a checkout the remote agent does not have; upload the project to the flock and name @environment instead');
      continue;
    }
    if (token === 'deploy' && loop.remote.trustDeploy !== true) {
      // Naming the deploy tool does not grant it (PCSR F22): deploying creates
      // resources in the flock's account, and that is the operator's tick to make.
      say('remote.trustDeploy', '@deploy names the deploy tool, which is off: tick "trust deploy" in Tools, or take @deploy out of the prompt');
      continue;
    }
    if (REMOTE_RESERVED.has(token)) continue;
    if (params.has(token)) continue;
    say('prompt', `@${m[1]} would name an MCP server, skill or steering file, none of which exist on the flock`);
  }

  if (loop.model !== undefined && ctx.models !== undefined && !ctx.models.includes(loop.model)) {
    say('model', `model ${loop.model} is not offered by this flock`);
  }

  if (loop.cluster === undefined) say('cluster', 'a remote loop is a cluster');
  else {
    const min = remoteMinSize(loop.remote.algorithm);
    if (loop.cluster.size < min) {
      say('cluster.size', min === 1 ? 'a remote cluster has at least 1 node' : 'a remote cluster has at least 2 nodes unless its algorithm is single');
    }
  }

  if (loop.prompt.trim().length === 0) say('prompt', 'the direction is empty');

  return out;
}

/** The full check: structural (on the raw loop, if given) plus start. */
export function validateRemoteLoop(
  loop: Loop,
  factory: Factory,
  ctx: StartContext = {},
  rawLoop?: Record<string, unknown>,
): Problem[] {
  return [...(rawLoop ? structuralProblems(rawLoop) : []), ...startProblems(loop, factory, ctx)];
}

/** One line per problem, for an error body or a system line. */
export function describeProblems(problems: Problem[]): string {
  return problems.map((p) => `${p.field}: ${p.message}`).join('; ');
}
