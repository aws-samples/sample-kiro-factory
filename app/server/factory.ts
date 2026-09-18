/**
 * The document. One JSON file is the whole factory.
 *
 * There is one component kind - a loop - and what it does is its prompt. The only
 * other thing it carries is `autoPause`, which is about when it runs rather than
 * what it does. Everything else on a loop is either identity (`id`, `name`) or
 * geometry (`x`, `y`), which exist because the canvas has to put the box
 * somewhere.
 *
 * Around the loops and wires sit three fields that describe the factory itself:
 * `id`, `name`, and `baseDir`. `baseDir` is the directory the loops run in - the
 * agents' working directory - and everything the factory needs on disk lives
 * under `<baseDir>/.kirofactory/`. That is the only place this program writes, so
 * pointing a factory at a project of your own does not scatter files through it.
 *
 * This object is also the interchange format. Export writes exactly this and
 * import reads exactly this, so a factory is one file you can mail to someone.
 *
 * There is no validator. A document either parses or it does not; anything past
 * that is a judgement about your design that a program has no business making.
 */
import * as fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NAME_ONLY, RESERVED, TOKEN } from './mcp.ts';

/**
 * The one folder a factory owns inside its base directory.
 *
 * Every queue, every loop's scratch space and the document itself live under
 * here. Named with a leading dot so it stays out of the way of whatever else is
 * in the directory, and used as the boundary for every delete this program does:
 * nothing outside it is ever removed.
 */
export const INTERNAL = '.kirofactory';

/** The document's file name inside `INTERNAL`. */
export const DOC_NAME = 'factory.json';

/**
 * A document that cannot be accepted as it stands.
 *
 * Thrown by `parse` for the one class of input it refuses rather than repairs, and
 * by `load` for a file that is not JSON at all. Its own type so the caller can tell
 * "the operator handed us something broken" from a genuine failure and answer with
 * a 400 or a warning rather than a 500 or a silent replacement.
 */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

/**
 * Is `target` inside `root`, once both are resolved? The root itself does not count.
 *
 * Every path this program deletes or moves is built from an id it read out of a
 * document, and a document can be hand-edited, imported, or cloned along with a
 * repository somebody else wrote. `parse` refuses ids that could escape, but a
 * refused id is one defence and a checked path is the other: neither is allowed to
 * be the only thing between an `rm -rf` and the directory above the factory. Every
 * mutation goes through this, independently of what the parser did.
 */
export function inside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t !== r && t.startsWith(r + path.sep);
}

/**
 * An id that is safe to build a path from.
 *
 * Ids become folder names - `loops/<id>`, `queues/<id>`, `topics/<id>/<id>` - so a
 * separator, a dot segment or an empty string in one is not an odd name, it is a
 * different directory. `#` is refused too, because `<loopId>#<n>` is how a cluster
 * member's session is keyed and an id carrying its own `#` would collide with that.
 * Anything else is allowed; this is about where a path resolves, not about taste.
 */
export function isSafeId(id: string): boolean {
  if (id.length === 0 || id === '.' || id === '..') return false;
  return !/[/\\#\0]/.test(id);
}

/**
 * The one directory a factory may not live in: the operator's home directory.
 *
 * Not a safety rail about writing to `$HOME` - a factory only ever writes inside its
 * own `.kirofactory/`, so a factory based there would touch exactly one folder. That
 * folder is the problem. The registry lives at `~/.kirofactory/factories.json`, so
 * `$HOME` is the single directory where a factory's internal folder and the registry's
 * own directory are the same path: the factory's document would appear beside the
 * list of factories, and the scan of `$HOME` would meet a directory that is both the
 * thing it is searching for and the place the answer gets written.
 *
 * Cheaper to refuse than to disambiguate, and nothing is lost. A factory based at
 * `$HOME` would have every project on the machine inside its working directory,
 * which is not a containment anybody wants for agents running with shell access.
 * Any folder below it is still fine, including `~/projects` and the like.
 *
 * A path is resolved before comparing, so `~/../<user>`, a trailing slash and a
 * relative walk back up all answer the same.
 */
export function isHomeDir(dir: string): boolean {
  return path.resolve(dir) === path.resolve(os.homedir());
}

/** Bumped only if the shape changes in a way a reader has to know about. */
export const FORMAT = 1;

export interface Loop {
  id: string;
  name: string;
  /** What the loop does. The same text is sent every iteration. */
  prompt: string;
  /**
   * Wait for work instead of taking a turn on an empty queue.
   *
   * Off by default, and off is the honest default: a loop whose input is a file
   * rather than a queue has nothing to wait for, and a turn against an empty
   * folder is cheap enough that spending one is not a bug. On, it is the setting
   * for a consumer that costs real money per turn - see `Runner` for what waiting
   * means and when it does not apply.
   */
  autoPause: boolean;
  /**
   * Let the loop stop itself when its agent judges the work done.
   *
   * Off by default. On, the agent is told it may declare "no further work" at the
   * end of a turn, and is then given exactly one more turn to confirm it - a turn
   * in which it contributed nothing and still sees nothing to do. Only the
   * confirmation stops the loop; a declaration followed by anything else is
   * withdrawn. Two iterations, not one, because a single "looks done to me" is
   * exactly the judgement an agent gets wrong when a queue is momentarily empty.
   * See `Runner` for the handshake.
   *
   * This is a different question from `autoPause`. Waiting for work is about the
   * queue being empty *now*; auto stop is about the job itself being finished -
   * which is also the only way a source loop, with no queue to wait on, can ever
   * end on its own.
   */
  autoStop: boolean;
  /**
   * Stop by count: end the run gracefully after this many turns of it.
   *
   * Turns of *this run*, not of the loop's lifetime - the `iteration` counter
   * deliberately survives restarts, and "stop after 5" pressed on a loop already
   * at #40 means five more, not stop on the spot. Absent means no cap. One of
   * the five run modes; exclusive with the other stop and wait fields.
   */
  stopAfterIterations?: number;
  /**
   * Stop by clock: end the run gracefully once this many hours have passed
   * since it started. Checked between turns, so a turn straddling the deadline
   * finishes first - the deadline decides whether another turn *starts*, never
   * kills one. Fractions are honoured (0.5 is half an hour); the panel's
   * stepper walks whole hours but the document is not so limited. Absent means
   * no deadline.
   */
  stopAfterHours?: number;
  /**
   * Left out of every start. Its own Start button, `Run all`, none of them
   * touch it; everything else - editing, wiring, being wired to - still works,
   * and a disabled loop's queues still receive items for the day it wakes.
   * The canvas greys it. This is the way to park a loop mid-design without
   * unwiring it or losing its settings.
   */
  disabled: boolean;
  /**
   * Which MCP servers this loop's agent is allowed to load.
   *
   * Absent means all of them - every server the machine's config enables, which
   * is what every loop did before this field existed and stays the default.
   * Present means scoped: the agent runs with only these servers, by name.
   * Servers the prompt names with `@` are granted on top of the list at turn
   * time, so writing `@aws-docs` in a scoped prompt never promises a tool the
   * agent does not have. An empty array is a loop with no MCP tools at all.
   */
  mcp?: string[];
  /**
   * Which built-in tool categories the loop's agent gets, by kiro-cli tag
   * (`read`, `write`, `shell`, ...).
   *
   * Absent means all of them, expressed to the agent as the `@builtin` wildcard
   * so new categories arrive with kiro-cli upgrades - the default, and what every
   * loop did before this field existed. Present means exactly these tags and
   * nothing else, deliberately frozen: a loop someone narrowed should not widen
   * because an upgrade shipped a new category.
   */
  tools?: string[];
  /**
   * Model the loop's agent runs on, by kiro-cli model id (`claude-haiku-4.5`).
   *
   * Absent means whatever kiro-cli would pick on its own - its configured
   * default - which is what every loop did before this field existed.
   */
  model?: string;
  /**
   * Seconds to idle between one turn ending and the next beginning.
   *
   * Absent means none: turn follows turn as fast as the agent can take them,
   * which is what every document written before this field existed meant and
   * stays the default. The wait is taken *after* a turn, so Start always
   * produces work immediately, and the deadline is re-derived from this number
   * while the loop sits out the wait - shortening a twelve-hour interval to a
   * minute brings the loop back in a minute, and removing it resumes at once.
   *
   * Orthogonal to the five run modes on purpose. Those answer "may another turn
   * start"; this answers "when", and every combination of the two is meaningful:
   * a waiting consumer that throttles itself once work arrives, a capped run
   * spread over a day, a forever loop polling an API on the hour.
   *
   * Interruptible: Stop and an operator message both cut it short. A loop that
   * made someone wait an hour to be heard would be a loop nobody talks to.
   */
  intervalSeconds?: number;
  /**
   * Run this component as several sessions rather than one - a loop cluster.
   *
   * Absent means a plain loop: one session, one folder, which is what every
   * document written before this field existed means by not having it. Present
   * means the component is `size` members, each an independent session running
   * this same prompt. See `Cluster`.
   */
  cluster?: Cluster;
  /**
   * Give each of this component's sessions its own checkout of the project.
   *
   * Absent means no, which is what every document written before this field
   * existed means by saying nothing. On, every session - the one session of a
   * plain loop, or each member of a cluster - works in its own linked worktree
   * of the repository the factory is based in, on a branch of its own, so two
   * sessions editing the same file are editing two files.
   *
   * This is the intent only. Where the checkouts actually landed is per machine
   * and per member, so it lives in the `worktrees.json` sidecar rather than
   * here - an exported document must not carry absolute paths into one
   * machine's filesystem. See worktrees.ts.
   *
   * Read once, at start: provisioning happens in `Host.startLoop`, and a
   * session's checkout is part of its runner's construction, so a mid-run edit
   * changes nothing until the next start. The panel disables the checkbox while
   * the component runs for exactly that reason.
   */
  worktree?: boolean;
  x: number;
  y: number;
}

/**
 * A loop cluster: one component on the canvas, several agent sessions behind it.
 *
 * The whole design rests on one decision - a cluster is N *runners*, not one
 * runner driving N sessions. Each member gets its own `Runner`, so it gets its
 * own state machine, generation counter, abort controller, idle poll and
 * auto-stop handshake, all of which already exist and are already correct. The
 * alternative was making every scalar on `Runner` an array of N and rechecking
 * every invariant, for no gain.
 *
 * It is also what makes a cluster genuinely equivalent to N hand-drawn loops
 * rather than approximately so. `channelDir` keys on the producer *loop*, so
 * every member of a consuming cluster reads the one queue folder and they race
 * for items by atomic rename - the work pool falls out of the existing layout
 * with no new code. Topics behave the same way: a topic folder belongs to the
 * subscribing loop, and that loop's members compete over it.
 *
 * What a cluster does *not* share is `@loop`. Members claim items into
 * `loops/<id>/m<n>/` rather than into one folder, because the claim protocol
 * moves the item there and the folder also holds a member's notes to its own
 * next iteration. One folder for N members would have them claiming over each
 * other's filenames and reading each other's memory as their own.
 */
export interface Cluster {
  /**
   * `fixed` is exactly `size` members, the same as having drawn that many loops.
   * `scaled` spawns one member per waiting item instead - event-driven, and
   * `size` becomes the ceiling rather than the count.
   */
  mode: ClusterMode;
  /**
   * Members when `fixed`; the most there may ever be when `scaled`.
   *
   * A ceiling is not optional on the scaled mode. One member per message with
   * nothing bounding it means a backlog of four hundred items spawns four
   * hundred `kiro-cli` subprocesses, which does not degrade - it takes the
   * machine down. One field serves both readings honestly, and the panel labels
   * it "up to N" when the mode is scaled.
   */
  size: number;
  /**
   * Whether members can see each other.
   *
   * `isolated` is the default and the subagent-shaped one: a member gets its
   * item and that is all it ever knows: no view of its siblings, no shared
   * state beyond the queue they compete over.
   *
   * `flock` gives them a radius-1 ring - see `flockLog` and the prompt's flock
   * section. Deliberately the smallest thing that could be called coordination:
   * append-only, own file only, two neighbours, no quorum and no global view.
   */
  comms: ClusterComms;
}

export type ClusterMode = 'scaled' | 'fixed';
export type ClusterComms = 'isolated' | 'flock';

export const CLUSTER_MODES: readonly ClusterMode[] = ['scaled', 'fixed'];
export const CLUSTER_COMMS: readonly ClusterComms[] = ['isolated', 'flock'];

/**
 * The smallest cluster there is.
 *
 * Two rather than one, for every mode and both comms settings. A cluster of one
 * is a loop with extra machinery around it and a stack drawn as a single box -
 * it says "several" and behaves as "one", which is the worst of both. The panel's
 * stepper floors here and the parse clamps here, so a hand-written `1` becomes 2
 * rather than an error.
 */
export const CLUSTER_MIN = 2;

/**
 * The most members a cluster may have.
 *
 * Every member is a `kiro-cli` subprocess on this machine, not a task in a
 * cloud, so the ceiling is the operator's own laptop. Sixteen is well past what
 * is comfortable and far short of what is fatal, which is the right place for a
 * guard rail: it exists to catch a typed `500`, not to express a considered
 * limit.
 */
export const CLUSTER_MAX = 16;

/** How a member of a cluster is named apart from its loop. See `memberId`. */
export const MEMBER_SEP = '#';

/**
 * The key one member of a cluster is known by, everywhere outside the document.
 *
 * `<loopId>#<n>`. Runners are keyed by this, status frames carry it as their
 * `id`, and output lines carry it as their `loop`. A plain loop's key is its
 * bare id, unchanged, which is what lets every existing route, frame and client
 * map keep working untouched - a document with no clusters in it produces
 * exactly the traffic it did before this existed.
 *
 * `#` because it cannot appear in a loop id: ids become folder names, the app
 * generates them as `loop-<base36>`, and the skill tells hand-writers letters,
 * digits and dashes. It survives a URL as `%23`, which the routes' `[^/]+`
 * matches, so no route pattern had to change either.
 */
export function memberId(loopId: string, member: number): string {
  return `${loopId}${MEMBER_SEP}${member}`;
}

/**
 * Split a runner key back into the loop it belongs to and which member it is.
 *
 * `member` is undefined for a plain loop's bare key, which is the signal used
 * throughout: undefined means "this component is one session and owns
 * `loops/<id>/` outright".
 */
export function splitMemberId(key: string): { loopId: string; member?: number } {
  const cut = key.lastIndexOf(MEMBER_SEP);
  if (cut < 0) return { loopId: key };
  const n = Number(key.slice(cut + MEMBER_SEP.length));
  if (!Number.isInteger(n) || n < 0) return { loopId: key };
  return { loopId: key.slice(0, cut), member: n };
}

/** How many sessions a component runs: 1 for a plain loop, `size` for a cluster. */
export function memberCount(loop: Loop): number {
  return loop.cluster ? loop.cluster.size : 1;
}

/**
 * Every runner key a component has, in member order.
 *
 * One bare id for a plain loop; `size` member keys for a cluster, whatever its
 * mode. A scaled cluster's keys all exist even when only some of them are live -
 * the supervisor starts and stops runners against this fixed set rather than
 * inventing keys, so a member that retires and comes back is the same member
 * with the same folder and the same iteration count.
 */
export function memberKeys(loop: Loop): string[] {
  if (!loop.cluster) return [loop.id];
  return Array.from({ length: loop.cluster.size }, (_, n) => memberId(loop.id, n));
}

/**
 * How a wire delivers, and the only choice a wire offers.
 *
 * `queue` is the default and the sharing one: every queue wire out of a loop
 * resolves to the *same* folder, so the producer writes an item once and the
 * loops on the other end compete for it. One item goes to exactly one reader.
 * Two loops wired to one producer is a work pool, not a duplicate.
 *
 * `topic` is the broadcasting one: the wire gets a folder of its own, the
 * producer writes a copy into each, and every subscriber therefore sees every
 * item. This is what fanning out used to do unconditionally.
 *
 * The mode belongs to the producer, not to the individual wire. Every wire out of
 * one loop carries the same value, always: a loop either has one queue that its
 * consumers compete over, or a folder per consumer and everybody gets everything.
 * There is no mixed fan-out. It is still *stored* per wire, because that is what
 * round-trips through a document and what the panel edits, but `normaliseModes`
 * makes the agreement true of any document that arrives and `producerMode` is how
 * to ask what a loop's mode is.
 *
 * It used to be genuinely per wire, so a loop could queue to two workers and topic
 * to a logger at once. That was more expressive and worse. The mixed state is
 * invisible on the canvas - a wire looks the same either way - and the two things
 * an operator actually reasons about are "one shared backlog" and "a copy each",
 * neither of which a half-and-half fan-out is. Switching one wire and finding its
 * siblings unchanged looked like a bug because the thing it was expressing was not
 * a thing anyone wanted. A second producer loop says it more legibly.
 */
export type WireMode = 'queue' | 'topic';

export const WIRE_MODES: readonly WireMode[] = ['queue', 'topic'];

export interface Wire {
  id: string;
  /** Loop id the items come from. */
  from: string;
  /** Loop id the items go to. */
  to: string;
  /**
   * Shared with the producer's other queue wires, or a copy of its own.
   *
   * Always equal to every other wire out of the same loop: see `WireMode`. Set it
   * through the producer, never on one wire alone.
   */
  mode: WireMode;
}

/**
 * One of the factory's parameters: a name a prompt writes as `@name`, and the value
 * it stands for.
 *
 * The one thing in a prompt that is substituted rather than defined. Everything else
 * an operator can write with - `@project`, `@input`, `@some-server` - resolves to a
 * folder or a capability that `prompt.ts` explains in a section above the
 * instruction, because those things are too large to sit inside a sentence. A
 * parameter is the opposite: it is a short value the sentence reads *through*, so
 * `research @topic thoroughly` should reach the agent with the topic in it. See
 * `applyParameters`.
 *
 * The document keeps the name, never the value. That is what makes a parameter worth
 * having: the prompt is written once and the value is changed from the bar without
 * editing it, and a loop mid-run picks the new value up on its next iteration
 * because the substitution happens per turn rather than at save.
 *
 * Factory-level, alongside `baseDir`, rather than per loop. A parameter is what this
 * run of the factory is *about* - the topic, the repository, the depth - and every
 * loop in it wants the same answer. Per-loop values would make a factory of six
 * loops six places to change one thing, and the loops would disagree.
 */
export interface Parameter {
  /**
   * The token, without the `@`. Matches `NAME_ONLY`: a parameter that cannot be
   * written as a reference is one no prompt can reach.
   */
  name: string;
  /** What `@name` becomes. Free text; blank is allowed and reads as unset. */
  value: string;
  /** What it is for, for whoever inherits the factory. Absent when not worth saying. */
  description?: string;
}

export interface Factory {
  /** Format marker, so an exported file says what it is. */
  kirofactory: number;
  id: string;
  name: string;
  /** Absolute path the loops run in. Internals go under `<baseDir>/.kirofactory`. */
  baseDir: string;
  /**
   * Named values the prompts here can write as `@name`. Absent means none, which is
   * what every document written before this field existed means by saying nothing.
   */
  parameters?: Parameter[];
  loops: Loop[];
  wires: Wire[];
}

/** What a factory looks like in the registry: enough to list it in a tab. */
export interface FactoryRef {
  id: string;
  name: string;
  baseDir: string;
  /**
   * Is this factory a tab right now?
   *
   * The registry keeps every factory it has ever seen, so an entry outliving its
   * tab is the ordinary case rather than a leak: `false` means closed but still
   * known, which is what makes a closed factory findable again without having to
   * remember where it lives. Entries written before this field existed read as
   * `true`, because back then being listed at all was what being open meant.
   */
  open: boolean;
}

export function newFactoryId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * The factory's parameters off a document, or nothing at all.
 *
 * Entries are dropped rather than corrected, which is the one place this parse is
 * stricter than the rest of the file. A cluster with a nonsense size is clamped
 * because there is an obviously intended meaning to clamp it to; a parameter named
 * `my topic` has none - it cannot be written as `@my topic` and be found again, so
 * keeping it would put a row in the bar that no prompt can ever reach. Dropping it
 * is the honest answer to a name that does not work.
 *
 * Reserved names go the same way. `@input` is defined by `prompt.ts` with a protocol
 * attached, and a parameter of that name would be a row in the bar that silently
 * does nothing, since substitution deliberately never touches the reserved
 * vocabulary.
 *
 * First of a duplicate wins, matched case-insensitively because that is how
 * substitution matches: two rows differing only in case are one parameter with two
 * values, and the later one could never be reached.
 *
 * An empty result is `undefined` rather than `[]`, so a factory whose last parameter
 * was deleted writes the same document it had before any existed. No `"parameters":
 * []` left behind in the file.
 */
function parseParameters(input: unknown): Parameter[] | undefined {
  if (!Array.isArray(input)) return undefined;

  const out: Parameter[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isObject(raw)) continue;
    const name = str(raw.name, '').trim();
    const key = name.toLowerCase();
    if (!NAME_ONLY.test(name) || RESERVED.has(key) || seen.has(key)) continue;
    seen.add(key);
    const description = str(raw.description, '').trim();
    out.push({
      name,
      value: str(raw.value, ''),
      ...(description.length > 0 ? { description } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The operator's text with its parameters filled in, and the ones it named.
 *
 * Only parameters with a value are substituted. A blank one is left as `@name` and
 * reported back as named, so `prompt.ts` can say it is unset: putting the blank in
 * would turn "research @topic thoroughly" into "research  thoroughly", which is a
 * sentence that still reads as an instruction and quietly asks for something else.
 * A token left standing is a placeholder the agent can see and mention; a token
 * replaced by nothing is a changed instruction nobody can see.
 *
 * A token matching no parameter is left exactly as it is. It may be a server, or it
 * may be prose - an `@` in a prompt does not have to be a reference - and this is
 * not the function that decides which.
 *
 * Substitution runs on the operator's text only, never on the sections this program
 * writes around it. Those name `@project` and `@input` as themselves, and a
 * parameter unlucky enough to be called `project` is already refused by the parse.
 */
export function applyParameters(
  text: string,
  parameters: Parameter[] = [],
): { text: string; named: Parameter[] } {
  if (parameters.length === 0) return { text, named: [] };

  const byName = new Map(parameters.map((p) => [p.name.toLowerCase(), p]));
  const named = new Map<string, Parameter>();

  const filled = text.replace(TOKEN, (whole, token: string) => {
    const found = byName.get(token.toLowerCase());
    if (found === undefined) return whole;
    named.set(found.name.toLowerCase(), found);
    return found.value.trim().length > 0 ? found.value : whole;
  });

  // In document order rather than in the order the prompt happens to mention them:
  // the bar reads top to bottom and the prompt's section should match it.
  return { text: filled, named: parameters.filter((p) => named.has(p.name.toLowerCase())) };
}

/** Identity and location to fall back on when the document does not carry them. */
export interface Defaults {
  id: string;
  name: string;
  baseDir: string;
}

/**
 * Read a document. Never throws: a file that is missing, malformed or half-written
 * opens as an empty canvas rather than taking the server down with it.
 *
 * `defaults` supply identity and location for a document that has none, which is
 * every document written before those fields existed and every hand-written one.
 */
export function parse(input: unknown, defaults: Defaults): Factory {
  const raw = isObject(input) ? input : {};

  const loops: Loop[] = (Array.isArray(raw.loops) ? raw.loops : [])
    .filter(isObject)
    .map((l, i) => {
      /*
       * The run mode, one of five, resolved with a precedence rather than an
       * error. Absent everything means run forever, which is what every
       * document written before any of these fields existed meant by not
       * having them.
       *
       * A hand-written document carrying several resolves narrowest-first: auto
       * stop, then the iteration cap, then the clock, then waiting. The panel's
       * dropdown reads the fields back with the same precedence - which is what
       * makes the shown mode the one that runs - though it lists the choices in
       * a different order, for the reader rather than for the resolver.
       */
      const autoStop = bool(l.autoStop, false);
      const afterIterations =
        !autoStop &&
        typeof l.stopAfterIterations === 'number' &&
        Number.isFinite(l.stopAfterIterations) &&
        l.stopAfterIterations >= 1
          ? Math.round(l.stopAfterIterations)
          : undefined;
      const afterHours =
        !autoStop &&
        afterIterations === undefined &&
        typeof l.stopAfterHours === 'number' &&
        Number.isFinite(l.stopAfterHours) &&
        l.stopAfterHours > 0
          ? l.stopAfterHours
          : undefined;
      const autoPause =
        bool(l.autoPause, false) && !autoStop && afterIterations === undefined && afterHours === undefined;

      /*
       * The cluster, or nothing at all.
       *
       * Absent is the plain loop and stays the default forever: a document with
       * no `cluster` key on any loop is a document from before clusters existed,
       * and it opens and runs identically. Present but nonsense - a size of one,
       * a mode nobody recognises, `{}` - resolves to something runnable rather
       * than throwing, which is the rule the whole of this parse follows: a
       * malformed document opens as the nearest sensible canvas, never as an
       * error page.
       *
       * `size` is clamped rather than rejected. A hand-written 1 becomes
       * CLUSTER_MIN because a cluster of one is a loop dressed as several, and a
       * hand-written 500 becomes CLUSTER_MAX because every member is a
       * subprocess on this machine.
       */
      /*
       * The interval, in whole seconds, or absent for none.
       *
       * Outside the run-mode precedence above, because it is a different
       * question: those decide whether another turn starts, this decides when.
       * Zero, negative and unparseable all resolve to absent rather than to a
       * zero-second wait - a document is only carrying this field to say there
       * *is* a delay, and `intervalSeconds: 0` written by hand means the same as
       * not writing it, so it should round-trip as not written.
       *
       * Whole seconds because the panel's rungs are whole seconds and a
       * sub-second delay between agent turns is noise: a turn costs seconds at
       * the very least, so anything finer is a wait nobody can observe.
       */
      const intervalSeconds =
        typeof l.intervalSeconds === 'number' &&
        Number.isFinite(l.intervalSeconds) &&
        l.intervalSeconds >= 1
          ? Math.round(l.intervalSeconds)
          : undefined;

      const rawCluster = isObject(l.cluster) ? l.cluster : undefined;
      const cluster: Cluster | undefined =
        rawCluster === undefined
          ? undefined
          : {
              mode: CLUSTER_MODES.includes(rawCluster.mode as ClusterMode)
                ? (rawCluster.mode as ClusterMode)
                : 'fixed',
              size: Math.min(
                CLUSTER_MAX,
                Math.max(CLUSTER_MIN, Math.round(num(rawCluster.size, CLUSTER_MIN))),
              ),
              comms: CLUSTER_COMMS.includes(rawCluster.comms as ClusterComms)
                ? (rawCluster.comms as ClusterComms)
                : 'isolated',
            };

      return {
        id: str(l.id, `loop-${i + 1}`),
        name: str(l.name, str(l.id, `Loop ${i + 1}`)),
        prompt: str(l.prompt, ''),
        autoPause,
        autoStop,
        ...(afterIterations !== undefined ? { stopAfterIterations: afterIterations } : {}),
        ...(afterHours !== undefined ? { stopAfterHours: afterHours } : {}),
        disabled: bool(l.disabled, false),
        // Absent means unrestricted and default model, matching every document
        // written before these fields existed. Spread rather than set to undefined,
        // so a document without them round-trips without the keys appearing.
        ...(Array.isArray(l.mcp) ? { mcp: l.mcp.filter((s): s is string => typeof s === 'string') } : {}),
        ...(Array.isArray(l.tools)
          ? { tools: l.tools.filter((s): s is string => typeof s === 'string') }
          : {}),
        ...(typeof l.model === 'string' && l.model.length > 0 ? { model: l.model } : {}),
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
        ...(cluster !== undefined ? { cluster } : {}),
        // True or absent, never false: an untouched document round-trips without
        // the key, and one that turned the setting off goes back to saying nothing.
        ...(bool(l.worktree, false) ? { worktree: true } : {}),
        x: num(l.x, 80 + (i % 4) * 260),
        y: num(l.y, 80 + Math.floor(i / 4) * 200),
      };
    });

  /*
   * The one thing this parser refuses rather than repairs.
   *
   * Everything else in a document is coerced to something usable, because a
   * document a version behind or a hand edit with a typo should open rather than
   * fail. An id is different: it is not read back to the operator, it is used to
   * build the path of a folder that will later be emptied or removed, and a
   * document is not a trusted source of paths - it arrives with a cloned repository
   * as readily as it is written by this program. Repairing one (renaming it) would
   * silently detach every wire that named it, so the honest answer is to refuse the
   * document and say which id, and the caller decides what that means: a 400 for a
   * canvas save, a 422 for an import, a quarantined file at startup.
   *
   * Duplicates are refused for the same reason: two loops with one id are one
   * folder, and whichever of them is deleted takes the other's work with it.
   */
  const seen = new Set<string>();
  for (const l of loops) {
    if (!isSafeId(l.id)) throw new DocumentError(`loop id ${JSON.stringify(l.id)} is not a usable folder name`);
    if (seen.has(l.id)) throw new DocumentError(`two loops share the id ${JSON.stringify(l.id)}`);
    seen.add(l.id);
  }

  const ids = new Set(loops.map((l) => l.id));
  const raws = (Array.isArray(raw.wires) ? raw.wires : [])
    .filter(isObject)
    .map((w, i) => ({
      id: str(w.id, `wire-${i + 1}`),
      from: str(w.from, ''),
      to: str(w.to, ''),
      mode: WIRE_MODES.includes(w.mode as WireMode) ? (w.mode as WireMode) : undefined,
    }))
    // A wire to a loop that is not there cannot be drawn or run, so it is dropped
    // rather than carried around as a special case for every consumer.
    .filter((w) => ids.has(w.from) && ids.has(w.to));

  // A wire id never becomes a path - folders are keyed on the loops at its ends -
  // but the canvas selects and deletes by it, and two wires with one id would make
  // "delete this wire" delete the other one too. Refused like a duplicate loop.
  const wireIds = new Set<string>();
  for (const w of raws) {
    if (wireIds.has(w.id)) throw new DocumentError(`two wires share the id ${JSON.stringify(w.id)}`);
    wireIds.add(w.id);
  }

  /*
   * Fan-out written before modes existed reads as a topic, not a queue.
   *
   * A document from then meant one thing by two wires out of a loop: a copy down
   * each. Defaulting those to `queue` would quietly turn a broadcast into a work
   * pool and halve what each reader sees, so the old meaning is preserved and
   * only wires drawn from now on get the new default. A lone wire is the same
   * under either mode, so it becomes the plain one.
   */
  const fanOut = new Map<string, number>();
  for (const w of raws) fanOut.set(w.from, (fanOut.get(w.from) ?? 0) + 1);
  const wires: Wire[] = normaliseModes(
    raws.map((w) => ({
      id: w.id,
      from: w.from,
      to: w.to,
      mode: w.mode ?? ((fanOut.get(w.from) ?? 0) > 1 ? 'topic' : 'queue'),
    })),
  );

  const parameters = parseParameters(raw.parameters);

  return {
    kirofactory: FORMAT,
    id: str(raw.id, defaults.id),
    name: str(raw.name, defaults.name),
    // Resolved, so a relative path in a hand-edited or imported file cannot make
    // the workspace depend on where the server happened to be started.
    baseDir: path.resolve(str(raw.baseDir, defaults.baseDir)),
    ...(parameters !== undefined ? { parameters } : {}),
    loops,
    wires,
  };
}

export function empty(defaults: Defaults): Factory {
  return parse({}, defaults);
}

/** The document's path for a given base directory. */
export function docPath(baseDir: string): string {
  return path.join(baseDir, INTERNAL, DOC_NAME);
}

/**
 * Read the document in a directory.
 *
 * Absent and unreadable are two different answers and this returns them
 * differently: no file is an empty factory, which is what a fresh directory
 * means; a file that is not JSON, or a document `parse` refuses, throws a
 * `DocumentError`. It used to return empty for both, and the caller then saved the
 * empty document over the broken one and pruned every queue folder as orphaned -
 * so a truncated write, which the non-atomic save of the time made routine, cost
 * the whole canvas and every unclaimed item at the next start. A folder with a
 * broken document in it is a different problem from a folder with nothing in it,
 * and it is the caller's to report, not this function's to paper over.
 */
export async function load(baseDir: string, defaults: Defaults): Promise<Factory> {
  const file = docPath(baseDir);
  if (!existsSync(file)) return empty(defaults);
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    throw new DocumentError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parse(raw, defaults);
}

/**
 * Write the document, atomically.
 *
 * Written to a sibling temp file and renamed into place, so what is at `docPath`
 * is always a complete document: a crash, a full disk or a kill during the write
 * leaves the previous document rather than half of the new one. The canvas saves
 * on every edit, debounced to a few hundred milliseconds, which is a lot of writes
 * to be one power cut away from a truncated file - and a truncated file is exactly
 * the input `load` now refuses. A rename within one directory is atomic on every
 * filesystem this runs on.
 */
export async function save(factory: Factory): Promise<void> {
  const file = docPath(factory.baseDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(factory, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * The mode every wire out of one loop shares, or undefined if it has none.
 *
 * Reads the first wire because they all agree - see `WireMode` for why that is an
 * invariant rather than a hope, and `normaliseModes` for what enforces it.
 */
export function producerMode(wires: Wire[], from: string): WireMode | undefined {
  return wires.find((w) => w.from === from)?.mode;
}

/**
 * Make every producer's wires agree on a mode.
 *
 * `topic` wins a disagreement, and the direction matters. A mixed document is
 * either hand-edited or was written while mode really was per wire, and in both
 * cases some consumer was promised its own copy of everything. Resolving to `topic`
 * keeps that promise: nobody who had a private copy is demoted into competing for a
 * shared pool, and no item silently goes to one consumer instead of three. The
 * other direction loses deliveries to fix a formatting problem.
 */
function normaliseModes(wires: Wire[]): Wire[] {
  const broadcasting = new Set(wires.filter((w) => w.mode === 'topic').map((w) => w.from));
  return wires.map((w) => (broadcasting.has(w.from) ? { ...w, mode: 'topic' as const } : w));
}

/** Wires into a loop, and wires out of it. */
export function wiresOf(factory: Factory, loopId: string): { reads: Wire[]; writes: Wire[] } {
  return {
    reads: factory.wires.filter((w) => w.to === loopId),
    writes: factory.wires.filter((w) => w.from === loopId),
  };
}

/**
 * The folder a wire delivers into, relative to the base directory.
 *
 * This is the whole implementation of both modes, and the one thing to understand
 * about the layout: the folder is named after the *loops*, never after the wire.
 * A queue wire resolves to its producer's one queue folder, so every queue wire
 * out of that loop returns the same string and they share a backlog by simply
 * being the same directory. A topic wire resolves to a folder of its own, keyed by
 * subscriber.
 *
 * So this function is not injective, and callers have to expect that: counting,
 * creating, deleting and pruning all work on the set of distinct folders rather
 * than one per wire. Keying on loop ids instead of wire ids also means a wire
 * deleted and drawn again finds its work where it left it, and a renamed loop
 * does not move its queue.
 *
 * Relative to the factory's base directory - the runner's `home` - which is
 * where the machinery lives whatever directory the agent works in. It used to
 * be safe to hand this string to the agent as-is, because the agent's cwd was
 * always the base directory; per-session checkouts broke that, so the prompt
 * now resolves every machinery path against `home` and names it absolutely.
 * See `buildPrompt`.
 */
export function channelDir(wire: Wire): string {
  return wire.mode === 'topic'
    ? path.join(INTERNAL, 'topics', wire.from, wire.to)
    : path.join(INTERNAL, 'queues', wire.from);
}

/** The distinct folders a document's wires deliver into. */
export function liveChannelDirs(factory: Factory): Set<string> {
  return new Set(factory.wires.map(channelDir));
}

/** Wires that deliver into the same folder as `wire`, including itself. */
export function sharing(factory: Factory, wire: Wire): Wire[] {
  const dir = channelDir(wire);
  return factory.wires.filter((w) => channelDir(w) === dir);
}

/**
 * The folder a loop owns for scratch and results, relative to the base directory.
 *
 * For a cluster this is the parent of the members' folders rather than any one
 * member's `@loop`, which is deliberate and is what the file panel wants: select
 * a cluster and you see every member's scratch plus the flock log, in one tree.
 * A member's own folder is `memberDir`.
 */
export function loopDir(loopId: string): string {
  return path.join(INTERNAL, 'loops', loopId);
}

/**
 * What a cluster member is called anywhere a person reads it: `n1`, `n2`, `n16`.
 *
 * One-based, and the index behind it is not. Members are an array, a ring position
 * and a modulo - all of which want to start at zero - while the thing an operator
 * points at is the first node, the second node. So the index stays zero-based in
 * the code and this is the only place the two meet.
 *
 * Every surface goes through it: the strip of tabs in the panel, the prompt each
 * member is handed, and the folder it owns on disk. That last one is why this
 * exists as a function rather than as a `+ 1` at each call site - the tabs saying
 * `n1` while the file panel showed `m0` beside it is exactly the sort of quiet
 * mismatch nobody notices writing and everybody notices reading.
 */
export function nodeLabel(member: number): string {
  return `n${member + 1}`;
}

/**
 * The folder one cluster member owns - its `@loop`.
 *
 * A folder each rather than one shared, and this is the only place a cluster
 * departs from "N loops wired identically". Taking an item off a queue *moves*
 * it into `@loop`, and `@loop` is also where a member writes the notes that are
 * its entire memory between turns. Point N members at one folder and they claim
 * over each other's filenames and read each other's notes as their own history.
 *
 * Nested under the loop's folder rather than sitting beside it, so `loopDir`
 * stays the one path that means "everything this component wrote" - for the file
 * panel, for the clear button, and for anyone looking at the directory by hand.
 *
 * Named by `nodeLabel`, so the folder in the file panel is called what the tab
 * above the log is called.
 */
export function memberDir(loopId: string, member: number): string {
  return path.join(loopDir(loopId), nodeLabel(member));
}

/**
 * A member's `@loop`, whichever kind of component it belongs to.
 *
 * The one call sites want: a plain loop owns `loops/<id>/` outright, a member
 * owns `loops/<id>/m<n>/`, and nothing outside this function needs to branch on
 * which it is holding.
 */
export function ownDirFor(loopId: string, member?: number): string {
  return member === undefined ? loopDir(loopId) : memberDir(loopId, member);
}

/**
 * Where a flock member appends what it wants its neighbours to see.
 *
 * One file per member, written only by that member, only ever appended to. That
 * is the whole concurrency story: no locking, no read-modify-write, and no way
 * for a member to damage a sibling's log because it never opens one for writing.
 *
 * Beside the member folders rather than inside them, because the logs are the one
 * thing in a cluster that is read across members and keeping them together is
 * what makes the ring legible when you go and look at the directory.
 */
export function flockLog(loopId: string, member: number): string {
  return path.join(loopDir(loopId), 'flock', `${nodeLabel(member)}.ndjson`);
}

/**
 * Which members a flock member watches: its neighbours in the ring, radius 1.
 *
 * The two either side, wrapping, which for a cluster of two is the same loop
 * member listed once rather than twice - the ring closes on itself and a member
 * must never be handed its own log as a neighbour's, or it reads its own last
 * turn as somebody else's work and defers to it.
 *
 * Radius is fixed at 1 and there is no setting for it. Wider visibility on a
 * cluster this size is mesh with extra steps: at size 5 a radius of 2 already
 * shows every member, so the dial would have exactly one useful position and one
 * position that lies about what it is doing.
 */
export function flockNeighbours(self: number, size: number): number[] {
  if (size < 2) return [];
  const left = (self - 1 + size) % size;
  const right = (self + 1) % size;
  return left === right ? [left] : [left, right];
}
