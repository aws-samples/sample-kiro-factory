import type {
  Cluster,
  Factory,
  FactoryEntry,
  FactoryRef,
  FactoryResources,
  GrantDefaults,
  LibraryIndex,
  Loop,
  LoopEntry,
  LoopStatus,
  McpServer,
  ModelCatalog,
  OutputLine,
  Parameter,
  QueueItem,
  ScanResult,
  Tagged,
  Wire,
  WireMode,
} from './types.ts';

/**
 * This run's token, as the server wrote it into the document that loaded this code.
 *
 * Read once. It cannot change without the page being replaced, which is exactly what
 * happens when it goes stale.
 */
const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="kirofactory-token"]')?.content ?? '';

/**
 * Whether this page has already reloaded itself over a rejected token.
 *
 * In `sessionStorage` rather than a variable, because the thing being remembered has
 * to survive the reload it is there to bound. Without it, a token the server will
 * never accept - a bundle built without the placeholder, say - turns one failed
 * request into a page that reloads forever. One attempt, then the error is allowed
 * through to be reported like any other.
 */
const RELOAD_MARK = 'kirofactory-reloaded';

/**
 * `fetch`, carrying the token on anything that changes something.
 *
 * Two things are being proved at once. That the sender could set a header of its own
 * at all, which a page on another site cannot do cross-origin without a preflight the
 * server never grants - that is the CSRF half. And that it knows this run's token,
 * which no other process on this machine does - that is the half a header cannot
 * carry by itself.
 *
 * Every call in this module goes through here rather than each site remembering to,
 * because the failure mode of the other arrangement is an endpoint added next year
 * that quietly works in the browser and is quietly the one hole.
 *
 * A 401 means the token is from a previous run of the server, so the page reloads to
 * be served the current one. Reaching for `location.reload()` from inside a fetch
 * wrapper is not subtle, but the alternative is worse: after a restart the event
 * stream reconnects by itself and the app looks fine while every button fails.
 */
function send(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return fetch(url, init);
  return fetch(url, {
    ...init,
    headers: { ...init.headers, 'x-kirofactory': TOKEN },
  }).then((res) => {
    if (res.status === 401 && sessionStorage.getItem(RELOAD_MARK) !== '1') {
      sessionStorage.setItem(RELOAD_MARK, '1');
      location.reload();
    }
    // Cleared on the way past a write that worked, so a later restart gets its own
    // one reload rather than inheriting a mark set an hour ago.
    if (res.ok) sessionStorage.removeItem(RELOAD_MARK);
    return res;
  });
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // The server explains itself in a JSON body - a directory already in use, a
    // loop that is gone - and that message is far more useful to show than the
    // status line, so it is preferred when there is one.
    const said = await res
      .json()
      .then((b: unknown) =>
        typeof b === 'object' && b !== null && typeof (b as { error?: unknown }).error === 'string'
          ? (b as { error: string }).error
          : undefined,
      )
      .catch(() => undefined);
    throw new Error(said ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return send(url, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).then(jsonOf<T>);
}

const at = (factoryId: string): string => `/api/factories/${encodeURIComponent(factoryId)}`;

/** `?checkout=` / `&checkout=` when a session's worktree is asked for, else nothing. */
const checkoutParam = (checkout: string | undefined, lead: '?' | '&'): string =>
  checkout === undefined ? '' : `${lead}checkout=${encodeURIComponent(checkout)}`;

/** Where new factories are created, and which driver is loaded. */
export interface Defaults {
  /**
   * The directory new factories get a folder *under*, one each. Not a path any
   * factory has: it was one shared default once, which is what the singular name is
   * left over from.
   */
  baseDir: string;
  internal: string;
  driver: string;
}

/** One directory, and the directories inside it. */
export interface BrowseDir {
  path: string;
  /** The directory above, or null at the root of the filesystem. */
  parent: string | null;
  home: string;
  /** This directory holds a factory, so there is one here to open. */
  factory: boolean;
  /** And it is already a tab. */
  open: boolean;
  /** And it is called this. */
  factoryName?: string;
  entries: BrowseEntry[];
  /** Why the listing is empty, when it is empty because the directory refused. */
  note?: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  /**
   * A factory's document is in this folder. Two things follow: a move onto it will
   * be refused, and the factory in it can be opened as its own tab.
   */
  factory: boolean;
  /** And it is already a tab, so opening it only switches to it. */
  open: boolean;
  /**
   * What that factory is called, which is not what the folder is called. Absent
   * when the document is there but unreadable.
   */
  factoryName?: string;
}

/**
 * One producer's outstanding deliveries.
 *
 * A queue is one group; a topic is a group per subscriber, all returned together so
 * the panel can show the same item standing under every heading. That is the mode
 * doing its job, and it is invisible if you have to click between wires to see it.
 */
export interface Outbox {
  mode: WireMode;
  groups: OutboxGroup[];
}

export interface OutboxGroup {
  /** The subscriber's loop id, or null for the shared queue, which has no owner. */
  to: string | null;
  /** The folder, workspace-relative. The same path the producer's agent is told. */
  dir: string;
  items: QueueItem[];
}

/** Everything one loop has written, flat. The tree is built in the browser. */
export interface LoopFiles {
  /** The folder itself, relative to the base directory, for the panel to name. */
  dir: string;
  files: LoopFileEntry[];
  /**
   * The walk hit its cap, so `files` is the first slice of the tree rather than
   * all of it. The panel says so; a truncated listing that looks complete is
   * worse than no listing.
   */
  truncated?: boolean;
}

export interface LoopFileEntry {
  /** Path relative to the loop's folder, `/`-separated. */
  path: string;
  size: number;
  /** Last write, ISO. Empty if the file went away as it was being listed. */
  mtime: string;
}

/** One file's text, or why it is not here. */
export interface LoopFileBody {
  path: string;
  content: string;
  /** Set instead of content when the file is too large to send. */
  note?: string;
}

/* ------------------------------------------------------------------------ git */

/**
 * What git makes of the directory a factory runs in.
 *
 * Three states, and they are what the directory bar says out loud: not a repository
 * at all, an ordinary checkout, or a linked worktree of one. The distinction is
 * worth a permanent line on screen because it is what decides whether a run is
 * recoverable - the loops hold a shell, and the containment is the
 * directory.
 *
 * Derived, never stored. See the `/git` route on the server for why a worktree is
 * not a mode a factory is in. Per-session checkouts are the exception with a
 * reason - their paths are not derivable - and they live in `SessionCheckout`
 * below, not here.
 */
export interface GitState {
  kind: 'none' | 'repo' | 'worktree';
  /** Why there is no repository. Only on `none`. */
  reason?: string;
  /** The working tree's root, at or above the factory's directory. */
  root?: string;
  /** Where the factory's directory sits below `root`. '' when they are the same. */
  subpath?: string;
  branch?: string;
  /** On no branch, so a commit would go nowhere a name can find it. */
  detached?: boolean;
  /** Nothing committed yet, so there is no HEAD to diff or branch from. */
  unborn?: boolean;
  /** The main checkout a worktree is linked to. Only on `worktree`. */
  mainRoot?: string;
  /** The directory itself is gitignored, so the changes view is empty by construction. */
  ignored?: boolean;
}

/**
 * One session's own checkout, from the server's worktrees.json sidecar.
 *
 * Keyed by runner key where it is returned in a map: a plain loop's bare id, or
 * `<loopId>#<n>` for a cluster member. Hand-mirrored from server/worktrees.ts,
 * the same way `GitState` is from git.ts.
 */
export interface SessionCheckout {
  /** Absolute path of the session's working directory. */
  dir: string;
  branch: string;
}

/** One checkout in the factory-wide list, labelled by the loop it belongs to. */
export interface WorktreeEntry extends SessionCheckout {
  key: string;
  loopId: string;
  loopName: string;
  /** Which member of a cluster, absent for a plain loop's one session. */
  member?: number;
}

/** What a release did: which sessions went, which refused and why. */
export interface Released {
  removed: string[];
  failures: { key: string; error: string }[];
  sessions: Record<string, SessionCheckout>;
}

/** Which comparison the changes view is showing. */
export type DiffRange = 'uncommitted' | 'branch';

/**
 * A changed file, in the shape the file tree already understands plus a status.
 *
 * `LoopFileEntry` with two fields added rather than a type of its own, which is what
 * lets `buildTree` and `sortNodes` take a changes list untouched.
 */
export interface ChangeEntry extends LoopFileEntry {
  /** `M`, `A`, `D`, `R`, `C`, `U`, or `?` for untracked. */
  status: string;
  /** Where it came from, for a rename. */
  from?: string;
}

/** The changes list, answering in the same `{ dir, files }` shape as the other two. */
export interface Changes {
  dir: string;
  files: ChangeEntry[];
  /** The state of the repository, so the bar and the panel agree from one request. */
  git: GitState;
  range: DiffRange;
  /** The revision compared against, resolved. */
  against?: string;
  /** What that was worked out from: `HEAD`, or the trunk this branch left. */
  base?: string;
  /** Why the list is empty, when it is empty for a reason worth saying. */
  note?: string;
}

/** One changed file, whole, from both sides. */
export interface FileDiff {
  path: string;
  status: string;
  before: string;
  after: string;
  note?: string;
  /** Neither side is text, so there is nothing to show line by line. */
  binary?: boolean;
}

export const api = {
  defaults: (): Promise<Defaults> => send('/api/defaults').then(jsonOf<Defaults>),

  /**
   * Models a loop can run on, discovered from kiro-cli.
   *
   * `retry` asks the server to probe again after a failure instead of repeating the
   * failure it already has. Only for a retry the operator asked for: an ordinary
   * load must not, or every open tab would start a probe of its own.
   */
  models: (retry = false): Promise<ModelCatalog> =>
    send(`/api/models${retry ? '?retry=yes' : ''}`).then(jsonOf<ModelCatalog>),

  /** What a new loop starts out allowed to use. Per operator, not per factory. */
  grants: (): Promise<GrantDefaults> => send('/api/grants').then(jsonOf<GrantDefaults>),

  /**
   * Remember one axis of that as the operator's own default.
   *
   * One axis per call, matching the two buttons in the panel: saving what a loop may
   * reach says nothing about which tools it holds. `null` is "all of them", which is
   * a choice and is stored as one.
   */
  putGrant: (axis: 'tools' | 'mcp', value: string[] | null): Promise<GrantDefaults> =>
    send('/api/grants', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ axis, value }),
    }).then(jsonOf<GrantDefaults>),

  /** Subdirectories of one directory. Omit the path to start at home. */
  browse: (dir?: string): Promise<BrowseDir> =>
    send(`/api/browse${dir === undefined ? '' : `?path=${encodeURIComponent(dir)}`}`).then(
      jsonOf<BrowseDir>,
    ),

  /* --------------------------------------------------------------- library */

  /**
   * Everything kept in the repository, in its three groups. One collection, shared
   * by every factory.
   */
  library: (): Promise<LibraryIndex> => send('/api/library').then(jsonOf<LibraryIndex>),

  /**
   * Keep one component. `cluster` when it is a cluster, absent when it is a loop -
   * the entry comes back out of the library as whichever it went in as.
   */
  saveToLibrary: (loop: {
    name: string;
    prompt: string;
    description?: string;
    cluster?: Cluster;
  }): Promise<LoopEntry> => post<LoopEntry>('/api/library/loops', loop),

  /**
   * Keep a whole factory: its loops, its wires and its parameters.
   *
   * The graph goes in the body rather than the factory's id going in the path,
   * because what is worth sharing is what is on the canvas - and the canvas is here.
   *
   * A name already in the library resolves to `{ conflict: true }` rather than
   * throwing, because it is an answerable question - replace it? - not a failure.
   * Answering yes is calling this again with `overwrite` set. Distinguished by the
   * 409 and the body's `conflict` flag, not by matching the error's wording, which
   * is why this does not go through the generic thrower.
   */
  saveFactoryToLibrary: async (factory: {
    name: string;
    description?: string;
    loops: Loop[];
    wires: Wire[];
    parameters?: Parameter[];
    overwrite?: boolean;
  }): Promise<FactoryEntry | { conflict: true }> => {
    const res = await send('/api/library/factories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(factory),
    });
    if (res.status === 409) {
      // The body is readable once, so it is not handed on to `jsonOf` after this.
      const body = (await res.json().catch(() => null)) as {
        conflict?: unknown;
        error?: unknown;
      } | null;
      if (body?.conflict === true) return { conflict: true };
      throw new Error(typeof body?.error === 'string' ? body.error : `${res.status} ${res.statusText}`);
    }
    return jsonOf<FactoryEntry>(res);
  },

  /**
   * Take a factory out of the library, as a new tab.
   *
   * A new factory every time, not a restored one: an entry is a template, so this
   * mints an id rather than keeping one. `baseDir` is optional - without it the
   * factory gets a directory of its own, the same as one created from the tab strip.
   */
  openLibraryFactory: (slug: string, baseDir?: string): Promise<{ factory: Factory }> =>
    post<{ factory: Factory }>(
      `/api/library/factories/${encodeURIComponent(slug)}/open`,
      baseDir === undefined ? {} : { baseDir },
    ),

  /* ------------------------------------------------------------- factories */

  factories: (): Promise<FactoryRef[]> => send('/api/factories').then(jsonOf<FactoryRef[]>),

  /**
   * Every factory the server has ever seen, closed ones included.
   *
   * The history behind the Factories tab in the Open picker, and the reason closing
   * a tab is cheap: the entry survives it, carrying `open: false`, so a factory
   * nobody thought to write down the path of can still be offered back by name.
   *
   * Ask for it rather than wait for it. The `factories` event on the stream carries
   * the open list only, so nothing pushes this one and the tab fetches when it is
   * opened. Closed entries are the part worth showing, but the endpoint answers with
   * all of them, so the caller filters.
   */
  known: (): Promise<FactoryRef[]> => send('/api/factories/known').then(jsonOf<FactoryRef[]>),

  /**
   * Go looking for factories nobody wrote the path of down.
   *
   * The recovery path for a factory that is on disk and not in the list: moved to a
   * new folder, or left behind by a checkout whose registry was never migrated.
   * Walks the home directory and registers what it finds, all of it closed, so the
   * answer is a longer Factories tab and never a new tab.
   *
   * POST because it writes. Seconds rather than milliseconds - it is reading real
   * directories - so the caller owes the operator a spinner, and the answer carries
   * the counts to report. Not the list, though: the buckets are what the walk met,
   * and a factory the walk could not reach is still in the registry - ask `known()`
   * for that.
   */
  scanFactories: (): Promise<ScanResult> => post<ScanResult>('/api/factories/scan'),

  createFactory: (input?: { name?: string; baseDir?: string }): Promise<Factory> =>
    post<Factory>('/api/factories', input ?? {}),

  importFactory: (doc: unknown): Promise<{ factory: Factory; note?: string }> =>
    post<{ factory: Factory; note?: string }>('/api/factories/import', doc),

  /**
   * Open the factory that is already in a directory.
   *
   * The way back from closing a tab, and the reason closing is safe: the factory is
   * still in its folder, so the folder is enough to get it back. Keeps the
   * document's own id and name, so it is the same factory rather than a new one in
   * the same place - and opening a directory that is already a tab just answers
   * with that tab.
   */
  openFactory: (baseDir: string): Promise<{ factory: Factory; note?: string }> =>
    post<{ factory: Factory; note?: string }>('/api/factories/open', { baseDir }),

  closeFactory: (id: string): Promise<FactoryRef[]> =>
    send(at(id), { method: 'DELETE' }).then(jsonOf<FactoryRef[]>),

  /**
   * Close the tab and delete the factory's own data - `.kirofactory` under its
   * base directory. Nothing else there is touched; see the server's route note.
   */
  deleteFactory: (id: string): Promise<FactoryRef[]> =>
    send(`${at(id)}?files=yes`, { method: 'DELETE' }).then(jsonOf<FactoryRef[]>),

  reorderFactories: (ids: string[]): Promise<FactoryRef[]> =>
    send('/api/factories/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).then(jsonOf<FactoryRef[]>),

  /** Rename, or move to another directory. Either field on its own. */
  patchFactory: (id: string, patch: { name?: string; baseDir?: string }): Promise<Factory> =>
    send(at(id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(jsonOf<Factory>),

  /* -------------------------------------------------------- one factory's document */

  getFactory: (id: string): Promise<Factory> => send(at(id)).then(jsonOf<Factory>),

  putFactory: (id: string, factory: Factory): Promise<Factory> =>
    send(at(id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(factory),
    }).then(jsonOf<Factory>),

  exportUrl: (id: string): string => `${at(id)}/export`,

  /* ------------------------------------------------------------------ running */

  status: (id: string): Promise<LoopStatus[]> => send(`${at(id)}/status`).then(jsonOf<LoopStatus[]>),

  /** Outstanding item count per wire id. */
  queues: (id: string): Promise<Record<string, number>> =>
    send(`${at(id)}/queues`).then(jsonOf<Record<string, number>>),

  /** What one loop is delivering right now, grouped by the folder it goes into. */
  outbox: (id: string, loopId: string): Promise<Outbox> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/outbox`).then(jsonOf<Outbox>),

  /**
   * Throw away everything waiting on those folders.
   *
   * Answers with the outbox as it now stands, plus `cleared`, so the panel redraws
   * from the truth rather than from an assumption about what the delete did.
   */
  clearOutbox: (id: string, loopId: string): Promise<Outbox & { cleared: number }> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/outbox`, { method: 'DELETE' }).then(
      jsonOf<Outbox & { cleared: number }>,
    ),

  /** MCP servers a prompt in this factory can name. Depends on its base directory. */
  mcp: (id: string): Promise<McpServer[]> => send(`${at(id)}/mcp`).then(jsonOf<McpServer[]>),

  /**
   * Skills and steering files a prompt in this factory can name.
   *
   * Depends on the base directory the same way `mcp` does, and fetched in the same
   * effect. No polling: a stale list costs a page refresh, not a wrong prompt, and
   * the prompt itself is matched server-side against a list read fresh each turn.
   */
  resources: (id: string): Promise<FactoryResources> =>
    send(`${at(id)}/resources`).then(jsonOf<FactoryResources>),

  output: (id: string, loopId: string): Promise<OutputLine[]> =>
    send(`${at(id)}/output/${encodeURIComponent(loopId)}`).then(jsonOf<OutputLine[]>),

  /* ------------------------------------------------------------- the project */

  /**
   * The project the loops are building, as the same flat listing a loop's folder
   * gives. Heavy directories - `node_modules`, `.git`, build output - are pruned
   * server-side, so this is the source tree rather than everything on disk.
   *
   * No delete beside it, unlike the loop pair below: these are real source files.
   */
  projectFiles: (id: string, checkout?: string): Promise<LoopFiles> =>
    send(`${at(id)}/files${checkoutParam(checkout, '?')}`).then(jsonOf<LoopFiles>),

  /** One of those files, by its path relative to the base directory. */
  projectFile: (id: string, file: string, checkout?: string): Promise<LoopFileBody> =>
    send(`${at(id)}/file?path=${encodeURIComponent(file)}${checkoutParam(checkout, '&')}`).then(
      jsonOf<LoopFileBody>,
    ),

  /**
   * Copy a dropped file into the project root. Answers with the fresh listing, so
   * the panel redraws from the truth rather than assuming the write worked. With
   * `checkout`, the file lands in that session's worktree instead - where the
   * panel says it is looking is where the drop goes.
   */
  uploadProjectFile: (id: string, name: string, file: Blob, checkout?: string): Promise<LoopFiles> =>
    send(`${at(id)}/file?path=${encodeURIComponent(name)}${checkoutParam(checkout, '&')}`, {
      method: 'PUT',
      body: file,
    }).then(jsonOf<LoopFiles>),

  /**
   * Every checkout this factory's sessions have, labelled for the picker: which
   * loop, which member, which branch, where. Document order.
   */
  worktrees: (id: string): Promise<{ sessions: WorktreeEntry[] }> =>
    send(`${at(id)}/worktrees`).then(jsonOf<{ sessions: WorktreeEntry[] }>),

  /** Copy a dropped file into a loop's own folder. Same bargain as above. */
  uploadLoopFile: (id: string, loopId: string, name: string, file: Blob): Promise<LoopFiles> =>
    send(
      `${at(id)}/loops/${encodeURIComponent(loopId)}/file?path=${encodeURIComponent(name)}`,
      { method: 'PUT', body: file },
    ).then(jsonOf<LoopFiles>),

  /* ------------------------------------------------------------------- git */

  /** Whether the factory's directory is a repository, a worktree, or neither. */
  git: (id: string): Promise<GitState> => send(`${at(id)}/git`).then(jsonOf<GitState>),

  /**
   * Branch off into a worktree, and move the factory into it.
   *
   * Refused while anything is running, for the same reason changing the directory by
   * hand is: this *is* changing the directory, and a turn in flight would finish
   * into the one being left.
   */
  branchOff: (id: string): Promise<{ factory: Factory; branch: string; dir: string }> =>
    post<{ factory: Factory; branch: string; dir: string }>(`${at(id)}/worktree`),

  /** What the loops have changed in the project, against HEAD or the branch point. */
  changes: (id: string, range: DiffRange): Promise<Changes> =>
    send(`${at(id)}/changes?range=${range}`).then(jsonOf<Changes>),

  /** One of those files, both sides of it, for the diff view to lay out. */
  diff: (id: string, file: string, range: DiffRange): Promise<FileDiff> =>
    send(`${at(id)}/diff?path=${encodeURIComponent(file)}&range=${range}`).then(jsonOf<FileDiff>),

  /*
   * The per-session mirror of the git block above, for loops with `worktree` on.
   * `loopWorktrees` and `releaseWorktrees` take a loop id - checkouts are
   * listed and released per component. The changes pair takes a *runner key*
   * (`loop-abc`, or `loop-abc#3` for one member), because a checkout belongs to
   * a session; `encodeURIComponent` carries the `#` as `%23`.
   */

  /** One component's checkouts, keyed by runner key. Empty when never provisioned. */
  loopWorktrees: (id: string, loopId: string): Promise<{ sessions: Record<string, SessionCheckout> }> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/worktree`).then(
      jsonOf<{ sessions: Record<string, SessionCheckout> }>,
    ),

  /**
   * Remove a component's checkouts. Refused while it runs; a checkout with
   * uncommitted changes refuses individually and lands in `failures` - git is
   * never forced, and branches are never deleted.
   */
  releaseWorktrees: (id: string, loopId: string): Promise<Released> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/worktree`, { method: 'DELETE' }).then(
      jsonOf<Released>,
    ),

  /** What one session changed in its own checkout. 404s when it has none. */
  loopChanges: (id: string, key: string, range: DiffRange): Promise<Changes> =>
    send(`${at(id)}/loops/${encodeURIComponent(key)}/changes?range=${range}`).then(jsonOf<Changes>),

  /** One of those files, both sides, from that session's checkout. */
  loopDiff: (id: string, key: string, file: string, range: DiffRange): Promise<FileDiff> =>
    send(
      `${at(id)}/loops/${encodeURIComponent(key)}/diff?path=${encodeURIComponent(file)}&range=${range}`,
    ).then(jsonOf<FileDiff>),

  /* --------------------------------------------------- what a loop has written */

  /** Files in one loop's own folder. Empty for a loop that has never run. */
  loopFiles: (id: string, loopId: string): Promise<LoopFiles> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/files`).then(jsonOf<LoopFiles>),

  /** One of those files, by its path relative to the loop's folder. */
  loopFile: (id: string, loopId: string, file: string): Promise<LoopFileBody> =>
    send(
      `${at(id)}/loops/${encodeURIComponent(loopId)}/file?path=${encodeURIComponent(file)}`,
    ).then(jsonOf<LoopFileBody>),

  /*
   * Both deletes answer with the folder as it now stands, rather than with an
   * acknowledgement. The panel has to redraw either way, and one round trip that
   * returns the new truth beats two where the second asks what just happened.
   */

  deleteLoopFile: (id: string, loopId: string, file: string): Promise<LoopFiles> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/file?path=${encodeURIComponent(file)}`, {
      method: 'DELETE',
    }).then(jsonOf<LoopFiles>),

  /** Everything the loop has written. Refused while the loop is going. */
  clearLoopFiles: (id: string, loopId: string): Promise<LoopFiles> =>
    send(`${at(id)}/loops/${encodeURIComponent(loopId)}/files`, { method: 'DELETE' }).then(
      jsonOf<LoopFiles>,
    ),

  startLoop: (id: string, loopId: string): Promise<LoopStatus> =>
    post<LoopStatus>(`${at(id)}/loops/${encodeURIComponent(loopId)}/start`),

  stopLoop: (id: string, loopId: string): Promise<LoopStatus> =>
    post<LoopStatus>(`${at(id)}/loops/${encodeURIComponent(loopId)}/stop`),

  /**
   * Stop one component now, killing the turn in flight. A cluster's members go
   * together - the card is the component, so the button on it acts on all of them.
   */
  forceStopLoop: (id: string, loopId: string): Promise<LoopStatus> =>
    post<LoopStatus>(`${at(id)}/loops/${encodeURIComponent(loopId)}/force-stop`),

  /**
   * An operator message for one loop. The reply only acknowledges; the message
   * itself comes back on the event stream as a `user` output line, and whatever
   * the loop makes of it follows as ordinary output.
   */
  steerLoop: (id: string, loopId: string, text: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`${at(id)}/loops/${encodeURIComponent(loopId)}/steer`, { text }),

  startAll: (id: string): Promise<LoopStatus[]> => post<LoopStatus[]>(`${at(id)}/start`),

  stopAll: (id: string): Promise<LoopStatus[]> => post<LoopStatus[]>(`${at(id)}/stop`),

  /** Stop everything now, killing any turn in flight. */
  forceStopAll: (id: string): Promise<LoopStatus[]> => post<LoopStatus[]>(`${at(id)}/force-stop`),
};

/**
 * Subscribe to the server's event stream. Returns an unsubscribe function.
 *
 * One stream carries every factory, so status and output frames are tagged and a
 * view filters for its own. The browser's EventSource reconnects on its own, and
 * the server replays the factory list and current status on connect, so a dropped
 * socket heals without anything here doing work.
 */
export function subscribe(handlers: {
  onStatus?: (s: Tagged<LoopStatus>) => void;
  onStatusAll?: (s: { factory: string; status: LoopStatus[] }) => void;
  onOutput?: (line: Tagged<OutputLine>) => void;
  onFactory?: (f: Factory) => void;
  onFactories?: (list: FactoryRef[]) => void;
}): () => void {
  const es = new EventSource('/api/events');
  const on = <T,>(name: string, fn?: (value: T) => void) => {
    if (!fn) return;
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse((e as MessageEvent<string>).data) as T);
      } catch {
        // A malformed frame is dropped rather than breaking the stream.
      }
    });
  };
  on('status', handlers.onStatus);
  on('status-all', handlers.onStatusAll);
  on('output', handlers.onOutput);
  on('factory', handlers.onFactory);
  on('factories', handlers.onFactories);
  return () => es.close();
}
