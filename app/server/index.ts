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
 *   POST   /api/factories/:f/reload        read its design again: the library entry, or its own file
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
 *   GET    /api/factories/:f/usage/:l      this run's finished iterations and their credits for one loop
 *   GET    /api/factories/:f/usage-history every run of this factory, newest first, with its cost
 *   GET    /api/factories/:f/files                the project the loops build (&checkout= for a session's worktree)
 *   GET    /api/factories/:f/file?path=           one of those files, as text (&checkout= likewise)
 *   GET    /api/factories/:f/loops/:l/files       what one loop has written
 *   DELETE /api/factories/:f/loops/:l/files       clear the folder; the loop must be stopped
 *   GET    /api/factories/:f/loops/:l/file?path=  one of those files, as text
 *   DELETE /api/factories/:f/loops/:l/file?path=  delete just that one
 *   GET    /api/events                     SSE: status, output and usage as they happen
 *
 *   Remote loops (Kiro Flock), see server/flock/:
 *   GET    /api/flocks                     connections, without secrets
 *   POST   /api/flocks                     add: {apiUrl, username, password, name?}
 *   DELETE /api/flocks/:c                  remove a connection and its secrets (409 while loops use it)
 *   PATCH  /api/flocks/:c                  rename
 *   POST   /api/flocks/:c/signin | /signout
 *   GET    /api/flocks/:c/models | /limits | /clusters      proxied, clusters annotated with owner
 *   POST   /api/flocks/:c/probe            re-check the flock for the queue routes
 *   POST   /api/flocks/:c/clusters/:id/stop   orphan handling (Kiro Factory clusters only)
 *   DELETE /api/flocks/:c/clusters/:id        orphan handling: stop, unregister
 *   GET    /api/factories/:f/remotes       which remote loops are live, for the delete dialogs
 *   GET    /api/factories/:f/loops/:l/remote/stream?node=&kind=acp|console[&session=]
 *   GET    /api/factories/:f/loops/:l/remote/sessions?node=
 *   GET    /api/factories/:f/loops/:l/remote/files | /file?path=   read-only cluster files
 *   GET    /api/factories/:f/loops/:l/remote/info
 *   DELETE /api/factories/:f/loops/:l/remote[?files=yes]   stop and remove the cluster
 *   POST   /api/factories/:f/loops/:l/remote/detach         leave it running, stop watching
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
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
  withoutTrustDeploy,
  type Factory,
  type FactoryRef,
} from './factory.ts';
import * as git from './git.ts';
import { readSessions } from './worktrees.ts';
import { ConflictError, Host, type Emit } from './host.ts';
import { SignedOutError } from './flock/auth.ts';
import { FlockApiError, FlockClient, SESSION_ID_RE } from './flock/client.ts';
import { ConnectionError, ConnectionStore } from './flock/connections.ts';
import { readMarker } from './flock/direction.ts';
import { INSECURE_FLOCK } from './flock/net.ts';
import { DetachedStore } from './flock/sidecar.ts';
import { StreamProxy } from './flock/stream.ts';
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

/**
 * The flocks this installation can drive remote loops on, beside the registry
 * for the same reason the grants are: a connection is a credential holder and
 * belongs to the operator, not to a project. Secrets live in a sibling
 * directory the store manages; see server/flock/connections.ts.
 */
const FLOCKS_FILE = path.join(path.dirname(REGISTRY_FILE), 'flocks.json');

/** App settings beside the registry. Holds the default folder for new factories. */
const CONFIG_FILE = path.join(path.dirname(REGISTRY_FILE), 'config.json');
const DETACHED_FILE = path.join(path.dirname(REGISTRY_FILE), 'remote-detached.json');
const connections = new ConnectionStore(FLOCKS_FILE);
const detached = new DetachedStore(DETACHED_FILE);
const streamProxy = new StreamProxy();
if (INSECURE_FLOCK) {
  process.stderr.write(
    'KIROFACTORY_INSECURE_FLOCK=1: plain http to loopback is allowed for flock connections.\n' +
    '  This is for the mock flock (npm run mock-flock). Do not run a real factory this way.\n',
  );
}
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

/**
 * The oldest kiro-cli the loops run on. `KiroDriver` starts every turn with
 * `--v3`, which 2.x does not have; `models.ts` reads the catalogue from the
 * V3 session shape; `usage.ts` reads V3 session metering. On an older CLI all
 * three fail in ways that look like something else (a loop that exits at once,
 * an empty model picker, every turn unmetered), so the version is read once at
 * startup and the mismatch is said plainly. A warning, not an exit: the echo
 * driver and the mock flock need no kiro-cli at all.
 */
const KIRO_CLI_MIN = { major: 3, minor: 0 };
void (async () => {
  if (process.env.LOOP_DRIVER === 'echo') return;
  const cli = process.env.KIRO_CLI ?? 'kiro-cli';
  let out: string;
  try {
    out = (await promisify(execFile)(cli, ['--version'], { timeout: 10_000 })).stdout;
  } catch (e) {
    process.stderr.write(`  kiro-cli: could not run \`${cli} --version\` (${(e as Error).message}); loops will fail to start until it is on the PATH\n`);
    return;
  }
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  if (m === null) return;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < KIRO_CLI_MIN.major || (major === KIRO_CLI_MIN.major && minor < KIRO_CLI_MIN.minor)) {
    process.stderr.write(
      `  kiro-cli ${m[0]} is older than ${KIRO_CLI_MIN.major}.${KIRO_CLI_MIN.minor}, which this factory needs: ` +
        `loops run on the V3 harness, and the model list and credit metering read its session format. ` +
        `Update kiro-cli (https://kiro.dev/docs/cli/installation/) and restart.\n`,
    );
  }
})();

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
    const host = new Host({ ...empty(ref), id: ref.id, name: ref.name, baseDir: ref.baseDir }, driver, emitFor(ref.id), connections);
    hosts.set(host.id, host);
    return host;
  }
  // The registry is what the tab strip showed, so its name and location win over
  // a document that was edited underneath us. The document is then written back
  // so the two agree.
  const factory: Factory = { ...doc, id: ref.id, name: ref.name, baseDir: ref.baseDir };
  const host = new Host(factory, driver, emitFor(ref.id), connections);
  await save(factory);
  await host.prepare();
  hosts.set(host.id, host);
  return host;
}

/* ------------------------------------------------------- the default folder */

/**
 * Where `+` puts a new factory: `<defaultDir>/<id>`.
 *
 * Saved in `~/.kirofactory/config.json` when the operator picks one in the Open
 * picker. Absent, it is `WORKSPACES` or `app/workspaces` (`AUTO_BASE`), so nobody
 * who never sets it sees anything change.
 */
let savedDefaultDir: string | undefined;

async function readConfig(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
    const dir = isObject(raw) && typeof raw.defaultDir === 'string' ? raw.defaultDir : '';
    savedDefaultDir = dir.length > 0 ? path.resolve(dir) : undefined;
  } catch {
    savedDefaultDir = undefined;
  }
}

async function writeConfig(): Promise<void> {
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  const body = savedDefaultDir === undefined ? {} : { defaultDir: savedDefaultDir };
  await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function defaultDir(): string {
  return savedDefaultDir ?? AUTO_BASE;
}

/** The folder a factory gets when nobody named one: `<default>/<id>`. */
function ownBaseDir(id: string): string {
  return path.join(defaultDir(), id);
}

/* ---------------------------------------------------------------- identity */

/**
 * Is this id already some other folder's factory?
 *
 * Taken means another registered folder carries it and still holds a document.
 * Then the folder asking is a copy - a duplicated project, a clone - and is a
 * different factory, so it gets a fresh id and its remote loops get their own
 * clusters. A registered folder with no document left is a factory that moved, and
 * its id is free to follow it: `Registry.put` replaces that stale row.
 */
function idTaken(id: string, baseDir: string): boolean {
  const dir = path.resolve(baseDir);
  return registry.listAll().some((r) => r.id === id && r.baseDir !== dir && existsSync(docPath(r.baseDir)));
}

/**
 * The id a folder's factory has, by the one rule every way in follows.
 *
 * The registry's row for the folder wins, because that is the id the factory last
 * ran under and remote cluster ids are derived from it. Then the document's own id.
 * Either is kept only if no other folder's factory has it. Otherwise one is minted -
 * which is also the answer for a document an agent wrote without an id.
 */
function identify(baseDir: string, docId: string | undefined): string {
  const row = registry.at(baseDir);
  if (row !== undefined && !idTaken(row.id, baseDir)) return row.id;
  if (docId !== undefined && docId.length > 0 && !idTaken(docId, baseDir)) return docId;
  return newFactoryId();
}

/** A request the operator can fix, answered with its status rather than a 500. */
class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The folder a new factory is created in, given what was asked for.
 *
 * Nothing asked is `<default>/<id>`. A folder asked for is used exactly as asked or
 * refused - never quietly swapped for another, because the operator picked it on
 * purpose. Refused when it already holds a factory (open that one instead) and when
 * it is the home directory, whose `.kirofactory/` is the registry's. See `isHomeDir`.
 */
function targetDir(asked: unknown, id: string): string {
  if (typeof asked !== 'string' || asked.trim().length === 0) return ownBaseDir(id);
  const dir = path.resolve(asked.trim());
  if (isHomeDir(dir)) {
    throw new Refusal(
      400,
      `A factory cannot live directly in your home directory - that is where the list of factories is kept. Make a folder for it instead - ${dir}`,
    );
  }
  if (existsSync(docPath(dir)) || registry.at(dir) !== undefined) {
    throw new Refusal(409, `That folder already holds a factory. Open it instead - ${dir}`);
  }
  return dir;
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
  /** The listing is the folder asked for, not the nearest one above it that exists. */
  exact: boolean;
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
  // `~` is expanded because a pasted path often starts with it.
  const typed = asked === null || asked.trim().length === 0 ? home : asked.trim().replace(/^~(?=$|\/)/, home);
  const requested = path.resolve(typed);
  let dir = requested;
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (!existsSync(dir)) dir = home;

  const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
  // Built once for the whole listing rather than per row: it is the open-tab list,
  // and a hundred children would otherwise walk it a hundred times.
  const tabs = new Map(registry.list().map((r) => [r.baseDir, r.name]));
  const head = { path: dir, parent, home, exact: dir === requested, ...(await factoryFacts(dir, tabs)) };

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
    // A factory's own internals are not a place to go or put anything.
    if (name === INTERNAL) continue;
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
 * For a loop's folder this caps the whole walk. For the project, which is listed
 * one folder at a time, it caps one folder's entries: a folder of twelve thousand
 * images shows its first ten thousand, by name, and says so.
 *
 * The walk says when it hit this, and the panel repeats it, so the cap is a
 * visible limit rather than a silent lie about what the project contains.
 */
const FILE_COUNT_MAX = 10000;

/** How many folders one project listing may ask for: the open ones, so not many. */
const FOLDERS_PER_REQUEST_MAX = 500;

/**
 * Directories the project listing does not show, by exact name at any depth.
 *
 * Only the project: a loop's own folder is entirely of the loop's own making, so
 * pruning it would be second-guessing an agent about its own scratch space. In the
 * project these are dependencies, build output and caches - tens of thousands of
 * files that are not what the loops are building.
 *
 * A fixed list rather than reading `.gitignore`, which is a pattern language with
 * negations and precedence rules.
 *
 * `.kirofactory` is here because everything in it that a reader wants is shown
 * elsewhere: the loop view lists each loop's folder, and the app reads the queues
 * through their own endpoints. Listing it again in the project spent thousands of entries on the
 * factory's own bookkeeping.
 */
const SKIP_DIRS = new Set([
  '.kirofactory',
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

/** A folder in a project listing: where it is, and how many entries it holds. */
interface ProjectFolderEntry {
  /** Relative to the project, `/`-separated, with a trailing slash. */
  path: string;
  /** Its direct entries, after the same pruning the listing applies. */
  count: number;
}

/**
 * The project itself, one folder at a time.
 *
 * The counterpart of `listLoopFiles`. The loops build a real codebase in the base
 * directory, and this is how the panel shows it without leaving the app.
 *
 * Only the folders the panel has open are listed: the root always, plus each path
 * in `folders`. Each comes back as its direct files and its direct subfolders, and
 * a subfolder carries its entry count so a closed one still says something. A
 * project of any size then costs what is on screen. The single flat walk this
 * replaced stopped at FILE_COUNT_MAX, and because it read in name order, a project
 * whose dot-folders held ten thousand files of scratch lost every folder after them
 * - which was all of its source.
 *
 * `dir` is the absolute base directory rather than a relative path, because there
 * is nothing above it to be relative to and the panel shows the string to say
 * where you are looking.
 *
 * `capped` names the folders that held more than FILE_COUNT_MAX entries, `''` for
 * the root. Asked-for folders that are gone, outside the project, behind a symlink
 * or pruned by SKIP_DIRS are left out rather than refused: an open folder that a
 * loop has just deleted is ordinary, and the answer is that it has nothing in it.
 *
 * Read-only, and unlike the loop endpoints there is no delete beside it. These are
 * the operator's real source files, not a folder an agent was given to scribble in,
 * and a trash button in a panel meant for looking is not a thing to hand someone
 * by accident. Git is the tool for changing your mind about a project.
 */
async function listProjectFolders(
  baseDir: string,
  folders: readonly string[] = [],
): Promise<{
  dir: string;
  files: LoopFileEntry[];
  folders: ProjectFolderEntry[];
  capped: string[];
  truncated: boolean;
}> {
  const empty = { dir: baseDir, files: [], folders: [], capped: [], truncated: false };
  if (!existsSync(baseDir)) return empty;
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(baseDir);
  } catch {
    return empty;
  }

  const files: LoopFileEntry[] = [];
  const subfolders: ProjectFolderEntry[] = [];
  const capped: string[] = [];
  const wanted = new Set(['', ...folders.slice(0, FOLDERS_PER_REQUEST_MAX).map(asFolderPath)]);

  for (const rel of wanted) {
    if (rel === null) continue;
    const full = await projectFolder(baseDir, realRoot, rel);
    if (full === null) continue;
    const entries = await visibleEntries(full, SKIP_DIRS);
    if (entries === null) continue;
    if (entries.length > FILE_COUNT_MAX) capped.push(rel);
    for (const entry of entries.slice(0, FILE_COUNT_MAX)) {
      const childRel = `${rel}${entry.name}`;
      const childFull = path.join(full, entry.name);
      if (entry.isDirectory()) {
        const inner = await visibleEntries(childFull, SKIP_DIRS);
        subfolders.push({ path: `${childRel}/`, count: inner?.length ?? 0 });
      } else {
        files.push(await fileEntry(childFull, childRel));
      }
    }
  }

  return { dir: baseDir, files, folders: subfolders, capped, truncated: capped.includes('') };
}

/**
 * A folder path as the panel sends it, normalised to `a/b/`, or null if it is not
 * one. `''` is the root and is always listed, so it is dropped here.
 */
function asFolderPath(raw: string): string | null {
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return `${parts.join('/')}/`;
}

/**
 * Where a requested project folder is on disk, or null if the listing should not
 * enter it.
 *
 * Containment is tested twice: on the path as given, which catches `..` and
 * absolute paths, and on the real path, which catches a symlink inside the project
 * pointing out of it. The listing never offers a symlinked folder, but a request
 * can name one, and a read of somewhere else on the disk presented as part of the
 * project is still a read of somewhere else. A path through a pruned folder is
 * refused too, so asking for `.git/` does not list what the listing hides.
 */
async function projectFolder(baseDir: string, realRoot: string, rel: string): Promise<string | null> {
  if (rel === '') return baseDir;
  if (rel.split('/').some((part) => SKIP_DIRS.has(part))) return null;
  const full = resolveInside(path.resolve(baseDir), rel.slice(0, -1));
  if (full === null) return null;
  try {
    const real = await fsp.realpath(full);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const st = await fsp.stat(real);
    return st.isDirectory() ? full : null;
  } catch {
    return null;
  }
}

/**
 * One folder's entries that a listing shows, sorted by name, or null if it cannot
 * be read.
 *
 * Sorted so a capped folder always shows the same first slice rather than whatever
 * order the filesystem returned. Symlinks are dropped - a link is the one thing in
 * a directory that can point out of it - and so is anything named in `skip`.
 *
 * `skip` is tested by name whatever the entry turns out to be. Testing directories
 * only was wrong for exactly one entry in the list and it is the one that matters:
 * in a linked worktree `.git` is a *file* holding a path to the real git directory,
 * so a worktree's tree listed it while an ordinary checkout did not.
 */
async function visibleEntries(dir: string, skip?: Set<string>): Promise<Dirent[] | null> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // Unreadable, or gone since its parent was listed. Either way there is
    // nothing here to report and it is not worth failing the request over.
    return null;
  }
  return entries
    .filter((e) => !e.isSymbolicLink() && !(skip?.has(e.name) ?? false) && (e.isDirectory() || e.isFile()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A file's listing row. A file that vanished since the readdir keeps its row, blank. */
async function fileEntry(full: string, rel: string): Promise<LoopFileEntry> {
  try {
    const st = await fsp.stat(full);
    return { path: rel, size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { path: rel, size: 0, mtime: '' };
  }
}

/**
 * Every file under one loop's folder, flat, stopping at FILE_COUNT_MAX.
 *
 * Breadth-first: every folder's own files are listed before anything one level
 * deeper. When the cap is hit, what is missing is the bottom of the tree, so the
 * shape of the folder is still on screen. The depth-first walk this replaced spent
 * the whole cap inside whichever subfolder sorted first and showed nothing of the
 * rest.
 *
 * `truncated` says the walk stopped at the cap rather than the bottom of the
 * tree. The distinction matters to the reader and only the walk knows it: a list
 * of exactly FILE_COUNT_MAX files could also be a folder of exactly that size.
 */
async function walkFiles(root: string): Promise<{ files: LoopFileEntry[]; truncated: boolean }> {
  const out: LoopFileEntry[] = [];
  const queue: { dir: string; prefix: string }[] = [{ dir: root, prefix: '' }];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const entries = await visibleEntries(next.dir);
    if (entries === null) continue;
    for (const entry of entries) {
      const rel = next.prefix.length === 0 ? entry.name : `${next.prefix}/${entry.name}`;
      const full = path.join(next.dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: full, prefix: rel });
        continue;
      }
      if (out.length >= FILE_COUNT_MAX) return { files: out, truncated: true };
      out.push(await fileEntry(full, rel));
    }
  }
  return { files: out, truncated: false };
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
      return json(res, 200, { baseDir: defaultDir(), internal: INTERNAL, driver: driver.name });
    }

    /*
     * The default folder for new factories, and the built-in one it falls back to.
     *
     * PUT `{ defaultDir: "/abs/path" }` saves it; `{ defaultDir: null }` resets to the
     * built-in. The folder must exist, must be a directory, and must not be the home
     * directory itself, whose `.kirofactory/` is the registry's.
     */
    if (url === '/api/config' && method === 'GET') {
      return json(res, 200, { defaultDir: defaultDir(), builtinDefaultDir: AUTO_BASE });
    }

    if (url === '/api/config' && method === 'PUT') {
      const body = await readBody(req);
      if (!isObject(body) || !('defaultDir' in body)) return json(res, 400, { error: 'expected { defaultDir }' });
      if (body.defaultDir === null) {
        savedDefaultDir = undefined;
      } else {
        if (typeof body.defaultDir !== 'string' || body.defaultDir.trim().length === 0) {
          return json(res, 400, { error: 'defaultDir must be a path or null' });
        }
        const dir = path.resolve(body.defaultDir.trim());
        const stat = await fsp.stat(dir).catch(() => undefined);
        if (stat === undefined || !stat.isDirectory()) return json(res, 400, { error: `Not a folder - ${dir}` });
        if (isHomeDir(dir)) {
          return json(res, 400, { error: 'New factories cannot go directly into your home directory. Pick or make a folder inside it.' });
        }
        savedDefaultDir = dir === AUTO_BASE ? undefined : dir;
      }
      await writeConfig();
      return json(res, 200, { defaultDir: defaultDir(), builtinDefaultDir: AUTO_BASE });
    }

    /*
     * Make a folder from the picker, and answer with its listing.
     *
     * `{ parent, name }`. One plain name, no separators and no leading dot, created
     * inside a folder that already exists under the home directory. That is the whole
     * of what the picker's "New folder" needs, and nothing else can be reached
     * through it. Gated like every other write here by the per-run token.
     */
    if (url === '/api/browse/mkdir' && method === 'POST') {
      const body = await readBody(req);
      const parent = isObject(body) && typeof body.parent === 'string' ? path.resolve(body.parent) : '';
      const name = isObject(body) && typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0 || name.length > 255 || /[/\\\0]/.test(name) || name.startsWith('.')) {
        return json(res, 400, { error: 'A folder name is one plain name, with no slashes and no leading dot.' });
      }
      const home = os.homedir();
      const rel = path.relative(home, parent);
      if (parent.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
        return json(res, 400, { error: 'New folders can only be made inside your home directory.' });
      }
      const stat = await fsp.stat(parent).catch(() => undefined);
      if (stat === undefined || !stat.isDirectory()) return json(res, 400, { error: `Not a folder - ${parent}` });
      const dir = path.join(parent, name);
      if (existsSync(dir)) return json(res, 409, { error: `${name} already exists here.` });
      await fsp.mkdir(dir);
      return json(res, 201, await browse(dir));
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
     * lands, or the take-out is refused if a factory is already there; without one it
     * gets `<default>/<id>`. See `targetDir`.
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
      const baseDir = targetDir(wanted.baseDir, id);

      await save(
        parse(
          {
            id,
            name,
            baseDir,
            loops: entry.loops,
            wires: entry.wires,
            ...(entry.parameters !== undefined ? { parameters: entry.parameters } : {}),
            // Remembered so the copy can be brought back in step with the entry
            // later - see `/api/factories/:f/reload`.
            source: { library: entry.slug },
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
          // A document with no id is one an agent wrote; it gets one here.
          const known = hit.id.length > 0 ? registry.get(hit.id) : undefined;
          if (known === undefined) {
            added.push(
              await registry.adopt({ id: hit.id.length > 0 ? hit.id : newFactoryId(), name: hit.name, baseDir: hit.dir }),
            );
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
      // A folder asked for is the "Create a factory here" in the Open picker;
      // none is `+`, which lands in the default folder.
      const ref = await registry.put({ id, name, baseDir: targetDir(wanted.baseDir, id) });
      const host = await open(ref);
      send('factories', registry.list());
      return json(res, 201, host.doc());
    }

    if (url === '/api/factories/import' && method === 'POST') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected a factory document' });

      // Where it goes is the operator's pick in the Open picker, `?dir=`, or the
      // default folder when none was given. A `baseDir` inside the file is a path on
      // whichever machine wrote it and is ignored. A folder that already holds a
      // factory is refused: open that one, or pick another.
      const own = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined;
      const provisional = newFactoryId();
      const baseDir = targetDir(query.get('dir'), provisional);
      // The file's id is kept unless another folder's factory already has it, which
      // is what importing an export of a factory still on this machine is: a copy.
      const id = own !== undefined && !idTaken(own, baseDir) ? own : provisional;
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : 'Imported factory';

      // Parsed before anything is registered or written, so an import that is
      // refused leaves no tab and no directory behind it.
      let imported: Factory;
      try {
        imported = parse(withoutTrustDeploy({ ...body, id, name, baseDir }), { id, name, baseDir });
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
        ...(own !== undefined && own !== id
          ? { note: 'A factory with the same id is already on this machine, so this copy got a new id. They are now two factories.' }
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
       * The id, by the one rule in `identify`: this folder's registry row if it has
       * one, then the document's id, either kept only if no other folder's factory
       * has it. A document with no id - one an agent wrote - gets one minted here,
       * and `save` below writes it back.
       */
      const own = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
      const id = identify(baseDir, own);
      const copied = own !== undefined && own !== id && idTaken(own, baseDir);
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
        ...(copied
          ? {
              note:
                `This folder is a copy of another factory on this machine, so it ` +
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

    /* -------------------------------------------------------------- flocks */

    /*
     * Connections to Kiro Flocks, for remote loops. Every answer is a
     * `FlockConnectionView`: no token, no refresh token, no password ever
     * crosses here. The only secret-bearing requests are the add and sign-in
     * POSTs, which the gate above already requires the per-run token for.
     */
    if (url === '/api/flocks' && method === 'GET') return json(res, 200, await connections.list());

    if (url === '/api/flocks' && method === 'POST') {
      const body = await readBody(req);
      if (!isObject(body)) return json(res, 400, { error: 'expected an object' });
      try {
        const view = await connections.add({
          apiUrl: typeof body.apiUrl === 'string' ? body.apiUrl : '',
          username: typeof body.username === 'string' ? body.username : '',
          password: typeof body.password === 'string' ? body.password : '',
          ...(typeof body.mfaCode === 'string' ? { mfaCode: body.mfaCode } : {}),
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.userPoolId === 'string' ? { userPoolId: body.userPoolId } : {}),
          ...(typeof body.clientId === 'string' ? { clientId: body.clientId } : {}),
        });
        // The capability probe, once, so the dialog can say "needs flock update"
        // before anyone draws a loop on it. A probe failure is recorded, not fatal.
        try {
          const c = (await connections.get(view.id))!;
          const client = new FlockClient(c.apiUrl, await connections.session(c.id));
          await connections.setQueueRoutes(c.id, await client.hasQueueRoutes());
        } catch {
          /* shown as unknown */
        }
        return json(res, 201, (await connections.list()).find((c) => c.id === view.id) ?? view);
      } catch (err) {
        if (err instanceof ConnectionError) return json(res, err.status, { error: err.message });
        throw err;
      }
    }

    const flock = /^\/api\/flocks\/([^/]+)(\/.*)?$/.exec(url);
    if (flock) {
      const cid = decodeURIComponent(flock[1]!);
      const sub = flock[2] ?? '';
      const connection = await connections.get(cid);
      if (connection === undefined) return json(res, 404, { error: 'no such connection' });
      const clientFor = async (): Promise<FlockClient> => new FlockClient(connection.apiUrl, await connections.session(cid));

      try {
        if (sub === '' && method === 'DELETE') {
          // Refused while any open factory has a loop on it: removing the
          // credential would strand those clusters with no way to stop them.
          const users = [...hosts.values()].flatMap((h) => h.remoteLoopsOn(cid).map((l) => `${h.doc().name} / ${l.name}`));
          if (users.length > 0) {
            return json(res, 409, { error: `used by ${users.join(', ')} - remove or repoint those loops first` });
          }
          await connections.remove(cid);
          return json(res, 200, await connections.list());
        }
        if (sub === '' && method === 'PATCH') {
          const body = await readBody(req);
          const name = isObject(body) && typeof body.name === 'string' ? body.name : '';
          return json(res, 200, await connections.rename(cid, name));
        }
        if (sub === '/signin' && method === 'POST') {
          const body = await readBody(req);
          if (!isObject(body) || typeof body.password !== 'string') return json(res, 400, { error: 'password required' });
          const view = await connections.signIn(cid, {
            password: body.password,
            ...(typeof body.mfaCode === 'string' ? { mfaCode: body.mfaCode } : {}),
          });
          // A sign-in is also what resumes syncing: re-attach every remote loop
          // on this connection that is waiting on it.
          for (const h of hosts.values()) {
            for (const l of h.remoteLoopsOn(cid)) {
              const remote = h.remoteOf(l.loopId);
              if (remote !== undefined) void remote.resumeSync().catch(() => undefined);
            }
          }
          return json(res, 200, view);
        }
        if (sub === '/signout' && method === 'POST') return json(res, 200, await connections.signOut(cid));
        if (sub === '/models' && method === 'GET') return json(res, 200, await (await clientFor()).listModels());
        if (sub === '/limits' && method === 'GET') return json(res, 200, await (await clientFor()).limits());
        if (sub === '/probe' && method === 'POST') {
          const ok = await (await clientFor()).hasQueueRoutes();
          await connections.setQueueRoutes(cid, ok);
          return json(res, 200, { queueRoutes: ok });
        }

        /*
         * Every cluster on the flock, annotated with who owns it (plan 9.4):
         * this factory, another open factory, a Kiro Factory cluster nobody is
         * driving (an orphan), or not ours at all. Ownership is the `kf-` prefix
         * plus this program's marker in the direction - both, so a user's own
         * cluster that happens to be called `kf-something` is still "not ours".
         */
        if (sub === '/clusters' && method === 'GET') {
          const client = await clientFor();
          const list = await client.listClusters();
          const driven = new Map<string, { factory: string; loop: string }>();
          for (const h of hosts.values()) {
            for (const l of h.doc().loops) {
              if (l.remote?.connection !== cid) continue;
              const r = h.remoteOf(l.id);
              if (r !== undefined) driven.set(r.clusterId, { factory: h.doc().name, loop: l.name });
            }
          }
          const detachedList = (await detached.list()).filter((d) => d.connection === cid);
          const out = [];
          for (const c of list) {
            let owner: 'this-factory' | 'other-factory' | 'kiro-factory-orphan' | 'not-ours' = 'not-ours';
            let marker: { factoryId: string; loopId: string; connectionId: string } | null = null;
            if (c.id.startsWith('kf-')) {
              try {
                marker = readMarker(await client.getDirection(c.id));
              } catch {
                marker = null;
              }
            }
            const drive = driven.get(c.id);
            if (marker !== null) owner = drive !== undefined ? 'other-factory' : 'kiro-factory-orphan';
            const detachedRecord = detachedList.find((d) => d.clusterId === c.id);
            out.push({
              ...c,
              owner,
              ...(drive !== undefined ? { drivenBy: drive } : {}),
              ...(detachedRecord !== undefined ? { detached: { factoryName: detachedRecord.factoryName, baseDir: detachedRecord.baseDir, detachedAt: detachedRecord.detachedAt } } : {}),
              uiUrl: `${connection.apiUrl}/?cluster=${encodeURIComponent(c.id)}`,
            });
          }
          return json(res, 200, { clusters: out });
        }

        // Orphan handling, confirm-gated in the UI. Only clusters that carry
        // this program's marker may be stopped or removed from here.
        const orphan = /^\/clusters\/([^/]+)$/.exec(sub);
        const orphanStop = /^\/clusters\/([^/]+)\/stop$/.exec(sub);
        if ((orphan && method === 'DELETE') || (orphanStop && method === 'POST')) {
          const clusterId = decodeURIComponent((orphan ?? orphanStop)![1]!);
          if (!/^kf-[0-9a-f]{8}$/.test(clusterId)) return json(res, 403, { error: 'not a Kiro Factory cluster' });
          const client = await clientFor();
          if (readMarker(await client.getDirection(clusterId)) === null) return json(res, 403, { error: 'not a Kiro Factory cluster' });
          if ([...hosts.values()].some((h) => [...h.doc().loops].some((l) => h.remoteOf(l.id)?.clusterId === clusterId))) {
            return json(res, 409, { error: 'an open factory is driving this cluster - use its own Stop or Delete' });
          }
          await client.stop(clusterId).catch((e: unknown) => {
            if (!(e instanceof FlockApiError && e.status === 409)) throw e;
          });
          if (orphan && method === 'DELETE') {
            const end = Date.now() + 180_000;
            while (Date.now() < end && (await client.getStatus(clusterId)).clusterState !== 'stopped') {
              await new Promise((r) => setTimeout(r, 2000));
            }
            await client.deleteCluster(clusterId);
            await detached.remove(cid, clusterId);
          }
          return json(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof ConnectionError) return json(res, err.status, { error: err.message });
        if (err instanceof FlockApiError) return json(res, err.status === 0 ? 502 : err.status, { error: err.message });
        if (err instanceof SignedOutError) return json(res, 401, { error: 'signed out - sign in to this flock first' });
        throw err;
      }
      return json(res, 404, { error: 'not found' });
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

      /*
       * Read this factory's design again from where it came from.
       *
       * For a factory taken out of the library, that is its entry: take-out mints a
       * copy, and a copy does not follow the entry it copied. For every other
       * factory it is its own document file on disk. Either way an agent editing the
       * file afterwards is editing something no open tab shows. This brings the
       * design in the file onto this canvas: loops, wires and parameters are
       * replaced, identity and directory are not, so it is the same factory, in the
       * same tab, with the new design.
       *
       * Through `host.replace`, which is what the canvas saves through, so the same
       * rules hold - and refused outright while anything runs, because the loops
       * about to be rewritten are the ones holding the prompts and folders in use.
       * `replace` would allow most edits under a running loop; a whole design landing
       * at once is not most edits.
       *
       * Loop positions come from the entry, which keeps geometry on purpose, so a
       * canvas rearranged by hand goes back to how the entry lays it out. That is what
       * "the latest version" means.
       */
      if (rest === '/reload' && method === 'POST') {
        const current = host.doc();
        if (host.anyRunning()) {
          return json(res, 409, { error: 'stop the loops first. Reloading replaces the design a turn in flight is running' });
        }
        /*
         * Two places a design can be newer than the canvas, and which one applies is
         * decided by `source`. A factory from the library reads its entry again. Any
         * other factory reads its own document file again: the server loaded it once
         * when the tab opened and has held it since, so an agent editing
         * `.kirofactory/factory.json` underneath is editing something nobody shows -
         * and the next canvas save would write the held copy back over it. Reading
         * the file through `load` gives it the same parse, and the same refusal of a
         * broken file, that opening the tab would.
         */
        let design: { loops: unknown; wires: unknown; parameters?: unknown };
        if (current.source !== undefined) {
          const entry = await library.factoryBySlug(current.source.library);
          if (!entry) {
            return json(res, 404, { error: `"${current.source.library}" is no longer in the library` });
          }
          design = entry;
        } else {
          try {
            design = await load(current.baseDir, { id: current.id, name: current.name, baseDir: current.baseDir });
          } catch (err) {
            if (err instanceof DocumentError) return json(res, 400, { error: err.message });
            throw err;
          }
        }
        try {
          // A design read from the library or from a file edited outside the app
          // does not get to turn deploys on; the operator ticks that here.
          const doc = await host.replace(withoutTrustDeploy({
            loops: design.loops,
            wires: design.wires,
            ...(design.parameters !== undefined ? { parameters: design.parameters } : {}),
          }));
          return json(res, 200, doc);
        } catch (err) {
          if (err instanceof DocumentError) return json(res, 400, { error: err.message });
          if (err instanceof ConflictError) return json(res, 409, { error: err.message });
          throw err;
        }
      }

      if (rest === '' && method === 'PATCH') {
        const body = await readBody(req);
        if (!isObject(body)) return json(res, 400, { error: 'expected an object' });
        // A factory is its folder, so there is no moving one in place. Use a new
        // folder through Open, or Export and Import, or the library.
        if ('baseDir' in body) {
          return json(res, 400, {
            error: 'A factory cannot be moved to another folder. Export it and Import it there, or take it out of the library there.',
          });
        }
        let doc = host.doc();
        if (typeof body.name === 'string' && body.name.trim().length > 0) {
          doc = await host.rename(body.name.trim());
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
        /*
         * Remote clusters: the dialog has already asked, per live cluster, and
         * sends the answer as `?remote=<loopId>:<keep|stop|delete>,...`. Keep is
         * the default and means detach: the cluster runs on and is recorded in
         * the user-level detached list so the orphan list shows it. A plain
         * close (no `files`) always keeps; `dispose` never stops a cluster.
         */
        const answers = new Map<string, 'keep' | 'stop' | 'delete'>();
        for (const part of (query.get('remote') ?? '').split(',').filter(Boolean)) {
          const [loopId, choice] = part.split(':');
          if (loopId && (choice === 'keep' || choice === 'stop' || choice === 'delete')) answers.set(decodeURIComponent(loopId), choice);
        }
        for (const live of host.liveRemotes()) {
          const choice = wipe ? (answers.get(live.loopId) ?? 'keep') : 'keep';
          if (choice === 'keep') {
            await detached.add({
              connection: live.connection, clusterId: live.clusterId, loopId: live.loopId,
              factoryName: host.doc().name, baseDir, detachedAt: new Date().toISOString(),
            });
            continue;
          }
          try {
            await host.destroyRemote(live.loopId, choice === 'delete');
          } catch (err) {
            process.stderr.write(`  [${host.doc().name}] could not stop ${live.clusterId}: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
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
        const key = decodeURIComponent(steer[1]!);
        // A remote node has no chat: the direction is the only channel, and
        // editing the prompt is how it is steered.
        if (host.isRemoteKey(key)) return json(res, 409, { error: 'remote loops cannot be steered - edit the prompt instead' });
        if (!host.steerLoop(key, text)) {
          return json(res, 404, { error: 'no such loop' });
        }
        return json(res, 200, { ok: true });
      }

      /*
       * Remote loop proxies. The browser never talks to a flock: these fetch
       * on its behalf with the connection's token, through the shared stream
       * cache so several tabs cost one SSM command, and with every parameter
       * validated before it is forwarded.
       *
       *   GET /loops/:l/remote/stream?node=N&kind=acp|console[&session=ID]
       *   GET /loops/:l/remote/sessions?node=N
       *   GET /loops/:l/remote/files
       *   GET /loops/:l/remote/file?path=
       *   GET /loops/:l/remote/info
       */
      const remoteRoute = /^\/loops\/([^/]+)\/remote\/(stream|sessions|files|file|info)$/.exec(rest);
      if (remoteRoute && method === 'GET') {
        const loopId = decodeURIComponent(remoteRoute[1]!);
        const what = remoteRoute[2];
        try {
          const target = await host.remoteClient(loopId);
          if (target === undefined) return json(res, 404, { error: 'not a remote loop' });
          const { client, clusterId, connectionId } = target;
          const node = Number.parseInt(query.get('node') ?? '0', 10);
          if (!Number.isInteger(node) || node < 0 || node > 999) return json(res, 400, { error: 'node must be 0..999' });

          if (what === 'info') {
            const remote = host.remoteOf(loopId);
            return json(res, 200, {
              clusterId,
              connection: connectionId,
              uiUrl: remote?.uiUrl ?? `${(await connections.get(connectionId))?.apiUrl ?? ''}/?cluster=${encodeURIComponent(clusterId)}`,
              nodeUrl: remote?.nodeUrl(node),
              state: remote?.state ?? 'unknown',
            });
          }
          if (what === 'stream') {
            const kind = query.get('kind') === 'console' ? 'console' : 'acp';
            const session = query.get('session') ?? undefined;
            if (session !== undefined && !SESSION_ID_RE.test(session)) return json(res, 400, { error: 'bad session id' });
            return json(res, 200, await streamProxy.stream(connectionId, client, clusterId, node, kind, session));
          }
          if (what === 'sessions') {
            return json(res, 200, await streamProxy.list(connectionId, client, clusterId, node));
          }
          if (what === 'files') {
            const files = await client.queueListAll(clusterId, '');
            return json(res, 200, {
              dir: `environment/${clusterId}/`,
              files: files.map((f) => ({ path: f.key, size: f.size, mtime: f.lastModified })),
            });
          }
          // what === 'file'
          const asked = query.get('path') ?? '';
          // Validated here as `scopedKey` does on the flock: relative, no `..`,
          // no control characters. Refused before anything is sent.
          if (
            asked.length === 0 || asked.length > 512 || asked.startsWith('/') || asked.includes('\\') ||
            asked.includes('//') || /[\u0000-\u001f\u007f]/.test(asked) || asked.split('/').some((s) => s === '..')
          ) {
            return json(res, 403, { error: 'bad path' });
          }
          const content = await client.readFile(`environment/${clusterId}/${asked}`);
          return json(res, 200, { path: asked, content });
        } catch (err) {
          if (err instanceof SignedOutError) return json(res, 401, { error: 'signed out - sign in to this flock first' });
          if (err instanceof FlockApiError) return json(res, err.status === 0 ? 502 : err.status, { error: err.message });
          return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      /*
       * What a Delete on this factory, or on one of its loops, would do to the
       * remote clusters - for the dialogs, which ask before anything runs.
       */
      if (rest === '/remotes' && method === 'GET') {
        return json(res, 200, { live: host.liveRemotes() });
      }

      /*
       * Remove a remote loop's cluster from its flock (the delete-loop dialog's
       * confirmed path). Stops it if live. `?files=yes` also deletes its S3
       * folder, which is irreversible and has its own confirmation in the UI.
       * The loop itself is removed from the document by the usual PUT after.
       */
      const remoteDestroy = /^\/loops\/([^/]+)\/remote$/.exec(rest);
      if (remoteDestroy && method === 'DELETE') {
        try {
          await host.destroyRemote(decodeURIComponent(remoteDestroy[1]!), query.get('files') === 'yes');
          return json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof FlockApiError) return json(res, err.status === 0 ? 502 : err.status, { error: err.message });
          return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      /*
       * Detach: stop watching a remote loop's cluster and record it as left
       * running, so it appears in the orphan list. Nothing on the flock changes.
       */
      const remoteDetach = /^\/loops\/([^/]+)\/remote\/detach$/.exec(rest);
      if (remoteDetach && method === 'POST') {
        const loopId = decodeURIComponent(remoteDetach[1]!);
        const remote = host.remoteOf(loopId);
        const loop = host.doc().loops.find((l) => l.id === loopId);
        if (remote !== undefined && loop?.remote !== undefined) {
          await detached.add({
            connection: loop.remote.connection, clusterId: remote.clusterId, loopId, factoryName: host.doc().name,
            baseDir: host.doc().baseDir, detachedAt: new Date().toISOString(),
          });
        }
        host.detachRemote(loopId);
        return json(res, 200, { ok: true });
      }

      const outputFor = /^\/output\/([^/]+)$/.exec(rest);
      if (outputFor && method === 'GET') {
        return json(res, 200, host.output(decodeURIComponent(outputFor[1]!)));
      }

      const usageFor = /^\/usage\/([^/]+)$/.exec(rest);
      if (usageFor && method === 'GET') {
        return json(res, 200, await host.usageFor(decodeURIComponent(usageFor[1]!)));
      }
      if (rest === '/usage-history' && method === 'GET') {
        return json(res, 200, await host.usageHistory());
      }
      /*
       * The project the loops are building, and one of its files.
       *
       * The same two shapes as the loop endpoints below and deliberately so - the
       * panel renders either from one code path - but rooted at the base directory
       * and without their DELETE counterparts. See `listProjectFolders`.
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
        // `?folder=a/&folder=a/b/` - the folders the panel has open.
        return json(res, 200, await listProjectFolders(root, query.getAll('folder')));
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
        // The root only: the panel re-reads its open folders itself after a drop.
        return json(res, 200, await listProjectFolders(root));
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
    if (err instanceof Refusal) return json(res, err.status, { error: err.message });
    json(res, 500, { error: String(err) });
  }
});

/* ------------------------------------------------------------------ startup */

await registry.read();
await readConfig();

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

/*
 * Line the registry up with the disk: drop rows whose folder no longer holds a
 * factory, keep one row per folder and one per id. Only rows change, never a
 * factory folder. See `Registry.reconcile`.
 */
{
  const dropped = await registry.reconcile(docPath, newFactoryId);
  if (dropped.length > 0) {
    process.stdout.write(
      `  registry dropped ${dropped.length} ${dropped.length === 1 ? 'entry' : 'entries'} with no factory left on disk:\n` +
        dropped.map((d) => `    ${d}\n`).join(''),
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
