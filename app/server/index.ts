/**
 * The server. One file, one port: static web app, a JSON API, and one SSE stream
 * carrying status and loop output for every open factory.
 *
 * A factory is a tab, and each one owns a directory. Everything a factory needs on
 * disk lives under `<baseDir>/.kirofactory/` - its document, its queues, its
 * loops' scratch space - so the directory you point it at is both where the agents
 * run and the only place this program writes.
 *
 * The API surface, which is the point:
 *
 *   GET    /api/defaults                   default base directory for a new factory
 *   GET    /api/models                     models a loop can run on, from kiro-cli
 *   GET    /api/grants                     what a new loop starts out allowed to use
 *   PUT    /api/grants                     save one axis of that as the operator's own
 *   GET    /api/browse?path=              subdirectories of one directory, to pick one
 *   GET    /api/library                    the library, committed in this repo
 *   POST   /api/library/loops              save a loop or a cluster into it
 *   POST   /api/library/factories          save a whole factory into it
 *   POST   /api/library/factories/:s/open  take one out, as a new factory
 *   GET    /api/factories                  the open factories
 *   GET    /api/factories/known            every factory ever seen, closed ones too
 *   POST   /api/factories/scan             look for lost ones under $HOME and adopt them
 *   POST   /api/factories                  create one
 *   POST   /api/factories/import           create one from an exported document
 *   POST   /api/factories/open             reopen the one already in a directory
 *   PUT    /api/factories/order            tab order
 *   GET    /api/factories/:f               the document
 *   PUT    /api/factories/:f               replace the document (the canvas saves here)
 *   PATCH  /api/factories/:f               rename, or move to another directory
 *   DELETE /api/factories/:f               close the tab; the entry and the files stay
 *   DELETE /api/factories/:f?files=yes     delete: also remove <baseDir>/.kirofactory
 *   GET    /api/factories/:f/export        the document as a download
 *   GET    /api/factories/:f/status        every loop's state and iteration count
 *   GET    /api/factories/:f/queues        how many items are outstanding per wire
 *   GET    /api/factories/:f/loops/:l/outbox   what one loop is delivering, by folder
 *   DELETE /api/factories/:f/loops/:l/outbox   empty those folders
 *   GET    /api/factories/:f/mcp           MCP servers a prompt here can name
 *   GET    /api/factories/:f/resources     skills and steering files a prompt here can name
 *   GET    /api/factories/:f/git           whether the directory is a repo, a worktree, or neither
 *   POST   /api/factories/:f/worktree      branch off into a worktree and move there
 *   GET    /api/factories/:f/changes?range=   what the loops have changed in the project
 *   GET    /api/factories/:f/diff?path=&range=  one of those files, before and after
 *   GET    /api/factories/:f/worktrees        every session checkout, labelled, for the picker
 *   GET    /api/factories/:f/loops/:l/worktree   one component's checkouts, from the sidecar
 *   DELETE /api/factories/:f/loops/:l/worktree   remove them; the branches stay
 *   GET    /api/factories/:f/loops/:l/changes?range=   what one session changed in its checkout
 *   GET    /api/factories/:f/loops/:l/diff?path=&range=  one of those files, before and after
 *   POST   /api/factories/:f/loops/:l/start | /stop | /force-stop
 *   POST   /api/factories/:f/loops/:l/steer    an operator message for the loop
 *   POST   /api/factories/:f/start | /stop | /force-stop  all loops in the factory
 *   GET    /api/factories/:f/output/:l     output buffered for one loop
 *   GET    /api/factories/:f/files                the project the loops build (&checkout= for a session's worktree)
 *   GET    /api/factories/:f/file?path=           one of those files, as text (&checkout= likewise)
 *   GET    /api/factories/:f/loops/:l/files       what one loop has written
 *   DELETE /api/factories/:f/loops/:l/files       clear the folder; the loop must be stopped
 *   GET    /api/factories/:f/loops/:l/file?path=  one of those files, as text
 *   DELETE /api/factories/:f/loops/:l/file?path=  delete just that one
 *   GET    /api/events                     SSE: status and output as they happen
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDriver } from './acp.ts';
import {
  DocumentError,
  INTERNAL,
  docPath,
  empty,
  inside,
  isHomeDir,
  load,
  loopDir,
  newFactoryId,
  parse,
  save,
  type Factory,
  type FactoryRef,
} from './factory.ts';
import * as git from './git.ts';
import { readSessions } from './worktrees.ts';
import { ConflictError, Host, type Emit } from './host.ts';
import * as library from './library.ts';
import { discoverModels, type ModelCatalog } from './models.ts';
import {
  readGrants,
  resolve as resolveGrants,
  saveAxis as saveGrantAxis,
} from './grants.ts';
import { Registry, migrateLegacy } from './registry.ts';
import { scanForFactories } from './scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

const PORT = Number(process.env.PORT ?? 4711);
/**
 * What to bind. Loopback unless somebody deliberately says otherwise.
 *
 * The default has always been right; what was missing is that the override went
 * straight into `listen()`. `HOST=0.0.0.0` published this API to the network, and
 * this API starts agents that hold shell, write and delete inside the project
 * directory, with no authentication in front of any of it. That is not a setting to
 * be able to reach for absent-mindedly, and one word in a comment in `run.sh` is not
 * enough friction.
 *
 * So a non-loopback bind refuses unless `KIROFACTORY_ALLOW_REMOTE=1` also says so.
 * Two independent statements of intent, and the process dies rather than starting
 * something it shouldn't have. Widening exposure is still possible - it is somebody
 * else's isolated host and their decision - it just cannot happen by accident.
 */
const HOST = process.env.HOST ?? '127.0.0.1';
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];
if (!LOOPBACK_HOSTS.includes(HOST) && process.env.KIROFACTORY_ALLOW_REMOTE !== '1') {
  process.stderr.write(
    `refusing to bind ${HOST}: this server runs agents with shell access and has no\n` +
      `authentication. Set KIROFACTORY_ALLOW_REMOTE=1 only on a trusted, isolated host.\n`,
  );
  process.exit(1);
}
/**
 * The one workspace that existed before tabs: `app/workspace`, singular.
 *
 * Read by `migrateLegacy` and by nothing else, and it has two callers' worth of
 * meaning. It is where a pre-tabs installation kept its only factory, so it is how
 * that work survives an update. It is also where the sample design in
 * `app/factory.json` lands on a fresh clone, since the same migration is what turns
 * that file into the first tab.
 *
 * What it is *not*, any more, is the preferred home for a new factory. It used to be,
 * which is why an installation ends up with this and the plural `workspaces/` beside
 * it: the first factory landed here and every one after it got a folder of its own,
 * so factory one was structurally unlike factory two for a reason that stopped
 * mattering the day tabs existed. New factories all go under `AUTO_BASE` now.
 */
const LEGACY_BASE = path.resolve(process.env.BASE_DIR ?? path.join(appRoot, 'workspace'));
/**
 * Where every new factory goes: a folder of its own under here, named by its id.
 *
 * Beside the legacy workspace rather than inside it, and one level down from
 * `appRoot` rather than at it. Nesting one factory's directory inside another's
 * working directory would put it somewhere the outer factory's agents can see and
 * wander into.
 */
const AUTO_BASE = path.resolve(process.env.WORKSPACES ?? path.join(appRoot, 'workspaces'));
/**
 * Every factory this installation has seen, and which of them are tabs.
 *
 * Per user, not per checkout: `~/.kirofactory/factories.json`. It lived next to the
 * app until this became the fix for factories going missing - a second clone of this
 * repo started with an empty list, and every factory in it looked lost even though
 * nothing on disk had moved. One list per machine is what "my factories" means.
 *
 * `REGISTRY` still overrides the whole path. An operator who names a file has said
 * exactly what they want and gets exactly that, including no migration into it.
 *
 * The directory is not created here. `Registry.write` does `mkdir -p` on the file's
 * own dirname, so the first write makes it, and a machine that has never saved
 * anything is left without an empty folder in its home directory.
 */
const REGISTRY_FILE = path.resolve(process.env.REGISTRY ?? path.join(os.homedir(), INTERNAL, 'factories.json'));
/**
 * The registry as it was before it moved out of the checkout.
 *
 * Merged into the per-user file once, at startup, and then left alone forever as a
 * fossil. Not deleted: it costs nothing where it is, and a file that quietly
 * vanished from a checkout during an upgrade is a worse surprise than one that stays
 * and is ignored. See `Registry.mergeInto` for who wins on a conflict.
 */
const LEGACY_REGISTRY_FILE = path.join(appRoot, 'factories.json');
/**
 * The operator's own default grant for a new loop, beside their factory list.
 *
 * Derived from the registry's directory rather than from `os.homedir()` again, so
 * that `REGISTRY` pointing somewhere else - a test, a second profile - takes this
 * with it. The two files answer the same question about scope, and having one of
 * them follow an override while the other stayed in `$HOME` would be a surprise
 * nobody asked for.
 */
const GRANTS_FILE = path.join(path.dirname(REGISTRY_FILE), 'grants.json');
const WEB_DIST = path.join(appRoot, 'web', 'dist');

const driver = defaultDriver();

/*
 * The model catalogue, asked for once and then kept - unless the asking failed.
 *
 * Shared as a promise so that a page load arriving mid-probe waits on the answer
 * being fetched rather than starting a second probe of its own. A success is kept
 * for the life of the process: the catalogue changes when kiro-cli is updated,
 * which is also when this server is restarted.
 *
 * A failure is not kept, and that is the whole point of holding this in a variable
 * rather than a `const`. The probe fails for reasons that pass - kiro-cli mid-update,
 * an expired login, a session that took longer than the timeout because every MCP
 * server on the machine decided to start at once. Caching that answer forever turned
 * one bad moment at startup into a model picker that never came back, with nothing
 * to distinguish it from the feature not existing. So the slot is cleared on failure
 * and the next request tries again.
 *
 * The echo driver has no kiro-cli to ask. That is not a failure, so it is not
 * retried: there is nothing there to succeed later.
 */
let models: Promise<ModelCatalog> | undefined =
  driver.name === 'echo' ? Promise.resolve({ models: [] }) : undefined;

/**
 * When the last failed probe finished, so a burst of requests cannot spawn a
 * kiro-cli each.
 *
 * Retrying is only useful if it is occasional. A failure with several tabs open
 * would otherwise mean one process per tab, all of them failing the same way, and a
 * page that reloads on a timer would keep doing it. One attempt per window, and
 * requests arriving inside it get the failure that is already known.
 */
let lastFailure = 0;
/** Why it failed, so a throttled answer names the cause rather than the throttle. */
let lastReason = 'discovery failed';
const RETRY_AFTER_MS = 60_000;

/**
 * The catalogue if it is known, else a probe - reusing the one in flight.
 *
 * `force` skips the window, for an operator who pressed retry. They are watching,
 * and a button that answers "not yet" is worse than one that takes five seconds.
 */
function modelCatalog(force = false): Promise<ModelCatalog> {
  if (models !== undefined) return models;
  if (!force && Date.now() - lastFailure < RETRY_AFTER_MS) {
    return Promise.resolve({ models: [], failed: true, reason: lastReason });
  }
  const probe = discoverModels(process.env.KIRO_CLI ?? 'kiro-cli').then((catalog) => {
    // Clearing the slot rather than the promise's value: the next caller starts a
    // fresh probe, while everyone already waiting on this one gets the failure.
    if (catalog.failed === true) {
      models = undefined;
      lastFailure = Date.now();
      lastReason = catalog.reason ?? 'discovery failed';
    }
    return catalog;
  });
  models = probe;
  return probe;
}

/*
 * Asked here, at module load, and deliberately not further down with the rest of
 * startup.
 *
 * The probe costs several seconds, most of it kiro-cli opening a session, and none
 * of those seconds need anything this server does. Started here they run alongside
 * reading the registry and opening every factory - work that is sequential, touches
 * the disk per factory, and would otherwise all happen before the question was even
 * asked. By the time the port opens the answer is usually already in hand.
 *
 * Not awaited, so nothing waits on it: listening is what the operator is waiting
 * for, and a loop runs whether or not the picker has its list yet.
 */
void modelCatalog();

const registry = new Registry(REGISTRY_FILE);
const hosts = new Map<string, Host>();
const clients = new Set<ServerResponse>();
/**
 * Is a scan of the home directory running right now?
 *
 * One at a time. Two concurrent walks would read the registry, decide what is new,
 * and write - each against a list the other is changing underneath it, which is how
 * one factory gets registered twice with two ids. The window is wide, seconds of
 * filesystem work, and the button that starts it is easy to press twice.
 *
 * A flag rather than a queue: the second request wants the same answer the first is
 * already fetching, so making it wait its turn to walk the same directories again
 * would be slower and no more correct. It is told to wait instead.
 */
let scanning = false;

/* --------------------------------------------------------------- broadcast */

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function send(event: string, data: unknown): void {
  const text = frame(event, data);
  for (const res of clients) {
    try {
      res.write(text);
    } catch {
      // A dead client is dropped on its own 'close' event; never let one broken
      // socket stop the others from being told.
    }
  }
}

/**
 * Every status and output frame says which factory it came from, because one
 * stream now carries several. A `factory` frame needs no tag: the document has its
 * own id in it.
 */
function emitFor(id: string): Emit {
  return (event, data) => {
    if (event === 'factory') send(event, data);
    else send(event, { factory: id, ...(data as object) });
  };
}

/* ----------------------------------------------------------------- opening */

async function open(ref: { id: string; name: string; baseDir: string }): Promise<Host> {
  let doc: Factory;
  try {
    doc = await load(ref.baseDir, ref);
  } catch (err) {
    if (!(err instanceof DocumentError)) throw err;
    /*
     * The document is there and cannot be used. Nothing is written and nothing is
     * pruned.
     *
     * The tab still opens, on an empty factory, because a registered factory that
     * silently vanishes from the strip is worse than one that opens blank - but
     * the blank one is in memory only. The broken file is copied aside under a
     * timestamped name so the operator can recover it by hand, the original is
     * left exactly where it was, and `prepare` is skipped: with no wires in the
     * empty document, it would read every queue folder as orphaned and delete the
     * unclaimed items in them. The first real edit on the canvas saves and
     * prepares as normal, which is the operator saying they have moved on.
     *
     * Reported on stdout because at startup there is no browser to tell yet. The
     * `open` route for a directory reports the same condition as a 422.
     */
    const file = docPath(ref.baseDir);
    const aside = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.copyFile(file, aside).catch(() => undefined);
    process.stderr.write(
      `\n  [${ref.name}] the factory document could not be read and was left untouched.\n` +
        `  ${err.message}\n` +
        `  A copy is at ${aside}. The tab opens empty; the first edit will overwrite ${file}.\n\n`,
    );
    const host = new Host({ ...empty(ref), id: ref.id, name: ref.name, baseDir: ref.baseDir }, driver, emitFor(ref.id));
    hosts.set(host.id, host);
    return host;
  }
  // The registry is what the tab strip showed, so its name and location win over
  // a document that was edited underneath us. The document is then written back
  // so the two agree.
  const factory: Factory = { ...doc, id: ref.id, name: ref.name, baseDir: ref.baseDir };
  const host = new Host(factory, driver, emitFor(ref.id));
  await save(factory);
  await host.prepare();
  hosts.set(host.id, host);
  return host;
}

/**
 * Is this directory available to a factory?
 *
 * Available means no other factory's document is sitting in it and no open tab
 * claims it. Two factories cannot share a base directory: their documents would
 * be the same file.
 *
 * Open tabs only, deliberately: a closed factory must not block its own directory,
 * or reopening it would be impossible. Nothing is lost by that, because the closed
 * factory's document is still on disk in there and the second half of this function
 * finds it. A directory holding someone else's document is refused whether or not
 * that someone is currently a tab.
 *
 * The home directory is refused outright and before anything else, because it is not
 * about who is in it: `~/.kirofactory/` is the registry's directory, so no factory
 * can have that as its internal folder. See `isHomeDir`.
 */
async function isFree(dir: string, id: string): Promise<boolean> {
  if (isHomeDir(dir)) return false;
  if (registry.list().some((r) => r.id !== id && r.baseDir === path.resolve(dir))) return false;
  const doc = docPath(dir);
  if (!existsSync(doc)) return true;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(doc, 'utf8'));
    const other = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
    return typeof other !== 'string' || other === id;
  } catch {
    // Nothing readable there is nothing worth protecting.
    return true;
  }
}

/**
 * Can a document arriving from outside keep the id it carries?
 *
 * Only an *open* tab holding that id is a conflict. A closed entry with the same id
 * is the same factory coming back, and reusing its id is what puts it back where it
 * was instead of leaving a stale row behind and adding a second one. That is why
 * this asks `list()` rather than `get()`, now that `get()` answers for closed
 * factories too.
 */
function idFree(id: string): boolean {
  return !registry.list().some((r) => r.id === id);
}

/** The home a factory gets when nobody named one: `workspaces/<id>`. */
function ownBaseDir(id: string): string {
  return path.join(AUTO_BASE, id);
}

/**
 * Where a factory goes, given what was asked for.
 *
 * A directory that is free is used as asked. One already claimed by another factory
 * falls back to a folder of the factory's own, because landing on top of somebody
 * else's document would be worse than landing somewhere unexpected.
 *
 * Every caller now passes `ownBaseDir(id)` when the operator named nothing, so the
 * preferred path is only ever a real request - imported from a file, or typed. The
 * first factory on a fresh install is therefore no different from the fifth.
 *
 * A directory the operator typed into the bar is never redirected like this: that
 * case errors instead, in Host.setBaseDir, because quietly using a different
 * directory than the one asked for is worse than refusing.
 */
async function pickBaseDir(preferred: string, id: string): Promise<string> {
  if (await isFree(preferred, id)) return path.resolve(preferred);
  return ownBaseDir(id);
}

/* -------------------------------------------------------------- browsing */

/**
 * One directory's subdirectories, so the base directory can be picked rather than
 * typed.
 *
 * This exists because a browser cannot tell you an absolute path. A file input
 * hands over a name and some bytes, and a directory input hands over relative
 * paths below a folder it will not name - neither of which is what the field on
 * the folder line holds. The server is on the same machine as the directories, so
 * it is the only thing here that can answer the question.
 *
 * Read-only, and almost only ever a listing: it reports no sizes and opens no file
 * except a factory's own document, and that only where one is actually sitting. What
 * it says beyond a folder's name is whether a factory is in it, what that factory is
 * called, and whether it is already a tab. All three are worth knowing before you
 * press anything: a second factory cannot be moved onto the first, and finding that
 * out from a listing is better than finding out from an error - while the same folder
 * is exactly where `POST /api/factories/open` will find a factory to reopen, and the
 * factory's name is the only thing in the row that says which factory that is.
 */
interface BrowseEntry {
  name: string;
  path: string;
  /**
   * A factory's document is sitting here.
   *
   * Two things follow from it, which is why one flag carries both: moving another
   * factory onto this folder will be refused, and the factory that lives here can
   * be opened as its own tab.
   */
  factory: boolean;
  /** That factory is already a tab, so opening it would just switch to it. */
  open: boolean;
  /**
   * What that factory is called.
   *
   * The folder name and the factory name are two different things and the folder
   * name is the less useful of them - projects get called `api` and `web` while the
   * factory in them is called something that says what it builds. Absent when the
   * document is there but unreadable, which is why `factory` is a separate flag
   * rather than being inferred from this.
   */
  factoryName?: string;
}

/**
 * What a directory is, as far as factories are concerned.
 *
 * One place for the three answers, because the directory you are standing in and the
 * directories inside it need exactly the same ones, and answering them twice is how
 * the listing and the footer end up disagreeing.
 *
 * A document is opened only when one is actually there, so a listing of ordinary
 * project folders reads nothing: the cost is one small file per factory in view, and
 * a folder with a dozen factories under it is the rare case rather than the usual
 * one.
 */
async function factoryFacts(
  dir: string,
  tabs: Map<string, string>,
): Promise<{ factory: boolean; open: boolean; factoryName?: string }> {
  const asTab = tabs.get(dir);
  if (!existsSync(docPath(dir))) return { factory: false, open: false };
  // An open factory's name comes from the tab, not the file. `open()` writes the
  // registry's name over the document's on load, so the document is the copy that
  // can lag behind a rename - showing it would name the same factory two ways in
  // one window.
  if (asTab !== undefined) return { factory: true, open: true, factoryName: asTab };
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(docPath(dir), 'utf8'));
    const name = isObject(raw) ? raw.name : undefined;
    if (typeof name === 'string' && name.trim().length > 0) {
      return { factory: true, open: false, factoryName: name.trim() };
    }
  } catch {
    // A factory is still there; it just cannot say what it is called. Worth
    // showing as a factory anyway, because the operator may well want to go and
    // find out what happened to it.
  }
  return { factory: true, open: false };
}

async function browse(asked: string | null): Promise<{
  path: string;
  /** The directory above, or null at the root of the filesystem. */
  parent: string | null;
  home: string;
  /**
   * The directory you are standing in holds a factory.
   *
   * Said about this directory and not only about its children because the deepest
   * folder is reachable without a listing of its own - you walk into the project
   * and press the button that says so - and at that point the children are not the
   * question. Without this, the one folder the picker cannot describe is the one
   * you are looking at.
   */
  factory: boolean;
  /** And it is already a tab. */
  open: boolean;
  /** And it is called this. */
  factoryName?: string;
  entries: BrowseEntry[];
  note?: string;
}> {
  const home = os.homedir();

  // A path that is not there is not an error worth showing: it is usually a
  // half-typed one. Walking up to the nearest directory that does exist means
  // browsing from a typed path lands you as close to it as the disk allows.
  let dir = path.resolve(asked === null || asked.trim().length === 0 ? home : asked.trim());
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (!existsSync(dir)) dir = home;

  const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
  // Built once for the whole listing rather than per row: it is the open-tab list,
  // and a hundred children would otherwise walk it a hundred times.
  const tabs = new Map(registry.list().map((r) => [r.baseDir, r.name]));
  const head = { path: dir, parent, home, ...(await factoryFacts(dir, tabs)) };

  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    // An unreadable directory is a normal thing to walk into, so it comes back as
    // itself with nothing in it rather than as a failed request.
    return { ...head, entries: [], note: err instanceof Error ? err.message : String(err) };
  }

  const entries: BrowseEntry[] = [];
  for (const name of names) {
    const child = path.join(dir, name);
    try {
      // `stat`, not `lstat`: a symlink to a directory is a directory you can point
      // a factory at, and refusing it would hide the checkout-under-a-link layout
      // that plenty of people work in.
      if (!(await fsp.stat(child)).isDirectory()) continue;
    } catch {
      // A broken link or something that vanished between readdir and stat.
      continue;
    }
    entries.push({ name, path: child, ...(await factoryFacts(child, tabs)) });
  }

  // Dotted folders last: they are real destinations, but they are not what you are
  // looking for when you are looking for a project.
  entries.sort((a, b) => {
    const dotted = Number(a.name.startsWith('.')) - Number(b.name.startsWith('.'));
    return dotted !== 0 ? dotted : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { ...head, entries };
}

/* ----------------------------------------------------------- a loop's folder */

/**
 * What a loop has written, and the contents of one of those files.
 *
 * A loop is told its own folder and asked to keep its work there, but that is a
 * request rather than a boundary - the agent's cwd is the whole base directory and
 * every tool call is permitted. So this is a window onto the folder a loop is
 * *supposed* to use, which is where its results are in practice, and deliberately
 * not a general file browser: it reads nothing outside that one directory.
 *
 * Read-only. There is no write, no rename and no delete here, because the only
 * thing the panel is for is seeing what came out.
 */

/** Beyond this a file is reported but its text is not sent. */
const FILE_MAX = 2 * 1024 * 1024;

/**
 * Enough of a tree to see what a loop is doing; a runaway loop is not paginated.
 *
 * The walk says when it hit this, and the panel repeats it, so the cap is a
 * visible limit rather than a silent lie about what the project contains. Ten
 * thousand because the panel only renders the folders you have opened: the cost
 * of a bigger list is a walk and a payload, both of which are cheap for a local
 * app, not a render.
 */
const FILE_COUNT_MAX = 10000;

/**
 * Directories the project walk does not enter, by exact name at any depth.
 *
 * Only the project walk: a loop's own folder is small and entirely of the loop's
 * own making, so pruning it would be second-guessing an agent about its own
 * scratch space. The project is the opposite case. `node_modules` alone is tens of
 * thousands of files, so an unfiltered walk spends the whole of FILE_COUNT_MAX
 * inside dependencies and returns a tree with no source in it - the browser would
 * be worse than useless, it would be actively misleading about what the project
 * contains.
 *
 * A fixed list rather than reading `.gitignore`, which is a pattern language with
 * negations and precedence rules, and rather than lazy per-directory loading,
 * which is the right answer for a general browser and a much larger change: the
 * panel builds its tree client-side from one flat list. This is a panel for
 * orientation - see what the loops are building - and for that the list is enough.
 *
 * `.kirofactory` is deliberately absent. It is in the project directory and the
 * operator has every reason to look at the queues from here.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.turbo',
  '.cache',
]);

interface LoopFileEntry {
  /** Path relative to the loop's own folder, always `/`-separated. */
  path: string;
  size: number;
  /** Last write, ISO. Empty when the file vanished between listing and stat. */
  mtime: string;
}

/**
 * Every file under one directory, flattened.
 *
 * Flat rather than nested because the client builds the tree anyway - it has to,
 * since folders open and close there - and a flat list is the shape that survives
 * being sorted three different ways without the server knowing which.
 *
 * Symlinks are skipped outright, both files and directories. A link is the one
 * thing in a directory that can point out of it, and following them would turn a
 * walk of one folder into a walk of the disk and a cycle into a hang. Nothing
 * writes links here, so this costs nothing real.
 */
/**
 * One loop's folder as the panel wants it: the folder's own path, and what is in it.
 *
 * A folder that is not there yet reads as empty rather than missing, because that is
 * what it means - a loop's folder is created by its first turn, so its absence says
 * the loop has not run, not that anything is wrong. Also the answer after a clear,
 * which removes the folder rather than emptying it.
 */
async function listLoopFiles(
  baseDir: string,
  loopId: string,
): Promise<{ dir: string; files: LoopFileEntry[]; truncated: boolean }> {
  const dir = loopDir(loopId);
  const root = path.resolve(baseDir, dir);
  // A read, so nothing is at stake but what it shows - and what it would show for
  // an id that escaped is the project, presented as one loop's scratch space.
  if (!inside(path.join(baseDir, INTERNAL), root)) return { dir, files: [], truncated: false };
  if (!existsSync(root)) return { dir, files: [], truncated: false };
  return { dir, ...(await walkFiles(root)) };
}

/**
 * The project itself, as the same flat listing.
 *
 * The counterpart of `listLoopFiles`, and the reason the panel is no longer only a
 * window onto a loop's scratch space. The loops build a real codebase in the base
 * directory - that is the whole point of the thing - and until now the only way to
 * see what they had built was to leave the app, which is the same gap the loop
 * panel was added to close.
 *
 * `dir` is the absolute base directory rather than a relative path, because there
 * is nothing above it to be relative to and the panel shows the string to say
 * where you are looking.
 *
 * Read-only, and unlike the loop endpoints there is no delete beside it. These are
 * the operator's real source files, not a folder an agent was given to scribble in,
 * and a trash button in a panel meant for looking is not a thing to hand someone
 * by accident. Git is the tool for changing your mind about a project.
 */
async function listProjectFiles(
  baseDir: string,
): Promise<{ dir: string; files: LoopFileEntry[]; truncated: boolean }> {
  if (!existsSync(baseDir)) return { dir: baseDir, files: [], truncated: false };
  return { dir: baseDir, ...(await walkFiles(baseDir, SKIP_DIRS)) };
}

/**
 * `skip` prunes directories by name, and is only passed for the project walk.
 * Absent means walk everything, which is what a loop's own folder wants.
 *
 * `truncated` says the walk stopped at the cap rather than the bottom of the
 * tree. The distinction matters to the reader and only the walk knows it: a list
 * of exactly FILE_COUNT_MAX files could also be a project of exactly that size.
 */
async function walkFiles(
  root: string,
  skip?: Set<string>,
): Promise<{ files: LoopFileEntry[]; truncated: boolean }> {
  const out: LoopFileEntry[] = [];
  let truncated = false;

  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= FILE_COUNT_MAX) {
      truncated = true;
      return;
    }
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable, or gone since its parent was listed. Either way there is
      // nothing here to report and it is not worth failing the request over.
      return;
    }
    for (const entry of names) {
      if (out.length >= FILE_COUNT_MAX) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      /*
       * By name, whatever the entry turns out to be.
       *
       * It used to test directories only, which is wrong for exactly one entry in
       * the list and it is the one that matters: in a linked worktree `.git` is a
       * *file* holding a path to the real git directory, so a worktree's tree
       * listed it while an ordinary checkout did not. Every other name in the set
       * is a directory convention, and a file that happens to be called `dist` is
       * not worth a second branch to keep.
       */
      if (skip?.has(entry.name)) continue;
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          out.push({ path: rel, size: 0, mtime: '' });
        }
      }
    }
  }

  await walk(root, '');
  return { files: out, truncated };
}

/**
 * Resolve a client-supplied relative path inside one directory, or refuse.
 *
 * The containment test compares against `root + sep` rather than `root` alone,
 * which matters more than it looks: a bare prefix check on `…/loops/a` accepts
 * `…/loops/a-evil`, because that string does start with it. Appending the
 * separator is what makes "inside" mean inside.
 *
 * `..` is not screened for specially - it does not need to be, since resolving
 * first and testing the result is exactly what catches it, along with absolute
 * paths and anything else clever.
 */
function resolveInside(root: string, rel: string): string | null {
  if (rel.length === 0) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

/**
 * A `Changes` without its list, so the changes response can name the list `files`.
 *
 * The panel's tree is written against `{ dir, files }` and reads all three sources
 * through it, so the changes endpoint answers in that shape rather than inventing a
 * third. Everything else `Changes` carries - the range, what it compared against,
 * why the list is empty - travels alongside, and this is what keeps the array from
 * being serialised twice under two names.
 */
function withoutEntries(found: git.Changes): Omit<git.Changes, 'entries'> {
  const { entries: _entries, ...rest } = found;
  return rest;
}

/* -------------------------------------------------------------- http utils */

/**
 * Read a JSON request body.
 *
 * `setEncoding` makes the stream yield strings rather than Buffers, which is both
 * simpler and avoids a real typing trap: across @types/node versions `Buffer`
 * became generic over its backing store, so `Buffer.concat` wants
 * `Uint8Array<ArrayBuffer>` and a plain `Buffer[]` no longer satisfies it. The
 * body is text, so there is no reason to assemble bytes and decode them by hand.
 *
 * A multi-byte character split across two chunks is handled: the stream decodes
 * through a StringDecoder that holds the partial sequence back.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  req.setEncoding('utf8');
  let text = '';
  for await (const chunk of req) text += chunk;
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Cap on a file dropped into the panel. Bigger than `FILE_MAX` on purpose - a file
 * can be worth copying in without being worth rendering - but bounded, because an
 * unbounded upload buffered in memory is a way to fall over.
 */
const UPLOAD_MAX = 20 * 1024 * 1024;

/**
 * Read a request body as bytes, or null when it exceeds `UPLOAD_MAX`.
 *
 * Decoded through latin1 rather than assembled with `Buffer.concat`, sidestepping
 * the generic-`Buffer` typing trap described on `readBody`: latin1 maps every byte
 * to one code unit and back, so the round trip is lossless for arbitrary binary.
 */
async function readBytes(req: IncomingMessage): Promise<Buffer | null> {
  req.setEncoding('latin1');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > UPLOAD_MAX) return null;
  }
  return Buffer.from(text, 'latin1');
}

/* ------------------------------------------------------------- the front gate */

/**
 * The header the web app sends with every request that changes something.
 *
 * Its value is irrelevant and it carries no secret. What matters is that a page
 * cannot set a header of its own choosing on a cross-origin request without the
 * browser first asking permission with a preflight, and this server answers no
 * preflight and sends no `Access-Control-Allow-*` header, so permission is never
 * given. A request that arrives carrying this header therefore came from something
 * that was allowed to set it: our own page, or a deliberate client like `curl`.
 *
 * This is the same trick as a CSRF token minus the bookkeeping, and it is what the
 * content-type test in the usual recipe is really reaching for. Content type does
 * not work here: two routes take a dropped file as a raw body with whatever type it
 * happens to be, and the bodyless `POST`s - start a loop, stop it, branch off - send
 * no content type at all, which are precisely the requests worth protecting.
 */
const GUARD_HEADER = 'x-kirofactory';

/**
 * This run's token, and the placeholder the served page carries it in.
 *
 * New every start, kept only in memory, never on disk. The page gets it because
 * `serveStatic` writes it into `index.html` on the way out, so the only way to hold
 * it is to have been served by this process.
 *
 * The header alone already stops a browser page, since a page cannot set it
 * cross-origin. What the token adds is the caller a header cannot speak for: another
 * process on this machine, which can set any header it likes and would otherwise be
 * free to drive the API. A different user's account on a shared host, an install
 * script, anything that got itself run. It cannot guess sixteen random bytes.
 *
 * Only asked of requests that change something. A `GET` cannot be made to carry it
 * anyway - the export link is an `href` and the event stream is an `EventSource`,
 * neither of which can set a header - and the alternative of a token in the query
 * string puts it in shell history and logs to buy very little: a process running as
 * this user can read the files this server would have read to them. The residual is
 * a different user on a shared host reading through the API, and that is worth
 * stating rather than papering over with a query parameter.
 */
const TOKEN = randomBytes(16).toString('hex');
const TOKEN_SLOT = '__KIROFACTORY_TOKEN__';

/**
 * Constant-time comparison, on a value that arrived as a header.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so the
 * length is checked first; that leaks the length of a token whose length is a
 * constant of the program, which is not a secret.
 */
function tokenMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Loopback, as an `Origin` or `Host` header names it. */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Refuse anything that a page somewhere else could have caused, and anything that
 * did not arrive at this machine under a name that means this machine.
 *
 * There is no authentication here, and adding some would not be enough on its own:
 * the browser sends the operator's cookies and credentials for them, so "the request
 * is authenticated" and "the operator meant to make it" are different questions.
 * This gate answers the second one, and it is the one that matters when a loop can
 * be started - with shell, write and delete - by a single cross-origin `POST`.
 *
 * Three independent tests, because each covers a hole the others leave:
 *
 * - **`Host`** must name loopback. A browser resolving `evil.example` to `127.0.0.1`
 *   (DNS rebinding) sends requests that look same-origin to itself and would read
 *   the responses back; what it cannot do is change the `Host` it sends.
 * - **`Origin`**, when there is one, must be loopback. This is the direct test, and
 *   browsers attach it to exactly the requests we care about.
 * - **`Sec-Fetch-Site`**, when there is one, must be this site or no site at all.
 *   It catches what `Origin` misses: a form post or an `<img>` naming a URL, where
 *   the browser tells us the request is cross-site while sending no `Origin`.
 *
 * Absent headers pass, deliberately. `curl` sends none of these, and a local tool
 * with a local HTTP API should stay usable from a terminal; the mutating-verb rule
 * below is what stops that leniency from being a hole, since a browser page cannot
 * produce the header it asks for.
 *
 * When `KIROFACTORY_ALLOW_REMOTE=1` the operator has said this server is reachable
 * from elsewhere on purpose, so `Host` and `Origin` will legitimately name something
 * other than loopback and testing them against it would only break the thing they
 * asked for. The header requirement still stands - it is what keeps a hostile page
 * from driving the API even then.
 *
 * Returns a message when the request is refused, or null to let it through.
 */
function refuse(req: IncomingMessage, method: string): { status: number; error: string } | null {
  const remoteAllowed = process.env.KIROFACTORY_ALLOW_REMOTE === '1';

  if (!remoteAllowed) {
    const host = req.headers.host ?? '';
    // Split off the port rather than parsing: an IPv6 host arrives bracketed, so
    // the last colon is the port separator and the ones inside are the address.
    const named = host.replace(/:\d+$/, '');
    if (named.length === 0 || !isLoopbackHostname(named)) {
      return { status: 403, error: 'unexpected Host header' };
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null' && !isLoopbackOrigin(origin)) {
      return { status: 403, error: 'cross-origin requests are refused' };
    }
  }

  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return { status: 403, error: 'cross-site requests are refused' };
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const given = req.headers[GUARD_HEADER];
    if (typeof given !== 'string' || !tokenMatches(given)) {
      /*
       * 401 rather than 403, and the distinction carries weight rather than being a
       * nicety: the page reads it as "your token is from a previous run of this
       * server" and reloads itself once to be served the current one. Restarting the
       * server otherwise leaves every open tab looking alive - the event stream
       * reconnects on its own - while every button quietly fails.
       *
       * No `WWW-Authenticate`: there is no scheme to name and nothing for a user to
       * type. The remedy is to be handed the token, not to know a password.
       */
      return { status: 401, error: `a state-changing request must carry a valid ${GUARD_HEADER} header` };
    }
  }

  return null;
}

/**
 * Every JSON answer, and every one of them uncacheable.
 *
 * Almost everything this API returns is a reading of the filesystem or of a
 * runner's state right now - queue depths, status, file listings - and the canvas
 * polls several of them every second or two. A browser that reuses a GET
 * response it was given no caching instructions for (Safari does) shows a queue
 * stuck at yesterday's count until a hard reload, with the poll running and
 * every request served from its own cache. The page itself is already served
 * `no-store` for the same reason; the API it calls has to be too.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A file name a factory can be saved as. */
function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'factory';
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Serve the built web app. Unknown paths fall back to index.html. */
async function serveStatic(url: string, res: ServerResponse): Promise<void> {
  if (!existsSync(WEB_DIST)) {
    json(res, 503, { error: 'the web app is not built yet: run `npm run build`' });
    return;
  }
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  // Contained by the same helper every other path-taking route uses. A bare prefix
  // test would do here in practice, since `path.join` normalises `..` away before it
  // is looked at - but it accepts a sibling directory whose name merely starts with
  // `dist`, and having one containment rule in the codebase is worth more than the
  // argument for why this particular use of a weaker one happens to be safe.
  const target = resolveInside(WEB_DIST, rel);
  const file = target !== null && existsSync(target) && (await fsp.stat(target)).isFile()
    ? target
    : path.join(WEB_DIST, 'index.html');
  /*
   * The document is where this run's token is handed over, so it is rewritten on the
   * way out rather than served as it sits on disk. That also makes it the one file
   * here that must never be cached: a page restored from cache after a restart would
   * hold a token this process has never heard of, and would have to discover that by
   * failing. Everything else in `dist` is content-hashed and cacheable as usual.
   *
   * A build without the placeholder is served unchanged rather than refused - the
   * substitution is a string replace, and a missing slot means an old bundle, which
   * the page then reports as a token it does not have instead of dying here.
   */
  if (file.endsWith('index.html')) {
    const page = (await fsp.readFile(file, 'utf8')).replace(TOKEN_SLOT, TOKEN);
    res.writeHead(200, {
      'content-type': MIME['.html'] as string,
      'cache-control': 'no-store',
    });
    res.end(page);
    return;
  }
  const body = await fsp.readFile(file);
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

/* ------------------------------------------------------------------ routing */

const server = createServer(async (req, res) => {
  const [url = '/', search = ''] = (req.url ?? '/').split('?');
  const query = new URLSearchParams(search);
  const method = req.method ?? 'GET';

  // Before any route, and before the body is read. Applied to the static bundle as
  // well as the API: there is no reason for another site to be pulling our page
  // apart, and one gate over everything is easier to be sure of than two.
  const refused = refuse(req, method);
  if (refused !== null) return json(res, refused.status, { error: refused.error });

  try {
    if (url === '/api/defaults' && method === 'GET') {
      // `baseDir` is the directory new factories are created *under*, one folder
      // each - not a path any factory has. It was a single shared default once,
      // which is what the singular name is left over from.
      return json(res, 200, { baseDir: AUTO_BASE, internal: INTERNAL, driver: driver.name });
    }

    /*
     * `?retry=yes` asks for another probe after a failure, rather than the failure
     * already on file. The picker's retry sends it; an ordinary page load does not,
     * so opening five tabs after a failure costs one probe, not five.
     */
    if (url === '/api/models' && method === 'GET') {
      return json(res, 200, await modelCatalog(query.get('retry') === 'yes'));
    }

    if (url === '/api/browse' && method === 'GET') {
      return json(res, 200, await browse(query.get('path')));
    }

    /*
     * What a new loop starts out allowed to use. Per operator rather than per
     * factory, so it sits up here with the other machine-wide answers rather than
     * under a factory id - see grants.ts for why that is the right scope.
     */
    if (url === '/api/grants' && method === 'GET') {
      return json(res, 200, resolveGrants(await readGrants(GRANTS_FILE)));
    }

    /*
     * One axis per request, because the panel offers them separately: the button
     * under the MCP list says nothing about tools. `null` is the operator choosing
     * "all of them", which is a decision and is stored as one - see `Grant`.
     */
    if (url === '/api/grants' && method === 'PUT') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected an object' });
      const axis = body.axis;
      if (axis !== 'tools' && axis !== 'mcp') {
        return json(res, 400, { error: 'expected axis to be tools or mcp' });
      }
      const value = body.value;
      if (value !== null && !Array.isArray(value)) {
        return json(res, 400, { error: 'expected value to be a list of names, or null for all' });
      }
      const names = value === null ? null : value.filter((v): v is string => typeof v === 'string');
      return json(res, 200, await saveGrantAxis(GRANTS_FILE, axis, names));
    }

    /* ---------------------------------------------------------- the library */

    /*
     * Not scoped to a factory: the library is one collection shared by all of
     * them, living in the repository rather than in any factory's directory.
     */
    if (url === '/api/library' && method === 'GET') return json(res, 200, await library.list());

    if (url === '/api/library/loops' && method === 'POST') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected a loop' });
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      // A loop is its prompt, so an empty one is not a loop worth keeping and
      // saving it would put a file in the repository that says nothing.
      if (prompt.trim().length === 0) {
        return json(res, 400, { error: 'a loop with an empty prompt has nothing to share' });
      }
      const entry = await library.addLoop({
        name: typeof body.name === 'string' ? body.name : '',
        prompt,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.author === 'string' ? { author: body.author } : {}),
        // Passed through rather than checked here: `library.addLoop` normalises it,
        // so the shape of a cluster is decided in one place whether it arrives from
        // this route or from a file somebody committed.
        ...(body.cluster !== undefined ? { cluster: body.cluster } : {}),
      });
      return json(res, 201, entry);
    }

    /*
     * Keep a whole factory: its loops, its wires and its parameters.
     *
     * The graph arrives in the body rather than being read out of the open factory by
     * id, because what should be shared is what is on the canvas - which is what the
     * client is holding. `library.addFactory` normalises it through the document parse
     * before writing, so a post cannot put anything in the repository that the reader
     * would not give back.
     */
    if (url === '/api/library/factories' && method === 'POST') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected a factory' });
      const loops = Array.isArray(body.loops) ? body.loops : [];
      // A factory is its loops. An empty canvas is not a design worth a file.
      if (loops.length === 0) {
        return json(res, 400, { error: 'a factory with no loops has nothing to share' });
      }
      const entry = await library.addFactory(
        {
          name: typeof body.name === 'string' ? body.name : '',
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.author === 'string' ? { author: body.author } : {}),
          loops: body.loops,
          wires: body.wires,
          parameters: body.parameters,
        },
        body.overwrite === true,
      );
      // A name already in the library is the person's call, not the server's: 409
      // with `conflict` set, and the client asks whether to replace. Posting again
      // with `overwrite: true` is the yes; not posting again is the no.
      if ('conflict' in entry) {
        return json(res, 409, {
          error: `"${entry.conflict}" is already in the library`,
          conflict: true,
        });
      }
      return json(res, 201, entry);
    }

    /*
     * Take a factory out of the library: a new tab, wired as the entry describes.
     *
     * A new factory rather than a restored one, which is what separates this from
     * `/api/factories/open` and from Import. Both of those recover a factory that
     * already existed and keep its id so it is the same factory; an entry is a
     * template, and every take-out is a different factory that happens to share a
     * design. So the id is minted here and the entry carries none.
     *
     * The loops keep the ids the entry gave them, because the wires are matched by
     * them and a fresh factory has nothing for them to collide with - loop ids are
     * scoped to the factory that holds them, so two factories from one entry can
     * carry the same ones without ever meeting. Remapping would be work with no
     * question behind it.
     *
     * `baseDir` is the one thing the entry cannot supply. Given one, that is where it
     * lands; without one it gets a directory of its own under the app, the same as any
     * factory created without a folder in mind.
     */
    const takeOut = /^\/api\/library\/factories\/([^/]+)\/open$/.exec(url);
    if (takeOut && method === 'POST') {
      const entry = await library.factoryBySlug(decodeURIComponent(takeOut[1]!));
      if (!entry) return json(res, 404, { error: 'no such factory in the library' });

      const body = await readBody(req);
      const wanted = isObject(body) ? body : {};
      const id = newFactoryId();
      const name =
        typeof wanted.name === 'string' && wanted.name.trim().length > 0
          ? wanted.name.trim()
          : entry.name;
      const asked =
        typeof wanted.baseDir === 'string' && wanted.baseDir.trim().length > 0
          ? wanted.baseDir.trim()
          : ownBaseDir(id);
      const baseDir = await pickBaseDir(asked, id);

      await save(
        parse(
          {
            id,
            name,
            baseDir,
            loops: entry.loops,
            wires: entry.wires,
            ...(entry.parameters !== undefined ? { parameters: entry.parameters } : {}),
          },
          { id, name, baseDir },
        ),
      );
      const ref = await registry.put({ id, name, baseDir });
      const host = await open(ref);
      send('factories', registry.list());
      return json(res, 201, { factory: host.doc() });
    }

    /* ------------------------------------------------------- the collection */

    if (url === '/api/factories' && method === 'GET') return json(res, 200, registry.list());

    /*
     * Every factory this installation has seen, whether or not it is a tab.
     *
     * Its own endpoint rather than a flag on the collection: the tab strip asks for
     * the open ones constantly and over the event stream, and the history is asked
     * for once, when the operator goes looking for something they closed. Array
     * order is carried through as it stands, most recently a tab first, so the
     * caller does not have to sort and cannot disagree with the strip about which
     * factory was touched last.
     *
     * Declared here, above the `/api/factories/:f` match further down, because that
     * pattern would otherwise read `known` as a factory id.
     */
    if (url === '/api/factories/known' && method === 'GET') return json(res, 200, registry.listAll());

    /*
     * Go and look for factories the registry has forgotten.
     *
     * POST, not GET: it walks the home directory and then writes what it found into
     * the registry. The walk itself is in scan.ts, including why it cannot be
     * Spotlight and what it refuses to descend into; this is only what happens to
     * the results.
     *
     * Blocking, with no progress reporting. The pruned walk is seconds, and every
     * alternative - an event stream, a job id to poll, a background index kept warm
     * - is machinery for a wait that does not need managing. The client shows a
     * spinner and gets one answer.
     *
     * Four outcomes per factory found, and the order they are tested in is the whole
     * logic:
     *
     * 1. **Its directory is already registered** - nothing to do, and specifically
     *    nothing to correct. The registry entry is the operator's: they may have
     *    renamed the tab, or closed it on purpose, and a scan is not a reason to
     *    overwrite either. Reported as `skipped` so the count still adds up.
     *
     *    This test coming first is also what makes a repeat scan a no-op. The copy
     *    rule below deliberately registers a directory under an id its document does
     *    not carry, so matching on the path rather than the id is what stops the next
     *    scan minting a third one for the same folder.
     *
     * 2. **Nothing known about it** - the ordinary find. Registered as it stands,
     *    keeping the id in its document, which is what makes it the same factory it
     *    always was rather than a new one that happens to be in its folder.
     *
     * 3. **Its id is known, and the directory that id is registered at no longer
     *    holds a document** - the factory moved. The entry is pointed at the new
     *    place, keeping one factory with one id and its history intact. Reported as
     *    `updated`.
     *
     * 4. **Its id is known and that other directory still holds a factory** - both
     *    exist, so this is a copy: an export, a duplicated folder, a `workspaces/`
     *    backup. Two directories cannot share an id because the registry keys on it,
     *    so the copy is registered under a fresh one. `open` writes the registry's id
     *    into the document when the tab is opened, so the two stop disagreeing the
     *    moment anybody looks at it.
     *
     * Everything registered lands closed and appended - see `Registry.adopt`. That is
     * why nothing is broadcast from here: `list()` is the tab strip and none of this
     * changes it. A scan that opened twelve tabs, or reordered the strip on the way
     * past, would be a worse outcome than the lost factories it set out to find.
     */
    if (url === '/api/factories/scan' && method === 'POST') {
      if (scanning) {
        return json(res, 409, { error: 'A scan is already running. Give it a moment.' });
      }
      scanning = true;
      try {
        const found = await scanForFactories(os.homedir());
        const added: FactoryRef[] = [];
        const updated: FactoryRef[] = [];
        const skipped: FactoryRef[] = [];

        // Sequential on purpose, not `Promise.all`: each decision is made against the
        // registry as the previous one left it. Two copies of one factory found in the
        // same pass rely on it - the first takes the id, and the second can only see
        // that it is taken if the first has already been written.
        for (const hit of found) {
          const here = registry.listAll().find((r) => r.baseDir === hit.dir);
          if (here !== undefined) {
            skipped.push(here);
            continue;
          }
          const known = registry.get(hit.id);
          if (known === undefined) {
            added.push(await registry.adopt({ id: hit.id, name: hit.name, baseDir: hit.dir }));
          } else if (!existsSync(docPath(known.baseDir))) {
            const moved = await registry.relocate(hit.id, hit.dir);
            if (moved !== undefined) updated.push(moved);
          } else {
            added.push(await registry.adopt({ id: newFactoryId(), name: hit.name, baseDir: hit.dir }));
          }
        }

        return json(res, 200, { found: found.length, added, updated, skipped });
      } finally {
        // In a `finally` so a walk that threw halfway does not leave the guard set and
        // the button dead until the server restarts.
        scanning = false;
      }
    }

    if (url === '/api/factories' && method === 'POST') {
      const body = await readBody(req);
      const wanted = isObject(body) ? body : {};
      const id = newFactoryId();
      const name =
        typeof wanted.name === 'string' && wanted.name.trim().length > 0
          ? wanted.name.trim()
          : `Factory ${registry.list().length + 1}`;
      const asked =
        typeof wanted.baseDir === 'string' && wanted.baseDir.trim().length > 0
          ? wanted.baseDir.trim()
          : ownBaseDir(id);
      const ref = await registry.put({ id, name, baseDir: await pickBaseDir(asked, id) });
      const host = await open(ref);
      send('factories', registry.list());
      return json(res, 201, host.doc());
    }

    if (url === '/api/factories/import' && method === 'POST') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected a factory document' });

      // The document's own id is kept when nothing open is using it, so
      // re-importing the same file restores that factory rather than piling up
      // copies of it, including one that was closed since.
      const own = typeof body.id === 'string' ? body.id : undefined;
      const id = own !== undefined && idFree(own) ? own : newFactoryId();
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'Imported factory';

      // `baseDir` travels in the file, but it is a path on whichever machine wrote
      // it. So it is a hint: used when the directory is actually there, and
      // replaced by the default when it is not.
      const hinted =
        typeof body.baseDir === 'string' && body.baseDir.trim().length > 0
          ? path.resolve(body.baseDir.trim())
          : undefined;
      const usable = hinted !== undefined && existsSync(hinted);
      const baseDir = await pickBaseDir(usable ? hinted! : ownBaseDir(id), id);

      // Parsed before anything is registered or written, so an import that is
      // refused leaves no tab and no directory behind it.
      let imported: Factory;
      try {
        imported = parse({ ...body, id, name, baseDir }, { id, name, baseDir });
      } catch (err) {
        if (err instanceof DocumentError) return json(res, 422, { error: err.message });
        throw err;
      }
      await save(imported);
      const ref = await registry.put({ id, name, baseDir });
      const host = await open(ref);
      send('factories', registry.list());
      return json(res, 201, {
        factory: host.doc(),
        ...(hinted !== undefined && !usable
          ? {
              note:
                `The folder that file names is not on this machine, so the factory ` +
                `was placed in ${baseDir}`,
            }
          : {}),
      });
    }

    /*
     * Open the factory that is already in a directory.
     *
     * The counterpart of closing a tab. Closing leaves everything on disk -
     * document, queues, whatever the loops wrote - and until now the only way back
     * to it was the JSON that Export writes, which meant a factory you had never
     * exported was closed for good even though all of it was still sitting there.
     * A directory is the more honest handle anyway: it is where the factory
     * actually is, and `/api/browse` already says which folders hold one.
     *
     * The difference from `POST /api/factories`, which will also take a `baseDir`:
     * that one mints a new id and a new name and is therefore a *new* factory that
     * happens to land in a folder. This keeps the document's own id and name, so
     * what comes back is the factory that was closed rather than a stranger
     * wearing its wires.
     */
    if (url === '/api/factories/open' && method === 'POST') {
      const body = await readBody(req);
      const asked = isObject(body) && typeof body.baseDir === 'string' ? body.baseDir.trim() : '';
      if (asked.length === 0) return json(res, 400, { error: 'expected a directory' });
      const baseDir = path.resolve(asked);

      /*
       * Already known: this directory has an entry, open or closed.
       *
       * `listAll`, not `list`, and that is the point of the whole feature: a closed
       * factory still has its entry, and finding it here is what makes reopening the
       * directory bring that factory back rather than mint a second one for the same
       * document. Open-only would leave the closed entry stranded and the registry
       * with two rows for one folder.
       *
       * Open and live is answered on the spot. Opening something that is open is not
       * a mistake worth an error: the operator wants to be looking at that factory,
       * and it exists, so the request is answered by saying which one it is.
       */
      const already = registry.listAll().find((r) => r.baseDir === baseDir);
      const live = already ? hosts.get(already.id) : undefined;
      if (already && live) {
        return json(res, 200, {
          factory: live.doc(),
          note: `${already.name} is already open in this directory.`,
        });
      }

      const doc = docPath(baseDir);
      if (!existsSync(doc)) {
        // What went wrong first, the path last: this lands in a one-line slot in the
        // toolbar, and a leading absolute path fills it without saying anything.
        return json(res, 404, {
          error:
            `No factory in that folder - there is no ${path.relative(baseDir, doc)} ` +
            `in it. Looked in ${baseDir}`,
        });
      }

      let raw: Record<string, unknown>;
      try {
        const text: unknown = JSON.parse(await fsp.readFile(doc, 'utf8'));
        if (!isObject(text)) throw new Error('the document is not an object');
        raw = text;
      } catch (err) {
        // Distinguished from "no factory here": a folder with a broken document in
        // it is a different problem from a folder with nothing in it, and telling
        // the operator it is empty would send them looking in the wrong place.
        return json(res, 422, {
          error:
            `The factory document in that folder cannot be read: ` +
            `${err instanceof Error ? err.message : String(err)} - ${doc}`,
        });
      }

      /*
       * The document's id is kept, unless another open tab is already using it -
       * two directories holding copies of the same document, which is the same
       * collision Import resolves the same way. A known entry for this directory
       * wins outright: whether it is closed, or open but without a host because the
       * tab failed to open, its id is reused to bring that factory back rather than
       * left behind as a second entry pointing here.
       */
      const own = typeof raw.id === 'string' ? raw.id : undefined;
      const id =
        already?.id ?? (own !== undefined && idFree(own) ? own : newFactoryId());
      const name =
        typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : 'Factory';

      // The `baseDir` in the document is a path on whichever machine wrote it. The
      // directory we were handed is the one that is demonstrably there.
      let opened: Factory;
      try {
        opened = parse({ ...raw, id, name, baseDir }, { id, name, baseDir });
      } catch (err) {
        // The same answer the unparseable file gets above: the folder holds a
        // document, and the document is the problem.
        if (err instanceof DocumentError) return json(res, 422, { error: err.message });
        throw err;
      }
      await save(opened);
      const ref = await registry.put({ id, name, baseDir });
      const host = await open(ref);
      send('factories', registry.list());
      return json(res, 201, {
        factory: host.doc(),
        ...(own !== undefined && own !== id
          ? {
              note:
                `Another open factory already had the id in that document, so this one ` +
                `opened with a new id. They are now two factories.`,
            }
          : {}),
      });
    }

    if (url === '/api/factories/order' && method === 'PUT') {
      const body = await readBody(req);
      const ids = isObject(body) && Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : [];
      await registry.reorder(ids);
      // The registry's own return value is everything it knows, closed entries
      // included - the right shape for persistence, the wrong one for a tab strip.
      // Answer with the open list, the same thing `GET /api/factories` says, and
      // tell the other windows, which follow the strip over SSE like every other
      // mutation here.
      send('factories', registry.list());
      return json(res, 200, registry.list());
    }

    /* --------------------------------------------------------- one factory */

    const scoped = /^\/api\/factories\/([^/]+)(\/.*)?$/.exec(url);
    if (scoped) {
      const id = decodeURIComponent(scoped[1]!);
      const rest = scoped[2] ?? '';
      const host = hosts.get(id);
      if (!host) return json(res, 404, { error: 'no such factory' });

      if (rest === '' && method === 'GET') return json(res, 200, host.doc());

      if (rest === '' && method === 'PUT') {
        try {
          return json(res, 200, await host.replace(await readBody(req)));
        } catch (err) {
          // Two refusals the canvas has to be able to tell apart from a crash: a
          // document it may not save (an id that would escape the factory), and a
          // document it may not save *yet* (a mode switch under a running loop).
          if (err instanceof DocumentError) return json(res, 400, { error: err.message });
          if (err instanceof ConflictError) return json(res, 409, { error: err.message });
          throw err;
        }
      }

      if (rest === '' && method === 'PATCH') {
        const body = await readBody(req);
        if (!isObject(body)) return json(res, 400, { error: 'expected an object' });
        let doc = host.doc();
        if (typeof body.name === 'string' && body.name.trim().length > 0) {
          doc = await host.rename(body.name.trim());
        }
        if (typeof body.baseDir === 'string' && body.baseDir.trim().length > 0) {
          try {
            doc = await host.setBaseDir(body.baseDir.trim());
          } catch (err) {
            return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        await registry.put(host.ref());
        send('factories', registry.list());
        return json(res, 200, doc);
      }

      if (rest === '' && method === 'DELETE') {
        /*
         * `?files=yes` turns the close into a delete: the factory's own data -
         * `<baseDir>/.kirofactory`, which is the only place this program writes -
         * goes with the tab. Never anything else in the base directory: a
         * factory pointed at a real project owns its dot-folder there, not the
         * project. `force` because a factory that never ran has no folder, and
         * deleting it should not fail over that.
         *
         * That is also the difference in the registry. A close flips the entry to
         * `open: false` and leaves it where it is, so the factory can be offered
         * back by name later; a delete removes the entry, because the document it
         * pointed at is about to stop existing and there would be nothing to
         * reopen. Both dispose the host either way. Closed or deleted, it is no
         * longer running.
         */
        const wipe = query.get('files') === 'yes';
        const baseDir = host.doc().baseDir;
        await host.dispose();
        hosts.delete(id);
        if (wipe) {
          await registry.remove(id);
          await fsp.rm(path.join(baseDir, INTERNAL), { recursive: true, force: true });
        } else {
          await registry.close(id);
        }
        send('factories', registry.list());
        return json(res, 200, registry.list());
      }

      if (rest === '/export' && method === 'GET') {
        /*
         * Without `baseDir`. An export is a document meant to leave the machine,
         * and the base directory is a path on it - typically `/Users/<name>/...`,
         * which is the operator's login handed to whoever receives the file. The
         * import side never needed it: it uses the directory only as a hint when
         * that exact path exists on the importing machine, and otherwise gives the
         * factory a directory of its own, which is what a shared document should
         * get anyway. `parse` fills an absent `baseDir` from its defaults, so the
         * file imports as before. The library save has dropped the field for the
         * same reason since it existed; this route was the one that had not.
         */
        const { baseDir: _omitted, ...portable } = host.doc();
        const text = `${JSON.stringify(portable, null, 2)}\n`;
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="${slug(host.doc().name)}.kirofactory.json"`,
          'content-length': Buffer.byteLength(text),
        });
        return res.end(text);
      }

      if (rest === '/status' && method === 'GET') return json(res, 200, host.statusAll());

      if (rest === '/queues' && method === 'GET') return json(res, 200, await host.queueCounts());

      if (rest === '/mcp' && method === 'GET') return json(res, 200, await host.mcpServers());

      /*
       * Skills and steering files a prompt here can name.
       *
       * Beside `/mcp` and shaped like it, because the three lists answer the same
       * question about three kinds of thing: what can this factory's prompts refer
       * to. One route rather than two because the panel wants both in the same
       * effect and neither is worth a round trip of its own.
       */
      if (rest === '/resources' && method === 'GET') return json(res, 200, await host.resources());

      /*
       * What git makes of the directory the loops run in.
       *
       * The directory bar shows this, and the changes view is only offered when it
       * says there is a repository - see `GitState` for the three answers and why
       * they are the ones that matter. Read-only and cheap enough to be asked
       * whenever the bar or the panel wants it, which is what keeps the state
       * derived from the filesystem rather than stored on the document: a factory
       * in a worktree is not a factory in a mode, it is a factory whose directory
       * happens to be one, and there is nothing to keep in step.
       *
       * That rule holds for the factory and deliberately stops there. A *loop's*
       * checkout cannot be re-derived - `freeDir` and `freeBranch` append `-2` on
       * collision, so the path is not a function of the key - which is why
       * per-session checkouts live in the worktrees.json sidecar instead. See
       * worktrees.ts for that boundary.
       */
      if (rest === '/git' && method === 'GET') {
        return json(res, 200, await git.inspect(host.doc().baseDir));
      }

      /*
       * Give this factory a checkout and a branch of its own.
       *
       * Two steps that have to happen together: `addWorktree` makes the worktree,
       * and `setBaseDir` is what actually moves the factory into it - stopping the
       * loops first, creating the internals folder, re-preparing the queues. The
       * second is the existing move, unchanged, which is the whole reason this is a
       * small feature: a worktree factory is one whose `baseDir` is a worktree.
       *
       * Nothing is written to the document beyond the directory, and nothing here
       * removes a worktree - the factory-level checkout holds the queues, so
       * deleting one deletes work. See `addWorktree`.
       *
       * This is the factory-level branch-off only. Per-session checkouts - a
       * worktree per loop, or per cluster member - are the `worktree` field on
       * `Loop`, provisioned by `Host.startLoop` and released by the per-loop
       * DELETE below. Two features, one mechanism.
       */
      if (rest === '/worktree' && method === 'POST') {
        if (host.anyRunning()) {
          return json(res, 409, {
            error: 'stop the loops first. Branching off moves the factory, and a turn in flight would finish into the directory it left.',
          });
        }
        let added;
        try {
          added = await git.addWorktree(host.doc().baseDir, host.doc().name);
        } catch (err) {
          return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
        /*
         * The loops' checkouts come along. The sidecar stays behind with the
         * old `.kirofactory` like everything else there, but unlike the queues
         * its contents are still true after this particular move: a branch-off
         * stays inside one repository, so every loop checkout it names is
         * still a worktree of the factory's own repository, wherever the
         * factory's directory now is. Read before the move, adopted after it -
         * without this, branching off orphaned every loop checkout and the
         * next start quietly provisioned a duplicate set.
         */
        const carried = await readSessions(host.doc().baseDir);
        try {
          const doc = await host.setBaseDir(added.dir);
          if (Object.keys(carried).length > 0) await host.adoptWorktrees(carried);
          await registry.put(host.ref());
          send('factories', registry.list());
          return json(res, 200, { factory: doc, branch: added.branch, dir: added.dir });
        } catch (err) {
          // The worktree exists but the factory could not move onto it, which is
          // worth saying plainly: the directory is on disk and is not cleaned up,
          // because deleting a checkout to tidy up after a failed move is a worse
          // outcome than leaving one behind.
          return json(res, 409, {
            error: `${added.dir} was created but the factory could not move into it: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      }

      /*
       * What the loops have changed in the project, and one of those files in full.
       *
       * The same two shapes as `/files` and `/file` above, deliberately, so the
       * panel renders a changes tree from the code path that already renders the
       * other two. The difference is what fills the list: git rather than a folder
       * walk, and a status letter per row.
       */
      if (rest === '/changes' && method === 'GET') {
        const range = query.get('range') === 'branch' ? 'branch' : 'uncommitted';
        const baseDir = host.doc().baseDir;
        const [state, found] = await Promise.all([
          git.inspect(baseDir),
          git.changes(baseDir, range),
        ]);
        // `dir` and `files` are named as the file panel names them, so one component
        // reads all three sources. `git` rides along because the panel is already
        // asking and a second request for the same three subprocesses would be waste.
        return json(res, 200, { dir: baseDir, files: found.entries, git: state, ...withoutEntries(found) });
      }

      if (rest === '/diff' && method === 'GET') {
        const asked = query.get('path');
        if (asked === null) return json(res, 400, { error: 'path required' });
        const range = query.get('range') === 'branch' ? 'branch' : 'uncommitted';
        const root = path.resolve(host.doc().baseDir);
        // Containment before git sees it, exactly as `/file` does. A path that
        // resolves outside the base directory is refused rather than handed to a
        // subprocess that would happily read it.
        if (resolveInside(root, asked) === null) {
          return json(res, 403, { error: 'outside the project' });
        }
        return json(res, 200, await git.fileDiff(root, asked, range));
      }

      /*
       * One component's checkouts, and the way to be rid of them.
       *
       * `:l` is a loop id here - releasing is per component, never per member,
       * because releasing eleven of sixteen leaves a cluster the next start
       * silently repairs by provisioning the missing five. The GET answers from
       * the sidecar, which is the only record there is: a checkout's path is not
       * derivable from its key. The DELETE goes through git without `--force`,
       * so a checkout with uncommitted changes refuses and is reported in
       * `failures` rather than lost; branches are never deleted.
       */
      /*
       * Every checkout the factory has, labelled. The file panel's worktree
       * dropdown is the caller: a factory of ten worktree loops is ten places
       * the work might be, and the main directory shows none of it.
       */
      if (rest === '/worktrees' && method === 'GET') {
        return json(res, 200, { sessions: host.worktreesAll() });
      }

      const loopWorktree = /^\/loops\/([^/]+)\/worktree$/.exec(rest);
      if (loopWorktree && method === 'GET') {
        return json(res, 200, { sessions: host.worktreesOf(decodeURIComponent(loopWorktree[1]!)) });
      }
      if (loopWorktree && method === 'DELETE') {
        const loopId = decodeURIComponent(loopWorktree[1]!);
        try {
          const released = await host.releaseWorktrees(loopId);
          // The panel asked about one component, so the map in the answer is
          // that component's - the sidecar holds every loop's checkouts and the
          // others are not this caller's business.
          return json(res, 200, { ...released, sessions: host.worktreesOf(loopId) });
        } catch (err) {
          return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      /*
       * What one session changed in its own checkout, and one of those files in
       * full - the per-session mirror of `/changes` and `/diff` above, answering
       * in the same `{ dir, files, git }` shape so the panel's tree component is
       * reused a fourth time.
       *
       * `:l` carries a runner key rather than a loop id, which needs no route
       * change: `#` survives a URL as `%23` and `[^/]+` matches it - the
       * property `memberId` was designed around. The factory-level `/changes`
       * keeps meaning the factory's own directory and gains no union across
       * checkouts: a merged view of eight branches is a merge, and pretending
       * otherwise in a file tree would show one `src/api.ts` where there are
       * eight.
       */
      const loopChanges = /^\/loops\/([^/]+)\/changes$/.exec(rest);
      if (loopChanges && method === 'GET') {
        const checkout = host.checkoutFor(decodeURIComponent(loopChanges[1]!));
        if (!checkout) return json(res, 404, { error: 'that session has no checkout of its own' });
        const range = query.get('range') === 'branch' ? 'branch' : 'uncommitted';
        const [state, found] = await Promise.all([
          git.inspect(checkout.dir),
          git.changes(checkout.dir, range),
        ]);
        return json(res, 200, {
          dir: checkout.dir,
          files: found.entries,
          git: state,
          ...withoutEntries(found),
        });
      }

      const loopDiff = /^\/loops\/([^/]+)\/diff$/.exec(rest);
      if (loopDiff && method === 'GET') {
        const checkout = host.checkoutFor(decodeURIComponent(loopDiff[1]!));
        if (!checkout) return json(res, 404, { error: 'that session has no checkout of its own' });
        const asked = query.get('path');
        if (asked === null) return json(res, 400, { error: 'path required' });
        const range = query.get('range') === 'branch' ? 'branch' : 'uncommitted';
        const root = path.resolve(checkout.dir);
        // The same containment `/diff` has, against this session's checkout: a
        // path resolving outside it is refused before git sees it.
        if (resolveInside(root, asked) === null) {
          return json(res, 403, { error: 'outside the checkout' });
        }
        return json(res, 200, await git.fileDiff(root, asked, range));
      }

      const outbox = /^\/loops\/([^/]+)\/outbox$/.exec(rest);
      if (outbox && method === 'GET') {
        const view = await host.outbox(decodeURIComponent(outbox[1]!));
        // No wires out of the loop, so there is nothing it delivers into. A 404
        // rather than an empty view: the panel only asks about a wire it is showing.
        if (!view) return json(res, 404, { error: 'nothing wired out of that loop' });
        return json(res, 200, view);
      }

      /*
       * Empty everything the loop is delivering into.
       *
       * Answers with the outbox as it now stands rather than with a count, the same
       * bargain the loop-file deletes make: the panel has to redraw either way, and one
       * round trip returning the new truth beats two where the second asks what just
       * happened. How many went is on the response as well, for the line the panel
       * shows afterwards.
       *
       * Not refused while loops run - see `Host.clearOutbox` for why this differs from
       * clearing a loop's own folder.
       */
      if (outbox && method === 'DELETE') {
        const loopId = decodeURIComponent(outbox[1]!);
        const gone = await host.clearOutbox(loopId);
        if (gone === undefined) {
          return json(res, 404, { error: 'nothing wired out of that loop' });
        }
        const view = await host.outbox(loopId);
        if (!view) return json(res, 404, { error: 'nothing wired out of that loop' });
        return json(res, 200, { ...view, cleared: gone });
      }

      if (rest === '/start' && method === 'POST') return json(res, 200, await host.startAll());
      if (rest === '/stop' && method === 'POST') return json(res, 200, host.stopAll());
      if (rest === '/force-stop' && method === 'POST') return json(res, 200, host.forceStopAll());

      /*
       * Start, stop and force stop, per component.
       *
       * One route for the three because they are one shape - a loop id in, that
       * component's collapsed status out - and the host is where they differ. Force
       * stop is the same relationship to stop here as it is on the whole factory
       * above: not a different endpoint family, just the impatient version.
       */
      const loopAction = /^\/loops\/([^/]+)\/(start|stop|force-stop)$/.exec(rest);
      if (loopAction && method === 'POST') {
        const loopId = decodeURIComponent(loopAction[1]!);
        const action = loopAction[2];
        /*
         * Start can now genuinely fail before anything runs: a worktree loop
         * provisions its checkouts first, and a repository with no commits - or
         * a git error partway through a cluster - refuses the whole start. A
         * 409 with git's own words beats a card that silently stays grey; the
         * same story also lands on the loop's output stream.
         */
        try {
          const status =
            action === 'start'
              ? await host.startLoop(loopId)
              : action === 'stop'
                ? host.stopLoop(loopId)
                : host.forceStopLoop(loopId);
          if (!status) return json(res, 404, { error: 'no such loop' });
          return json(res, 200, status);
        } catch (err) {
          return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      /*
       * An operator message for one loop - the chat under its output log.
       *
       * Fire and acknowledge: the reply says the message was accepted, not what
       * became of it. What became of it arrives where the conversation lives, on
       * the output stream - the echo as a `user` line, and the agent's response
       * as ordinary text.
       */
      const steer = /^\/loops\/([^/]+)\/steer$/.exec(rest);
      if (steer && method === 'POST') {
        const body = await readBody(req);
        const text = isObject(body) && typeof body.text === 'string' ? body.text.trim() : '';
        if (text.length === 0) return json(res, 400, { error: 'text required' });
        if (!host.steerLoop(decodeURIComponent(steer[1]!), text)) {
          return json(res, 404, { error: 'no such loop' });
        }
        return json(res, 200, { ok: true });
      }

      const outputFor = /^\/output\/([^/]+)$/.exec(rest);
      if (outputFor && method === 'GET') {
        return json(res, 200, host.output(decodeURIComponent(outputFor[1]!)));
      }

      /*
       * The project the loops are building, and one of its files.
       *
       * The same two shapes as the loop endpoints below and deliberately so - the
       * panel renders either from one code path - but rooted at the base directory
       * and without their DELETE counterparts. See `listProjectFiles`.
       */
      /*
       * All three project-file routes take an optional `?checkout=<runner key>`
       * and answer from that session's worktree instead of the base directory.
       * One parameter rather than a parallel route family, because the answer
       * has the same shape from either root and the panel renders it from the
       * same code path - only the directory differs, and `checkoutRoot` is the
       * one place that difference is resolved.
       */
      const checkoutRoot = (): string | null => {
        const key = query.get('checkout');
        if (key === null) return path.resolve(host.doc().baseDir);
        const checkout = host.checkoutFor(key);
        return checkout === undefined ? null : path.resolve(checkout.dir);
      };

      if (rest === '/files' && method === 'GET') {
        const root = checkoutRoot();
        if (root === null) return json(res, 404, { error: 'that session has no checkout of its own' });
        return json(res, 200, await listProjectFiles(root));
      }

      /*
       * A file dropped onto the project view lands in the project, at the path the
       * panel asked for - in practice the file's own name, so the project root.
       * The one write the project side has, against a browse that is otherwise
       * read-only: a drop is the operator copying a file in, not the app changing
       * source, and it answers with the fresh listing the way the loop deletes do.
       * An existing file is overwritten, which is what "copy it in again" means.
       */
      if (rest === '/file' && method === 'PUT') {
        const asked = query.get('path');
        if (asked === null) return json(res, 400, { error: 'path required' });
        // A drop while browsing a checkout lands in that checkout. Silently
        // filing it into the base directory instead would be the one thing the
        // panel says is not happening.
        const root = checkoutRoot();
        if (root === null) return json(res, 404, { error: 'that session has no checkout of its own' });
        const file = resolveInside(root, asked);
        if (file === null) return json(res, 403, { error: 'outside the project' });
        const bytes = await readBytes(req);
        if (bytes === null) {
          return json(res, 413, { error: `larger than ${UPLOAD_MAX / (1024 * 1024)}MB` });
        }
        const existing = await fsp.stat(file).catch(() => null);
        if (existing !== null && !existing.isFile()) {
          return json(res, 400, { error: 'a folder is already called that' });
        }
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, bytes);
        return json(res, 200, await listProjectFiles(root));
      }

      if (rest === '/file' && method === 'GET') {
        const asked = query.get('path');
        if (asked === null) return json(res, 400, { error: 'path required' });
        const root = checkoutRoot();
        if (root === null) return json(res, 404, { error: 'that session has no checkout of its own' });
        const file = resolveInside(root, asked);
        if (file === null) return json(res, 403, { error: 'outside the project' });

        let st;
        try {
          st = await fsp.stat(file);
        } catch {
          return json(res, 404, { error: 'no such file' });
        }
        if (!st.isFile()) return json(res, 400, { error: 'not a file' });
        if (st.size > FILE_MAX) {
          return json(res, 200, {
            path: asked,
            content: '',
            note: `${(st.size / (1024 * 1024)).toFixed(1)}MB is too large to show here.`,
          });
        }
        return json(res, 200, { path: asked, content: await fsp.readFile(file, 'utf8') });
      }

      /*
       * What a loop has written, and one of those files.
       *
       * Both check the loop against the document first. That check is doing double
       * duty: it is the 404 an unknown id deserves, and it is also what keeps the
       * id out of `loopDir` until it is known to be one this factory issued.
       *
       * Known to the document is not the same as safe, though. The document is
       * where ids come from and a document can arrive from anywhere - imported,
       * hand-edited, cloned along with somebody else's repository - so `parse`
       * refuses ids that could escape, and the resolved folder is checked against
       * the internals directory again here before anything is read or removed. Two
       * defences on purpose: an `rm -rf` built from a string somebody else wrote is
       * not a place to rely on one.
       */
      const loopFiles = /^\/loops\/([^/]+)\/files$/.exec(rest);
      if (loopFiles && (method === 'GET' || method === 'DELETE')) {
        const loopId = decodeURIComponent(loopFiles[1]!);
        if (!host.doc().loops.some((l) => l.id === loopId)) {
          return json(res, 404, { error: 'no such loop' });
        }
        const folder = path.resolve(host.doc().baseDir, loopDir(loopId));
        if (!inside(path.join(host.doc().baseDir, INTERNAL), folder)) {
          return json(res, 400, { error: 'loop folder resolves outside the factory' });
        }
        if (method === 'DELETE') {
          /*
           * Refused while the loop is going, and `paused` counts as going.
           *
           * A running loop's folder is not scratch it has finished with: it is where
           * the turn in flight is keeping the item it claimed off a queue. Deleting
           * it mid-turn destroys work that is neither on a queue any more nor
           * anywhere else, so this waits for a stop rather than racing an agent.
           */
          /*
           * Matched on `loop` rather than `id`, which is the whole component.
           *
           * `statusAll` reports one entry per *session*, so a cluster's entries are
           * keyed `<loopId>#<n>` and none of them equals the loop id. Matching on
           * `id` therefore found nothing for a cluster and fell through to
           * "stopped", which would have let this delete the folder holding items
           * five members were mid-turn on - precisely the case the refusal exists
           * for, and the only one where the loss is unrecoverable. `loop` is the
           * loop id on every entry, member or not, so this asks "is any session of
           * this component going".
           */
          const live = host
            .statusAll()
            .some((s) => s.loop === loopId && s.state !== 'stopped');
          if (live) {
            return json(res, 409, { error: 'stop the loop before clearing its folder' });
          }
          // The folder goes rather than being emptied. The next turn creates it, and
          // removing it takes whatever nesting a loop invented with it.
          await fsp.rm(folder, { recursive: true, force: true });
        }
        return json(res, 200, await listLoopFiles(host.doc().baseDir, loopId));
      }

      const loopFile = /^\/loops\/([^/]+)\/file$/.exec(rest);
      if (loopFile && (method === 'GET' || method === 'DELETE' || method === 'PUT')) {
        const loopId = decodeURIComponent(loopFile[1]!);
        if (!host.doc().loops.some((l) => l.id === loopId)) {
          return json(res, 404, { error: 'no such loop' });
        }
        const asked = query.get('path');
        if (asked === null) return json(res, 400, { error: 'path required' });
        const root = path.resolve(host.doc().baseDir, loopDir(loopId));
        // `resolveInside` keeps the file under the root; this keeps the root under
        // the factory, which it is not by construction if the id escaped.
        if (!inside(path.join(host.doc().baseDir, INTERNAL), root)) {
          return json(res, 400, { error: 'loop folder resolves outside the factory' });
        }
        const file = resolveInside(root, asked);
        if (file === null) return json(res, 403, { error: 'outside the loop folder' });

        /*
         * A file dropped onto the loop view lands in the loop's folder. Allowed
         * while the loop runs, like the per-file delete and unlike clearing the
         * folder: one named file arriving is something an agent's own turn does
         * constantly, and the folder may not exist yet, so it is made on the way.
         */
        if (method === 'PUT') {
          const bytes = await readBytes(req);
          if (bytes === null) {
            return json(res, 413, { error: `larger than ${UPLOAD_MAX / (1024 * 1024)}MB` });
          }
          const existing = await fsp.stat(file).catch(() => null);
          if (existing !== null && !existing.isFile()) {
            return json(res, 400, { error: 'a folder is already called that' });
          }
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(file, bytes);
          return json(res, 200, await listLoopFiles(host.doc().baseDir, loopId));
        }

        if (method === 'DELETE') {
          /*
           * Allowed while the loop runs, unlike clearing the whole folder.
           *
           * The difference is that this is one file the operator named and can see,
           * rather than everything including the item a turn is holding. `force`
           * because a file already gone is the outcome being asked for.
           */
          const target = await fsp.stat(file).catch(() => null);
          // A folder is not what this endpoint is for, and `rm` without `recursive`
          // would throw its own way into a 500. Clearing is the folder-sized verb.
          if (target !== null && !target.isFile()) return json(res, 400, { error: 'not a file' });
          await fsp.rm(file, { force: true });
          return json(res, 200, await listLoopFiles(host.doc().baseDir, loopId));
        }

        let st;
        try {
          st = await fsp.stat(file);
        } catch {
          return json(res, 404, { error: 'no such file' });
        }
        // A directory and a device are both things a path can legitimately point
        // at and neither has text to show, so they are refused rather than read.
        if (!st.isFile()) return json(res, 400, { error: 'not a file' });
        if (st.size > FILE_MAX) {
          return json(res, 200, {
            path: asked,
            content: '',
            note: `${(st.size / (1024 * 1024)).toFixed(1)}MB is too large to show here.`,
          });
        }
        return json(res, 200, { path: asked, content: await fsp.readFile(file, 'utf8') });
      }

      return json(res, 404, { error: 'no such endpoint' });
    }

    /* --------------------------------------------------------------- stream */

    if (url === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Send the current state at once, so a page that connects mid-run is not
      // blank until something happens to be broadcast.
      res.write(frame('factories', registry.list()));
      for (const host of hosts.values()) {
        res.write(frame('status-all', { factory: host.id, status: host.statusAll() }));
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return await serveStatic(url, res);
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

/* ------------------------------------------------------------------ startup */

await registry.read();

/*
 * Bring a checkout-local registry forward, once.
 *
 * The registry used to live at `app/factories.json`, so an installation upgrading
 * into this version has one there with everything it knows in it. Merged rather
 * than copied, because two checkouts can both have one and the second to start
 * must not undo the first: `mergeInto` keeps what is already in the per-user file
 * and appends only ids it has never seen.
 *
 * Skipped entirely when `REGISTRY` names the file. That is an operator saying "use
 * this one", and quietly folding a stale checkout's list into a path someone chose
 * deliberately is not migrating, it is contaminating.
 *
 * Logged when it does something, because it changes what the tab strip shows on the
 * next start and a silent list that grew by four is alarming.
 */
if (process.env.REGISTRY === undefined) {
  const brought = await registry.mergeInto(LEGACY_REGISTRY_FILE);
  if (brought > 0) {
    process.stdout.write(
      `  registry took in ${brought} ${brought === 1 ? 'factory' : 'factories'} from ` +
        `${LEGACY_REGISTRY_FILE}\n`,
    );
  }
}

if (registry.listAll().length === 0) {
  // Nothing known at all: either this is a pre-tabs installation to bring forward,
  // or a fresh one that needs its first tab. `listAll`, not `list`: an installation
  // whose every tab was closed knows plenty of factories and needs none minted for
  // it. It starts with no tabs, which the shell already has a screen for, and the
  // closed ones are still there to be reopened.
  const migrated = await migrateLegacy({
    legacyDoc: path.join(appRoot, 'factory.json'),
    legacyWorkspace: LEGACY_BASE,
  });
  if (migrated) {
    await registry.put({ id: migrated.id, name: migrated.name, baseDir: migrated.baseDir });
  } else {
    const id = newFactoryId();
    await registry.put({ id, name: 'Factory', baseDir: ownBaseDir(id) });
  }
}

// One entry at a time and each on its own: a directory that has gone away, or a
// permission that has, is one tab's problem. It must not keep the server from
// coming up with the others.
for (const ref of [...registry.list()]) {
  try {
    await open(ref);
  } catch (err) {
    process.stderr.write(
      `  [${ref.name}] could not be opened and was skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// Without this, a failed listen is silent: the process exits with no output and
// you are left looking at whatever else happens to hold the port.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`port ${PORT} is already in use. Something else is listening there.\n`);
  } else {
    process.stderr.write(`server error: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`kiro factory on http://${HOST}:${PORT}\n`);
  process.stdout.write(`  registry   ${REGISTRY_FILE}\n`);
  process.stdout.write(`  driver     ${driver.name}\n`);
  // Printed for whoever is driving the API by hand. Opening the URL in a browser
  // needs nothing: the page is served with this run's token already in it.
  process.stdout.write(`  token      ${TOKEN}   (${GUARD_HEADER} header, on writes)\n`);
  for (const host of hosts.values()) {
    process.stdout.write(`  factory    ${host.doc().name} - ${host.baseDir}/${INTERNAL}\n`);
  }
});

/**
 * How long a graceful shutdown waits for turns in flight before killing them.
 *
 * Long enough that a loop mid-write usually gets to finish its turn, short enough
 * that Ctrl+C is still recognisably Ctrl+C. A turn is routinely minutes; nobody
 * who has pressed Ctrl+C wants to wait minutes for it.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Stop every loop before exiting, so no kiro-cli subprocess is orphaned.
 *
 * Graceful first, because a turn in flight may be halfway through a file. But
 * graceful used to be the only mode, with no output and no bound: Ctrl+C on a
 * running factory went quiet for as long as the slowest turn across every loop
 * took, and a second Ctrl+C re-entered the same wait, since registering a handler
 * replaces Node's default. The operator had no lever. Now the first signal says
 * what it is waiting for, waits a bounded time, then force-stops whatever is left;
 * a second signal skips the wait. `forceStop` aborts the turn and the runner kills
 * its kiro-cli, so nothing is orphaned either way - what is lost is the rest of an
 * interrupted turn, which is what interrupting means.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    process.stderr.write(`\n${signal} again - stopping turns in flight now.\n`);
    for (const h of hosts.values()) h.forceStopAll();
    return;
  }
  shuttingDown = true;
  const live = [...hosts.values()].reduce(
    (n, h) => n + h.statusAll().filter((s) => s.state !== 'stopped').length,
    0,
  );
  if (live > 0) {
    process.stderr.write(
      `\n${signal}: letting ${live} turn${live === 1 ? '' : 's'} in flight finish ` +
        `(up to ${SHUTDOWN_GRACE_MS / 1000}s). Press again to stop them now.\n`,
    );
  }
  const drained = Promise.all([...hosts.values()].map((h) => h.dispose()));
  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS));
  if ((await Promise.race([drained, timer])) === 'timeout') {
    process.stderr.write(`still running after ${SHUTDOWN_GRACE_MS / 1000}s - stopping turns in flight now.\n`);
    for (const h of hosts.values()) h.forceStopAll();
    await drained;
  }
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
