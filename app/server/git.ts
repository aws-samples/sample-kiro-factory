/**
 * What git knows about a factory's directory.
 *
 * The one place in this program that shells out to `git`, and it only ever asks
 * questions - with a single exception, `addWorktree`, which is the one thing an
 * operator can press that changes a repository. Everything else here reads.
 *
 * Why it exists at all: a factory's base directory is the agents' working
 * directory, they hold a shell, and until now the app had nothing
 * to say about whether that directory was under version control. That is the one
 * fact that decides whether a run is recoverable, so it is worth knowing before
 * pressing start rather than after. Three states matter and the rest of the app
 * keys off them - see `GitState`.
 *
 * Every call goes through `spawn` with an argument array and no shell. Paths reach
 * git as arguments, never as text to be re-parsed, so a directory with a space or a
 * semicolon in it is a directory rather than a second command. Pathspecs are
 * introduced with `--` for the same reason: a file called `-i` is a file.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** The git binary. Overridable for the same reason `KIRO_CLI` is. */
const GIT = process.env.GIT ?? 'git';

/**
 * A git call that has not answered by this long is not going to.
 *
 * `git status` on a very large repository is the slow one and it is the call the
 * changes panel makes on a timer, so this is generous rather than tight: a status
 * that takes six seconds should return, not be killed and reported as a failure.
 * The timeout is here to stop a wedged git holding a request open forever, which is
 * a different problem from a slow one.
 */
const TIMEOUT_MS = 15_000;

/** Beyond this, a blob is reported but its text is not read. Matches FILE_MAX. */
const BLOB_MAX = 2 * 1024 * 1024;

/** Branches to try as the trunk when the remote does not say. In order. */
const TRUNK_GUESSES = ['main', 'master', 'trunk'];

interface Ran {
  ok: boolean;
  /** stdout, trailing newline trimmed. Empty when the call failed. */
  out: string;
  /** stderr, for the message when something is worth reporting. */
  err: string;
  /** The git binary could not be run at all, which is not the same as a failure. */
  missing: boolean;
}

/**
 * Run git and collect its output.
 *
 * Never rejects. A git call failing is the normal way to ask a yes/no question -
 * `rev-parse --verify` is how you find out whether a ref exists - so a non-zero
 * exit is an answer rather than an exception, and the caller reads `ok`.
 */
async function runRaw(cwd: string, args: string[]): Promise<Ran & { bytes: Buffer }> {
  const empty = { out: '', err: '', bytes: Buffer.alloc(0) };
  // Spawning into a directory that is not there throws asynchronously in a way
  // that is awkward to attribute, so it is checked first and reported as itself.
  if (!existsSync(cwd)) return { ok: false, missing: false, ...empty, err: `${cwd} is not there` };

  return new Promise((resolve) => {
    const child = spawn(GIT, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      /*
       * Two variables, for two different kinds of hanging.
       *
       * A git that decides it needs a password will otherwise sit on a terminal
       * that does not exist for as long as the timeout allows, and a git that
       * decides its output is worth paging will hand it to `less` and never
       * finish. Neither is reachable from a web request, so both are refused.
       */
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    });

    const out: Buffer[] = [];
    let err = '';
    let settled = false;

    /*
     * Only git itself is killed, not a process group. The commands this file runs
     * are all local reads plus `worktree add`, so the only helper git can spawn is
     * a repository hook, and a hook that backgrounds something with stdio still
     * attached would hold the pipe open after git is gone. `close` waits for the
     * pipe, not for git, so on its own the kill would not end the wait. The second
     * timer does: once git has been killed, whatever is still holding the pipe is
     * not going to give us an answer, and the caller gets the timeout it was
     * promised rather than a promise that never settles.
     */
    let settleTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settleTimer = setTimeout(() => {
        done({ ok: false, missing: false, ...empty, err: `git ${args[0] ?? ''} did not finish in time` });
      }, 2000);
    }, TIMEOUT_MS);

    const done = (result: Ran & { bytes: Buffer }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Capped: a git that fails once per file in a large tree can produce more
      // stderr than the message it is being read for is worth.
      if (err.length < 4096) err += chunk;
    });

    child.on('error', (e: NodeJS.ErrnoException) =>
      done({
        ok: false,
        missing: e.code === 'ENOENT',
        ...empty,
        err: e.code === 'ENOENT' ? 'git is not on the PATH' : e.message,
      }),
    );

    child.on('close', (code) => {
      const bytes = Buffer.concat(out);
      done({
        ok: code === 0,
        missing: false,
        out: bytes.toString('utf8').replace(/\n$/, ''),
        err: err.trim(),
        bytes,
      });
    });
  });
}

async function run(cwd: string, args: string[]): Promise<Ran> {
  const { bytes: _bytes, ...rest } = await runRaw(cwd, args);
  return rest;
}

/* ------------------------------------------------------------------ the state */

/**
 * Which of three things a directory is, and what git calls the work in it.
 *
 * The three are the whole point, and they are what the directory bar shows:
 *
 *   `none`      - not a repository. Nothing the loops do here is recoverable, and
 *                 there is no diff to show, because there is nothing to diff
 *                 against. Also what a bare repository and a missing git report,
 *                 since neither gives the loops a working tree to build in.
 *   `repo`      - an ordinary checkout. The loops are working in the same directory
 *                 and on the same branch as whoever else is using it, which is the
 *                 default and is fine as long as you know it.
 *   `worktree`  - a linked worktree. The loops have a checkout and a branch of
 *                 their own, sharing the object store with the main one, which is
 *                 what `addWorktree` sets up.
 *
 * Fields beyond `kind` are spread conditionally rather than set to undefined, so a
 * `none` state serialises as two keys instead of nine mostly-null ones.
 */
export interface GitState {
  kind: 'none' | 'repo' | 'worktree';
  /** Why there is no repository here. Only on `none`. */
  reason?: string;
  /** The working tree's root, which is at or above the directory asked about. */
  root?: string;
  /** Where the directory asked about sits below `root`, `/`-separated. '' when equal. */
  subpath?: string;
  /** The branch checked out, or the branch a first commit would create. */
  branch?: string;
  /** On no branch at all, so commits would go nowhere a name can find them. */
  detached?: boolean;
  /** Nothing committed yet, so there is no HEAD to diff or branch from. */
  unborn?: boolean;
  /** The main checkout this worktree is linked to. Only on `worktree`. */
  mainRoot?: string;
  /**
   * The directory itself is gitignored, so git reports nothing written in it.
   * Only possible when `subpath` is non-empty - a repository root cannot ignore
   * itself - and worth surfacing because a factory based here has a changes view
   * that is empty by construction, which reads as a bug until something says why.
   */
  ignored?: boolean;
}

/**
 * Ask git what this directory is.
 *
 * Three calls, because the questions genuinely differ in how they fail. The first
 * establishes whether there is a repository with a working tree and where its
 * plumbing lives; the second and third are the yes/no pair that tell a detached
 * HEAD from an unborn one, both of which are ordinary states that would make a
 * single combined `rev-parse` exit non-zero and lose the rest of its output.
 *
 * The worktree test is the comparison of the two git directories. In an ordinary
 * checkout both are `<root>/.git`. In a linked worktree the private one is
 * `<main>/.git/worktrees/<name>` while the common one is still `<main>/.git`, and
 * that difference is the only reliable signal - the `.git` entry being a file
 * rather than a directory is a consequence rather than the definition, and
 * submodules share it.
 */
export async function inspect(dir: string): Promise<GitState> {
  /*
   * Canonicalised first, and everything below is measured against this rather than
   * against what we were handed.
   *
   * Not a nicety. Git resolves symlinks in every path it prints, so on a machine
   * where any component of the directory is a link - `/var` is one on macOS, and
   * `/tmp` through it - `--show-toplevel` comes back under the real path while the
   * directory we asked about is still under the link. Comparing the two then goes
   * wrong twice over: `path.relative` between them produces a subpath full of `..`
   * that matches nothing, so every changed file is filtered out of the list, and the
   * two git directories fail to compare equal, so an ordinary checkout reports itself
   * as a worktree. One `realpath` puts both sides in the same terms.
   *
   * Falling back to `resolve` rather than failing: a directory that cannot be
   * canonicalised is one that is not there, and the git call below will say so more
   * usefully than this would.
   */
  const real = await fsp.realpath(dir).catch(() => path.resolve(dir));

  const where = await run(real, [
    'rev-parse',
    '--show-toplevel',
    '--absolute-git-dir',
    '--git-common-dir',
  ]);

  if (!where.ok) {
    if (where.missing) {
      return { kind: 'none', reason: 'git is not on the PATH, so nothing here is version controlled' };
    }
    return { kind: 'none', reason: 'not a git repository' };
  }

  const [topline, gitDirLine, commonLine] = where.out.split('\n');
  const root = (topline ?? '').trim();
  // A bare repository answers the other two and has nothing for the first. The
  // loops need somewhere to write, so it is not a state this app can work in.
  if (root.length === 0) return { kind: 'none', reason: 'a bare repository has no working tree' };

  const gitDir = path.resolve(real, (gitDirLine ?? '').trim());
  // `--git-common-dir` can come back relative to the directory git was run in,
  // where `--absolute-git-dir` never does, so only this one needs resolving -
  // against the canonical path, so the comparison below is between like and like.
  const commonDir = path.resolve(real, (commonLine ?? '').trim());
  const linked = gitDir !== commonDir;

  const named = await run(real, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const head = await run(real, ['rev-parse', '--verify', '-q', 'HEAD']);

  const rel = path.relative(root, real);

  // Only asked below the root, because a root cannot ignore itself. Exit 0 means
  // ignored - `check-ignore` is one of the yes/no questions, not a failure.
  const ignored = rel !== '' && (await run(real, ['check-ignore', '-q', '--', '.'])).ok;

  return {
    kind: linked ? 'worktree' : 'repo',
    root,
    // '' when the factory is pointed at the root itself, which is the usual case.
    // Anything else means the factory is scoped to a subdirectory of the repo, and
    // everything below reports and resolves relative to that.
    subpath: rel === '' ? '' : rel.split(path.sep).join('/'),
    ...(named.ok ? { branch: named.out.trim() } : { detached: true }),
    ...(head.ok ? {} : { unborn: true }),
    ...(linked ? { mainRoot: worktreeMain(commonDir) } : {}),
    ...(ignored ? { ignored: true } : {}),
  };
}

/**
 * The main checkout a linked worktree belongs to, from its common git directory.
 *
 * `<main>/.git` is the ordinary case and the parent is the answer. A repository
 * created with `--separate-git-dir`, or a bare one with worktrees hanging off it,
 * has a common directory that is not called `.git`, and there the parent is not a
 * checkout - so the git directory itself is the most honest thing to name.
 */
function worktreeMain(commonDir: string): string {
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
}

/* ---------------------------------------------------------------- what changed */

/** Which comparison the changes view is showing. */
export type DiffRange = 'uncommitted' | 'branch';

/** One changed path, in the shape the file panel's tree already understands. */
export interface ChangeEntry {
  /** Relative to the directory asked about, `/`-separated. */
  path: string;
  size: number;
  /** Last write, ISO. Empty for a file that is no longer on disk. */
  mtime: string;
  /**
   * What happened to it, as one letter: `M`odified, `A`dded, `D`eleted,
   * `R`enamed, `C`opied, `U`nmerged, or `?` for untracked.
   *
   * Git's own two-column status is collapsed to one, because the panel is showing
   * what the loops did to the project rather than what is staged. The distinction
   * between a staged modification and an unstaged one belongs to whoever is going
   * to commit it, and it is not a distinction this view is asking about.
   */
  status: string;
  /** Where it came from, for a rename or a copy. */
  from?: string;
}

export interface Changes {
  range: DiffRange;
  /** The revision the working tree is compared against, resolved. */
  against?: string;
  /** What `against` was worked out from: `HEAD`, or the trunk a branch left. */
  base?: string;
  entries: ChangeEntry[];
  /** Why the list is empty, when it is empty for a reason worth saying. */
  note?: string;
}

/**
 * Everything that differs between a revision and what is on disk right now.
 *
 * Deliberately against the *working tree* rather than between two commits. The
 * loops write files and may or may not commit them, so a view that only showed
 * committed work would be blank for the common case and a view that only showed
 * uncommitted work would miss everything a loop had tidied up after itself. One
 * `diff` against a revision covers both: staged, unstaged and committed-since all
 * appear, which is what "what has this factory done" means.
 *
 * Untracked files are added separately because `diff` does not report them and a
 * brand new file is the single most likely thing a loop has produced.
 *
 * Everything is scoped to `dir` with a `.` pathspec and reported relative to it,
 * so a factory pointed at a subdirectory of a repository sees its own subtree and
 * nothing above it. That keeps the boundary exactly where the project file browser
 * already puts it.
 */
export async function changes(dir: string, range: DiffRange): Promise<Changes> {
  const state = await inspect(dir);
  if (state.kind === 'none') return { range, entries: [], note: state.reason };

  const strip = stripper(state.subpath ?? '');
  const untracked = await untrackedIn(dir, strip);

  /*
   * A directory git has been told to ignore reports no changes by construction:
   * `status` skips ignored files and nothing in it was ever tracked. The empty list
   * is git's honest answer, but without this note it reads as the view being broken
   * rather than the directory being invisible.
   */
  const ignoredNote =
    state.ignored === true
      ? { note: 'this directory is gitignored, so git sees nothing the loops write in it' }
      : {};

  /*
   * Nothing committed yet, so there is no revision to compare against and every
   * file in the directory is new. Reported as the untracked list rather than as an
   * error, because that is the true and useful answer for a fresh `git init`.
   */
  if (state.unborn === true) {
    return {
      range,
      entries: await withStats(dir, untracked.map(asUntracked)),
      note: 'nothing committed yet, so everything here is new',
      ...ignoredNote,
    };
  }

  const resolved = range === 'branch' ? await branchPoint(dir) : { against: 'HEAD', base: 'HEAD' };
  if (resolved === null) {
    return {
      range,
      entries: [],
      note: 'no trunk to compare against. Set an upstream, or use a branch named main or master.',
    };
  }

  const diff = await run(dir, ['diff', '--name-status', '-z', '--no-renames', resolved.against, '--', '.']);
  if (!diff.ok) {
    return { range, ...resolved, entries: [], note: diff.err.length > 0 ? diff.err : 'git diff failed' };
  }

  const tracked = parseNameStatus(diff.out, strip);
  /*
   * Untracked last and only when the path is not already listed.
   *
   * A path can legitimately appear in both: `git diff` against the branch point
   * reports a file that was committed and then deleted, while status reports a new
   * file created at the same path. The diff's answer is the more specific one, so
   * it wins and the untracked entry is dropped rather than producing two rows for
   * one file.
   */
  const seen = new Set(tracked.map((e) => e.path));
  const entries = [...tracked, ...untracked.filter((p) => !seen.has(p)).map(asUntracked)];

  return {
    range,
    ...resolved,
    entries: await withStats(dir, entries),
    ...(entries.length === 0 && resolved.base !== 'HEAD' && resolved.against === (await headSha(dir))
      ? { note: `this is ${resolved.base}, so there is no branch point to compare against` }
      : {}),
    // Last, because being invisible to git explains an empty list better than any
    // statement about branch points does.
    ...ignoredNote,
  };
}

/** Both halves of one file: the revision's version, and what is on disk now. */
export interface FileDiff {
  path: string;
  status: string;
  before: string;
  after: string;
  /** Why one or both texts are empty when the file is not simply new or gone. */
  note?: string;
  /** Neither side is text, so there is nothing to show line by line. */
  binary?: boolean;
}

/**
 * One file, before and after.
 *
 * Two whole texts rather than a patch, and that is the decision the diff view rests
 * on: a unified patch is a set of fragments, and laying fragments out as an
 * IDE-style view means reconstructing the two sides from interleaved runs of `+`
 * and `-` lines. Whole texts make the line diff a pure function over two arrays,
 * which is what `diff.ts` in the browser is, and they make the unchanged context
 * around a hunk available without asking for it.
 *
 * The cost is bandwidth on a large file with a small change, which is bounded by
 * `BLOB_MAX` and is a fair price for a panel you open on one file at a time.
 *
 * `rel` must already have been checked to be inside `dir` by the caller. This
 * function passes it to git, and `:./` is the syntax that keeps it a path relative
 * to the directory git is running in rather than something git might read as a
 * revision or a flag.
 */
export async function fileDiff(
  dir: string,
  rel: string,
  range: DiffRange,
): Promise<FileDiff> {
  const state = await inspect(dir);
  if (state.kind === 'none') {
    return { path: rel, status: '?', before: '', after: '', note: state.reason };
  }

  const resolved =
    state.unborn === true
      ? null
      : range === 'branch'
        ? await branchPoint(dir)
        : { against: 'HEAD', base: 'HEAD' };

  // An unborn HEAD, or a trunk that cannot be found: there is no before, and the
  // whole file reads as an addition, which is what it is.
  const shown = await runRaw(dir, resolved === null ? ['--version'] : ['show', `${resolved.against}:./${rel}`]);
  const before = resolved === null || !shown.ok ? Buffer.alloc(0) : shown.bytes;

  const full = path.resolve(dir, rel);
  const after = existsSync(full) ? await fsp.readFile(full).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);

  if (looksBinary(before) || looksBinary(after)) {
    return {
      path: rel,
      status: statusOf(before, after),
      before: '',
      after: '',
      binary: true,
      note: 'a binary file, so there is nothing to show line by line',
    };
  }

  if (before.length > BLOB_MAX || after.length > BLOB_MAX) {
    const mb = (Math.max(before.length, after.length) / (1024 * 1024)).toFixed(1);
    return {
      path: rel,
      status: statusOf(before, after),
      before: '',
      after: '',
      note: `${mb}MB is too large to diff here.`,
    };
  }

  return {
    path: rel,
    status: statusOf(before, after),
    before: before.toString('utf8'),
    after: after.toString('utf8'),
  };
}

/* ------------------------------------------------------------------- worktrees */

export interface AddedWorktree {
  /** Where the new checkout is. The directory a factory would then run in. */
  dir: string;
  branch: string;
}

/**
 * Give a factory a checkout and a branch of its own.
 *
 * The only thing in this module that writes, and the one operation an operator can
 * press that changes a repository. What it does is deliberately small: one branch
 * off whatever is currently checked out, one worktree on it, beside the repository
 * rather than inside it.
 *
 * Beside, because a worktree nested under the main checkout is untracked clutter in
 * that checkout and is somewhere the *other* factory's agents can wander into -
 * the same reasoning that puts AUTO_BASE next to the default workspace rather than
 * under it.
 *
 * Two callers now, with two layouts. The factory-level branch-off passes nothing
 * beyond the label and gets the original shape: `<parent>/<repo>-<slug>` on
 * `kirofactory/<slug>`. Per-session checkouts pass a `container` - one folder
 * holding all of a factory's loop checkouts, so sixteen of them are one entry
 * beside the repository rather than sixteen near-identical siblings - and a
 * `branchLabel`, because their branch names carry the factory's slug as well as
 * their own and this function has no business knowing that composition.
 *
 * The counterpart, `removeWorktree`, exists now that a checkout can hold nothing
 * but project files - see it for why it never forces. The factory-level checkout
 * still has no removal path: deleting one deletes the queues inside it.
 */
export async function addWorktree(
  dir: string,
  label: string,
  opts?: {
    /** Directory the checkout goes inside. Default: beside the repository. */
    container?: string;
    /** What follows `kirofactory/` in the branch name. Default: the label's slug. */
    branchLabel?: string;
  },
): Promise<AddedWorktree> {
  const state = await inspect(dir);
  if (state.kind === 'none') throw new Error(state.reason ?? 'not a git repository');
  if (state.unborn === true) {
    throw new Error(
      'this repository has no commits yet, and a worktree needs something to branch from. Make one commit first.',
    );
  }
  const root = state.root!;

  const branch = await freeBranch(root, `kirofactory/${opts?.branchLabel ?? slug(label)}`);
  const target = freeDir(
    opts?.container !== undefined
      ? path.join(opts.container, slug(label, 'loop'))
      : path.join(path.dirname(root), `${path.basename(root)}-${slug(label)}`),
  );

  const added = await run(root, ['worktree', 'add', '-b', branch, target]);
  if (!added.ok) throw new Error(added.err.length > 0 ? added.err : 'git worktree add failed');

  /*
   * The factory follows its subdirectory across.
   *
   * A worktree is a checkout of the whole repository, so a factory scoped to
   * `repo/packages/app` belongs at `<worktree>/packages/app` and not at the
   * worktree's root. Created if the path is not in the branch yet, so pointing a
   * factory at a directory that only exists in its own working tree still works.
   */
  const inside = state.subpath !== undefined && state.subpath.length > 0
    ? path.join(target, state.subpath)
    : target;
  await fsp.mkdir(inside, { recursive: true });

  return { dir: inside, branch };
}

/**
 * Remove a linked worktree, keeping its branch.
 *
 * The second thing in this module that writes, and it exists because a
 * per-session checkout holds project files and nothing else - the machinery
 * stayed in the factory's own directory - so removing one destroys no queued
 * work and no loop's notes. That is what flipped the old "no counterpart"
 * argument on `addWorktree`.
 *
 * Never `--force`, ever. Git refuses to remove a checkout holding modified *or
 * untracked* files - ignored ones do not count - and that refusal is the safety
 * property this function is built on: the error is thrown as it comes back, and
 * the operator commits or discards. The "or untracked" mattered once: the agent
 * files this program writes into a checkout came with an untracked `.gitignore`,
 * so every checkout refused after its first turn. See `ignoreGeneratedAgents`.
 * The branch is never deleted either - it may hold the only copy of a turn's
 * work, and this is the operation that cannot ask.
 *
 * `dir` may be anywhere inside the checkout (a factory scoped to a subdirectory
 * stores the subpath, not the worktree root), so the root is resolved first.
 * The removal is run from the main checkout rather than from inside the one
 * being removed, because deleting the directory a subprocess is standing in is
 * a race this does not need to have.
 */
export async function removeWorktree(dir: string): Promise<void> {
  const state = await inspect(dir);
  if (state.kind === 'none') throw new Error(state.reason ?? 'not a git repository');
  if (state.kind !== 'worktree') {
    throw new Error(`${dir} is not a linked worktree, so there is nothing to remove`);
  }
  const removed = await run(state.mainRoot!, ['worktree', 'remove', '--', state.root!]);
  if (!removed.ok) {
    throw new Error(removed.err.length > 0 ? removed.err : 'git worktree remove failed');
  }
}

/** A branch name nothing is using yet, from a preferred one. */
async function freeBranch(root: string, preferred: string): Promise<string> {
  for (let n = 0; n < 100; n += 1) {
    const name = n === 0 ? preferred : `${preferred}-${n + 1}`;
    const exists = await run(root, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]);
    if (!exists.ok) return name;
  }
  throw new Error(`a hundred branches are already called ${preferred}, which is enough`);
}

/** A directory path nothing is at yet, from a preferred one. */
function freeDir(preferred: string): string {
  for (let n = 0; n < 100; n += 1) {
    const dir = n === 0 ? preferred : `${preferred}-${n + 1}`;
    if (!existsSync(dir)) return dir;
  }
  throw new Error(`a hundred directories are already called ${preferred}, which is enough`);
}

/**
 * A name safe to put in a branch and a directory.
 *
 * The fallback is caller-supplied because it names what the thing *is* when its
 * name slugs away to nothing: a factory with an unsluggable name should become
 * `factory`, and a loop should become `loop` rather than claiming to be one.
 * Exported for worktrees.ts, which composes branch labels out of two of these.
 */
export function slug(text: string, fallback = 'factory'): string {
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out.length > 0 ? out : fallback;
}

/* --------------------------------------------------------------------- helpers */

/** HEAD's commit, or '' when there is not one. */
async function headSha(dir: string): Promise<string> {
  const head = await run(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  return head.ok ? head.out.trim() : '';
}

/**
 * Where this branch left the trunk, and what the trunk turned out to be.
 *
 * Tried in the order that respects what the repository has actually been told: the
 * remote's own default branch first, since that is a fact rather than a guess, then
 * the conventional names. Whatever answers, the comparison point is the merge base
 * rather than the trunk's tip, so a trunk that has moved on since does not show up
 * as work this factory did.
 */
async function branchPoint(dir: string): Promise<{ against: string; base: string } | null> {
  const candidates: string[] = [];

  const remote = await run(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.out.trim().length > 0) candidates.push(remote.out.trim());
  for (const name of TRUNK_GUESSES) {
    candidates.push(name, `origin/${name}`);
  }

  for (const base of candidates) {
    const verified = await run(dir, ['rev-parse', '--verify', '-q', `${base}^{commit}`]);
    if (!verified.ok) continue;
    const merged = await run(dir, ['merge-base', 'HEAD', base]);
    if (merged.ok && merged.out.trim().length > 0) return { against: merged.out.trim(), base };
  }
  return null;
}

/** Untracked paths at or below `dir`, relative to it. */
async function untrackedIn(dir: string, strip: (p: string) => string | null): Promise<string[]> {
  const listed = await run(dir, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    // The internals folder is this program's own state, not the project's work, and
    // a factory that has run leaves hundreds of files in it. Excluded here rather
    // than filtered afterwards so a busy queue cannot crowd out the real changes.
    '--',
    '.',
    ':(exclude).kirofactory',
  ]);
  if (!listed.ok) return [];

  const out: string[] = [];
  for (const record of listed.out.split('\0')) {
    // `XY path`, so two columns, a space, then the rest. Only the untracked ones
    // are wanted here: everything tracked is the diff's business, and taking it
    // from status as well would report staged and unstaged copies of one change.
    if (!record.startsWith('??')) continue;
    const rel = strip(record.slice(3));
    if (rel !== null) out.push(rel);
  }
  return out;
}

/**
 * Parse `diff --name-status -z`.
 *
 * NUL-separated fields rather than lines, and a status is its own field: `M`, then
 * the path. A rename is three fields - `R100`, the old path, the new one - which is
 * why this is a cursor over a flat list rather than a map over pairs. `--no-renames`
 * is passed at the call site so the third case does not arise in practice, but it is
 * handled: rename detection is a default that a repository's config can turn back
 * on, and a parser that silently took the old path as the next entry's status would
 * shift everything after it by one.
 */
function parseNameStatus(text: string, strip: (p: string) => string | null): ChangeEntry[] {
  const fields = text.split('\0').filter((f) => f.length > 0);
  const out: ChangeEntry[] = [];

  for (let i = 0; i < fields.length; ) {
    const code = fields[i]!;
    const letter = code.charAt(0).toUpperCase();
    const renamed = letter === 'R' || letter === 'C';
    const from = renamed ? fields[i + 1] : undefined;
    const target = renamed ? fields[i + 2] : fields[i + 1];
    i += renamed ? 3 : 2;
    if (target === undefined) break;

    const rel = strip(target);
    if (rel === null) continue;
    const source = from === undefined ? null : strip(from);
    out.push({
      path: rel,
      size: 0,
      mtime: '',
      status: letter,
      ...(source !== null && source !== undefined ? { from: source } : {}),
    });
  }
  return out;
}

function asUntracked(rel: string): ChangeEntry {
  return { path: rel, size: 0, mtime: '', status: '?' };
}

/**
 * Fill in size and last-write for entries that still exist.
 *
 * The panel's tree shows both on every row and sums them up the folders, so a
 * changes list without them would be the one view where a folder says nothing. A
 * deleted file keeps the zero it came with, which is honest: there is nothing there
 * to measure.
 */
async function withStats(dir: string, entries: ChangeEntry[]): Promise<ChangeEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const st = await fsp.stat(path.resolve(dir, entry.path)).catch(() => null);
      if (st === null || !st.isFile()) return entry;
      return { ...entry, size: st.size, mtime: st.mtime.toISOString() };
    }),
  );
}

/**
 * Turn a repository-relative path into one relative to the directory asked about,
 * or null when it is not below it.
 *
 * Git reports porcelain paths from the repository root whatever directory it was
 * run in, so a factory scoped to a subdirectory has to shift them. Returning null
 * rather than throwing means a path from outside the subtree is simply not listed,
 * which is the same containment the project browser has.
 */
function stripper(subpath: string): (p: string) => string | null {
  if (subpath.length === 0) return (p) => (p.length > 0 ? p : null);
  const prefix = `${subpath}/`;
  return (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
}

/** What happened to a file, from which side of it has content. */
function statusOf(before: Buffer, after: Buffer): string {
  if (before.length === 0 && after.length > 0) return 'A';
  if (before.length > 0 && after.length === 0) return 'D';
  return 'M';
}

/**
 * Is this bytes rather than text?
 *
 * A NUL byte in the first few kilobytes, which is the same heuristic git uses and
 * is right for every case that matters here: no text encoding this viewer can
 * render puts a NUL in the middle of a line, and every binary format worth
 * detecting has one early.
 */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}
