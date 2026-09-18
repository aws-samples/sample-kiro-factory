/**
 * Where each session's checkout ended up: the sidecar behind `Loop.worktree`.
 *
 * The document says the intent - one boolean on the loop - and this file says
 * what the machine did about it. The split is deliberate and mirrors what the
 * remote-loops design does with `remote?` and its stack details: a document is
 * exported and imported, and absolute paths into one machine's filesystem are
 * the one thing that must not travel with it. The paths are also per *member*
 * while the setting is per loop, so putting them on `Loop` would mean an array
 * whose indices had to be kept in step with `cluster.size` by hand.
 *
 * This is the first stored location in the program that is not `baseDir`, and
 * it is stored because it cannot be re-derived: `freeDir` and `freeBranch`
 * append `-2` on collision, so a session's checkout path is not a pure function
 * of its key. That is what retired the old rule on the `/worktree` route -
 * "there is nothing to keep in step" - for loops, though it still holds for the
 * factory itself.
 *
 * The file lives at `<baseDir>/.kirofactory/worktrees.json`, keyed by runner
 * key (`loop-abc`, or `loop-abc#3` for a cluster member). A moved factory
 * leaves it behind with the rest of `.kirofactory`, which is correct: those
 * checkouts were branched from the repository the factory just left.
 *
 * Provisioning is sequential, never parallel - `git worktree add` takes the
 * repository's index lock, so sixteen at once is fifteen failures - and the
 * sidecar is written after each success rather than once at the end, so an
 * interrupted provision does not orphan checkouts it has forgotten about. A
 * failure partway stops the sequence: the caller does not start the component,
 * the checkouts already made stay recorded, and the next start resumes by
 * reusing them, which is what the reuse check below already does.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { INTERNAL, memberKeys, splitMemberId, type Factory, type Loop } from './factory.ts';
import { addWorktree, inspect, removeWorktree, slug, type GitState } from './git.ts';

/** One session's checkout: where it is, and the branch it is on. */
export interface SessionCheckout {
  /**
   * The session's working directory. Inside the worktree, not necessarily its
   * root: a factory scoped to a subdirectory of its repository has loops scoped
   * to the same subdirectory of their checkouts - `addWorktree` carries the
   * subpath across.
   */
  dir: string;
  branch: string;
}

/** Every session's checkout, keyed by runner key. */
export type Sessions = Record<string, SessionCheckout>;

/** Format version, so a later shape change can tell old files from new. */
const FORMAT = 1;

const FILE = 'worktrees.json';

function fileFor(baseDir: string): string {
  return path.join(baseDir, INTERNAL, FILE);
}

/**
 * The sidecar's contents, or nothing at all.
 *
 * Tolerant the way `parse` is tolerant: a missing file is no checkouts, and a
 * malformed one is too - the truth about a checkout is whether it is on disk,
 * which the reuse check asks per entry, so a broken sidecar heals itself on the
 * next provision rather than wedging the feature.
 */
export async function readSessions(baseDir: string): Promise<Sessions> {
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(fileFor(baseDir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const sessions = (raw as { sessions?: unknown }).sessions;
    if (typeof sessions !== 'object' || sessions === null) return {};
    const out: Sessions = {};
    for (const [key, value] of Object.entries(sessions)) {
      if (typeof value !== 'object' || value === null) continue;
      const { dir, branch } = value as { dir?: unknown; branch?: unknown };
      if (typeof dir === 'string' && typeof branch === 'string') out[key] = { dir, branch };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Exported for one caller beyond this module: the factory-level branch-off,
 * which carries the sidecar into the factory's new home. That is safe for
 * exactly that move and no other - a branch-off stays inside the same
 * repository, so every recorded checkout is still a worktree of the factory's
 * main repository and the reuse check keeps holding. An arbitrary `setBaseDir`
 * must not do this: those checkouts belong to the repository being left.
 */
export async function writeSessions(baseDir: string, sessions: Sessions): Promise<void> {
  const file = fileFor(baseDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({ kirofactory: FORMAT, sessions }, null, 2)}\n`, 'utf8');
}

/**
 * What a session's checkout is called, in its directory and its branch.
 *
 * Defined once, here, because it lands in names that are expensive to regret. A
 * plain loop's checkout is the bare loop slug; member `k` of a cluster is
 * `<slug>-n<k+1>`. One-based because the suffix is for humans counting members
 * - it matches `nodeLabel`, the tab in the panel and the folder on disk - and
 * uniform: member zero is `-n1`, not the bare name, because a cluster's members
 * are peers and none of them is the loop.
 */
export function checkoutName(loop: Loop, key: string): string {
  const base = slug(loop.name, 'loop');
  const { member } = splitMemberId(key);
  return member === undefined ? base : `${base}-n${member + 1}`;
}

/** The main checkout everything here must belong to, from the factory's state. */
function mainOf(state: GitState): string | undefined {
  return state.kind === 'worktree' ? state.mainRoot : state.root;
}

/**
 * Whether a recorded checkout is still usable: on disk, still a linked
 * worktree, and still a worktree of *this* repository - a sidecar copied
 * between machines, or a directory deleted and recreated as something else,
 * must read as "make a new one" rather than as a place to run an agent.
 */
async function stillOurs(entry: SessionCheckout, factoryState: GitState): Promise<boolean> {
  if (!existsSync(entry.dir)) return false;
  const state = await inspect(entry.dir);
  return state.kind === 'worktree' && state.mainRoot === mainOf(factoryState);
}

/**
 * Make sure every session of a component has a checkout, creating the missing
 * ones. Returns the sessions map as it now stands.
 *
 * Called from `Host.startLoop`, before any runner is created - not on toggling
 * the checkbox, because checking a box should not spend a minute checking out a
 * repository, and not lazily at turn time, because a failure there is a failure
 * inside a turn that has already been counted.
 *
 * Eager across `memberKeys` rather than lazy per member spawn: a scaled
 * cluster's supervisor adds members on a two second poll, and `git worktree
 * add` on a real repository takes longer than that - a member that had to
 * check the project out before its first turn would arrive after the item that
 * summoned it was gone. The cost of that eagerness is stated in the panel's
 * confirm copy, not hidden here.
 *
 * `note` is progress, per key, routed to the loop's output stream by the
 * caller: a first start of a large cluster is slow and should say so as it
 * goes.
 */
export async function provision(
  factory: Factory,
  loop: Loop,
  note: (key: string, text: string) => void,
): Promise<Sessions> {
  const state = await inspect(factory.baseDir);
  // The same two guards addWorktree has, with the same messages - asked here so
  // a cluster refuses once, up front, rather than per member.
  if (state.kind === 'none') throw new Error(state.reason ?? 'not a git repository');
  if (state.unborn === true) {
    throw new Error(
      'this repository has no commits yet, and a worktree needs something to branch from. Make one commit first.',
    );
  }

  /*
   * One container for all of a factory's loop checkouts, beside the factory's
   * own checkout: `<parent>/<repo>-loops/<name>`. Beside rather than inside for
   * the reason `addWorktree` already states - a checkout nested under another
   * is untracked clutter something else's agent can wander into - and one
   * container rather than siblings so sixteen checkouts are one entry in a
   * directory that also holds unrelated projects. Derived from the factory's
   * own root, not the main checkout's: a factory that lives in a worktree gets
   * its loop checkouts beside that worktree, branched off its branch.
   */
  const root = state.root!;
  const container = path.join(path.dirname(root), `${path.basename(root)}-loops`);

  const sessions = await readSessions(factory.baseDir);
  for (const key of memberKeys(loop)) {
    const existing = sessions[key];
    if (existing !== undefined && (await stillOurs(existing, state))) {
      note(key, `reusing its checkout at ${existing.dir} on ${existing.branch}`);
      continue;
    }
    const name = checkoutName(loop, key);
    note(key, `checking the project out for this session - git worktree add can take a while`);
    const added = await addWorktree(factory.baseDir, name, {
      container,
      branchLabel: `${slug(factory.name, 'factory')}-${name}`,
    });
    sessions[key] = { dir: added.dir, branch: added.branch };
    await writeSessions(factory.baseDir, sessions);
    note(key, `checkout ready at ${added.dir} on ${added.branch}`);
  }
  return sessions;
}

/** What a release did: which keys went, which refused, and what remains. */
export interface Released {
  removed: string[];
  failures: { key: string; error: string }[];
  sessions: Sessions;
}

/**
 * Remove a component's checkouts and forget them.
 *
 * Per component, never per member: releasing eleven of sixteen leaves a cluster
 * the next start silently repairs by provisioning the missing five, and a
 * control whose effect is undone by pressing Start is not a control.
 *
 * Each removal goes through `removeWorktree`, which never forces - a checkout
 * with uncommitted changes is refused by git, reported as it comes back, and
 * the operator commits or discards. Branches are never deleted: they may hold
 * the only copy of a turn's work. Sidecar entries are dropped only for the
 * checkouts that actually went, so a partial release leaves the rest
 * addressable. An entry whose directory has already vanished from outside the
 * app is simply forgotten; tidying git's own stale registration is `git
 * worktree prune`, which is one command and not this program's job.
 */
export async function release(baseDir: string, keys: string[]): Promise<Released> {
  const sessions = await readSessions(baseDir);
  const removed: string[] = [];
  const failures: { key: string; error: string }[] = [];

  for (const key of keys) {
    const entry = sessions[key];
    if (entry === undefined) continue;
    if (!existsSync(entry.dir)) {
      delete sessions[key];
      removed.push(key);
      continue;
    }
    try {
      await removeWorktree(entry.dir);
      delete sessions[key];
      removed.push(key);
    } catch (err) {
      failures.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await writeSessions(baseDir, sessions);
  return { removed, failures, sessions };
}
