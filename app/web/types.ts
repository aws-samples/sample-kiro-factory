/** The document, mirrored from server/factory.ts. */
export interface Loop {
  id: string;
  name: string;
  prompt: string;
  /** Wait for an item instead of taking a turn on an empty queue. Off by default. */
  autoPause: boolean;
  /**
   * Stop itself when the agent judges the work done: declare on one turn, confirm
   * on the next, and only the confirmation stops the loop. Off by default.
   */
  autoStop: boolean;
  /** Stop after this many turns of the current run. Absent means no cap. */
  stopAfterIterations?: number;
  /** Stop once this many hours have passed since the run started. */
  stopAfterHours?: number;
  /**
   * Left out of every start - its own button, `Run all`, none of them touch it.
   * Everything else still works; the canvas greys it. Toggled only from the
   * button on the card.
   */
  disabled: boolean;
  /**
   * MCP servers this loop may load, by name. Absent means all of them - trusted,
   * the default. Present means scoped to the list, plus whatever the prompt names
   * with `@`, which is granted at turn time whether or not it is listed here.
   */
  mcp?: string[];
  /**
   * Built-in tool categories the loop's agent gets, by kiro-cli tag. Absent
   * means all of them, including categories future kiro-cli versions add;
   * present means exactly these, deliberately frozen.
   */
  tools?: string[];
  /** Model id the loop runs on. Absent means kiro-cli's own default. */
  model?: string;
  /**
   * Whole seconds to idle between turns. Absent means none, which is the default
   * and what every document written before this field existed meant. Taken after
   * a turn, so Start always produces work at once, and interruptible by Stop or
   * an operator message. Applies per session, so every member of a cluster waits
   * its own interval.
   */
  intervalSeconds?: number;
  /**
   * Run as several sessions rather than one - a loop cluster. Absent means a
   * plain loop, which is what every document written before this meant.
   */
  cluster?: Cluster;
  /**
   * Give each of this component's sessions its own checkout of the project - a
   * git worktree per session, on a branch of its own. Absent means no, which is
   * what every document written before this field existed means by saying
   * nothing. Intent only: the checkouts are made when the loop starts, and
   * where they landed lives in a server-side sidecar, never in the document.
   */
  worktree?: boolean;
  x: number;
  y: number;
}

/**
 * A loop cluster, mirrored from server/factory.ts.
 *
 * One component on the canvas, `size` agent sessions behind it, each running this
 * loop's prompt in its own session with its own `@loop` folder. Queues and topics
 * treat the members exactly as they would treat that many separately drawn loops:
 * they compete for items on the folders the component reads.
 */
export interface Cluster {
  /** `fixed` is exactly `size` members; `scaled` spawns one per waiting item. */
  mode: ClusterMode;
  /** Members when `fixed`, the ceiling when `scaled`. Between 2 and 16. */
  size: number;
  /** Whether members see each other: not at all, or a radius-1 ring. */
  comms: ClusterComms;
}

export type ClusterMode = 'scaled' | 'fixed';
export type ClusterComms = 'isolated' | 'flock';

/** A cluster of one is a loop with extra machinery, so two is the floor. */
export const CLUSTER_MIN = 2;
/** Every member is a subprocess on this machine, so there is a ceiling. */
export const CLUSTER_MAX = 16;

/** How a member is keyed apart from its loop: `<loopId>#<n>`. */
export const MEMBER_SEP = '#';

/** The key one cluster member is known by in status frames and output lines. */
export function memberId(loopId: string, member: number): string {
  return `${loopId}${MEMBER_SEP}${member}`;
}

/**
 * Every runner key a component has: one bare id for a plain loop, `size` member
 * keys for a cluster. The order is the member order, and the ring order too.
 */
export function memberKeys(loop: Loop): string[] {
  if (!loop.cluster) return [loop.id];
  return Array.from({ length: loop.cluster.size }, (_, n) => memberId(loop.id, n));
}

/** How many sessions a component runs. */
export function memberCount(loop: Loop): number {
  return loop.cluster ? loop.cluster.size : 1;
}

/**
 * What a cluster member is called anywhere a person reads it: `n1`, `n2`, `n16`.
 *
 * Mirrored from server/factory.ts, where the same function also names the member's
 * folder on disk - so the tab in the node bar and the folder in the file panel are
 * called the same thing. One-based on purpose: the index behind it is zero-based
 * because it is an array position and a ring modulo, and this is the one place the
 * two meet.
 */
export function nodeLabel(member: number): string {
  return `n${member + 1}`;
}

/**
 * The rungs the interval stepper walks, in seconds.
 *
 * A ladder rather than a step size, for the same reason `HOUR_STEPS` is one: the
 * useful values are not evenly spaced. Seconds for a smoke test, minutes for a
 * queue you are watching drain, hours for a loop polling something on someone
 * else's schedule. Twelve rungs cover four orders of magnitude, which ±1 second
 * cannot cross in a lifetime of clicking and a step coarse enough to reach a day
 * could never land on ten seconds.
 *
 * Zero leads, and is the default. It is a rung rather than a special case so the
 * arrows can walk down onto it: "no gap between turns" is a gap of zero, and the
 * document expresses it by leaving the field out.
 *
 * Typing is free between the rungs - the parse takes any whole number of seconds -
 * so an off-ladder value is a place to be rather than an error. Same courtesy the
 * hours ladder extends.
 */
export const INTERVAL_SECONDS: readonly number[] = [
  0, 10, 30, 60, 300, 900, 1800, 3600, 7200, 18000, 43200, 86400,
];

/**
 * A number of seconds in the shortest form that says it: `30s`, `5m`, `12h`.
 *
 * Every rung of the ladder above lands on exactly one unit, which is not a
 * coincidence - they were chosen to. An off-ladder value from a hand-edited
 * document falls out correctly too: 5400 reads as `90m`, which is honest, where
 * snapping it to the nearest rung would be the app editing someone's document to
 * make its own labelling tidier.
 *
 * Here rather than beside the control that renders it, because the card's beacon
 * and its countdown both name the same duration and the panel's tooltip does too.
 */
export function intervalLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * A duration token read back into seconds: `30s`, `5m`, `12h`, and compounds of
 * them like `1h30m`. Case-insensitive, whitespace anywhere is ignored.
 *
 * The inverse of `intervalLabel`, and the reason a field can be typed in units at
 * all. A bare number with a unit *label* beside it is ambiguous, because the label
 * moves as the value grows and the same digits then mean different things. A value
 * carrying its own unit is not: `5m` and `5s` are different strings, so there is
 * nothing left to resolve and nothing for the control to guess.
 *
 * A bare number still means seconds, which is what the field held before it spoke
 * units, so anyone typing `300` out of habit keeps getting five minutes.
 *
 * The round trip is deliberately not exact. `1h30m` comes back as 5400 and renders
 * again as `90m`, because `intervalLabel` says a duration one way. Re-rendering the
 * shorter form is a smaller surprise than the alternative, which is the app quietly
 * storing something other than what was typed to protect its own formatting.
 *
 * Anything else is `undefined`: an empty field, a stray word, a decimal. Seconds are
 * whole here, on the ladder and off it. Callers treat `undefined` the way they treat
 * a number out of range, which is to send nothing and leave the edit where it is.
 */
export function parseDuration(text: string): number | undefined {
  const token = text.replace(/\s+/g, '').toLowerCase();
  if (/^\d+$/.test(token)) return Number(token);
  if (!/^(?:\d+[smh])+$/.test(token)) return undefined;
  let seconds = 0;
  for (const [, digits, unit] of token.matchAll(/(\d+)([smh])/g)) {
    seconds += Number(digits) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  }
  return seconds;
}

/** One model a loop can run on, mirrored from server/models.ts. */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

/** What kiro-cli offered, mirrored from server/models.ts. */
export interface ModelCatalog {
  models: ModelInfo[];
  /** What runs when a loop does not choose. */
  defaultId?: string;
  /**
   * The server could not ask, so the empty list above means "unknown" rather than
   * "none". The difference is what the picker shows: a failure is worth saying out
   * loud and worth offering a retry, an empty catalogue is not.
   */
  failed?: true;
  /** Which failure, for the tooltip. */
  reason?: string;
}

/**
 * What a new loop starts out allowed to use, mirrored from server/grants.ts.
 *
 * `null` on an axis means all of them - the loop field left absent - and is a
 * different answer from the axis being unsaved: an operator can deliberately choose
 * "every tool" as their own default, which `saved` then reports as their decision.
 *
 * Per operator rather than per factory, so it is machine-wide state and lives in
 * the shell alongside the model catalogue rather than in a view that remounts.
 */
export interface GrantDefaults {
  /** Built-in tool tags, or null for every category kiro-cli ships. */
  tools: string[] | null;
  /** MCP server names, or null for every server this machine enables. */
  mcp: string[] | null;
  /**
   * Which axes the operator chose, as opposed to inheriting.
   *
   * The panel's hint turns on this and nothing else: somebody who has never thought
   * about what a loop may use gets told where to look, and somebody who has is left
   * alone even when their answer happens to match the shipped one.
   */
  saved: { tools: boolean; mcp: boolean };
}

/**
 * How a loop delivers. `queue` means its wires share one folder and its consumers
 * compete for what is in it; `topic` means a folder per consumer and everybody gets
 * everything.
 *
 * A property of the producer, not of one wire: every wire out of a loop carries the
 * same value. Stored per wire because that is what the document holds, but set
 * through the producer - see `setWireMode` in FactoryView.
 */
export type WireMode = 'queue' | 'topic';

export interface Wire {
  id: string;
  from: string;
  to: string;
  mode: WireMode;
}

/**
 * One of the factory's parameters, mirrored from server/factory.ts.
 *
 * A name a prompt writes as `@name`, and the value it stands for. The one reference
 * that is substituted into the operator's text rather than defined above it: the
 * others resolve to a folder or a capability too large to sit in a sentence, and
 * this resolves to a short value the sentence reads through.
 *
 * The document keeps the name, never the value - the substitution happens per turn,
 * so changing a value here reaches a running loop on its next iteration without the
 * prompt being edited.
 */
export interface Parameter {
  /** The token, without the `@`. Must be writable as a reference to be reachable. */
  name: string;
  /** What `@name` becomes. Blank reads as unset: the token is left standing. */
  value: string;
  description?: string;
}

export interface Factory {
  kirofactory: number;
  id: string;
  name: string;
  /** Absolute directory the loops run in. Internals live in its `.kirofactory/`. */
  baseDir: string;
  /**
   * Named values the prompts here can write as `@name`. Absent means none, which is
   * what every document written before this field existed means by saying nothing.
   */
  parameters?: Parameter[];
  loops: Loop[];
  wires: Wire[];
}

/** A factory as the tab strip knows it, before its document is loaded. */
export interface FactoryRef {
  id: string;
  name: string;
  baseDir: string;
  /**
   * Is this factory a tab right now?
   *
   * Always true on everything `/api/factories` answers with, since that list *is*
   * the tabs. It is here for `/api/factories/known`, which answers with every
   * factory the server has ever seen and needs a way to say which of them are
   * closed. That is the list behind the Factories tab in the Open picker.
   */
  open: boolean;
}

/**
 * What a scan of the home directory turned up, from `POST /api/factories/scan`.
 *
 * Three buckets rather than one list, because "we found twelve" is not the useful
 * sentence - eleven of them being factories you already have is.
 *
 * The entries come with the counts so a caller can say which factories those were.
 * They are not the new state of the list, though, and must not be used as it: they
 * are what the walk met, and the registry also holds factories it cannot reach - in a
 * pruned folder, on another volume, or in a directory that has since been deleted.
 * Ask `known()` for the list.
 *
 * `found` is the total the walk saw on disk, which is `added + updated + skipped`.
 * Sent rather than added up here so the server's arithmetic is the one shown.
 */
export interface ScanResult {
  found: number;
  /** Registered for the first time, or a copy registered under a new id. */
  added: FactoryRef[];
  /** Known factories whose folder had moved; the entry now points at the new one. */
  updated: FactoryRef[];
  /** Already registered at that exact directory, so left untouched. */
  skipped: FactoryRef[];
}

/**
 * One loop in the library, mirrored from server/library.ts.
 *
 * No `id`, `x` or `y`: a shared loop cannot know where it sits on your canvas, so
 * those are assigned when it is dropped into a factory.
 */
export interface LoopEntry {
  kirofactoryLoop: number;
  slug: string;
  /**
   * Which of the two this is, decided by the cluster shape being there.
   *
   * Sent by the server rather than worked out here, so the rule that separates a
   * loop from a cluster lives in one place. The picker groups on it.
   */
  kind: 'loop' | 'cluster';
  name: string;
  description: string;
  prompt: string;
  author: string;
  tags: string[];
  /**
   * The cluster this entry is, when it is one. Absent is a plain loop, and is what
   * every entry written before clusters could be saved means by saying nothing.
   *
   * Carried because the size, the mode and whether the members read each other are
   * part of what the prompt was written for rather than part of where the card sits.
   */
  cluster?: Cluster;
}

/**
 * A whole factory in the library, mirrored from server/library.ts.
 *
 * Keeps its loops' positions, unlike a loop entry: a factory is a graph and the
 * layout is the design. Drops `id` and `baseDir`, because every take-out is a new
 * factory and the directory to run it in is the one thing the entry cannot know.
 */
export interface FactoryEntry {
  kirofactoryLibrary: number;
  slug: string;
  kind: 'factory';
  name: string;
  description: string;
  author: string;
  tags: string[];
  /** Named values its prompts write as `@name`, carried with the design. */
  parameters?: Parameter[];
  loops: Loop[];
  wires: Wire[];
}

/**
 * The library, grouped as the picker shows it.
 *
 * Grouped by the server, which is where the disk layout and the loop-versus-cluster
 * rule both live. Partitioning a flat list here would be a second copy of that rule.
 */
export interface LibraryIndex {
  loops: LoopEntry[];
  clusters: LoopEntry[];
  factories: FactoryEntry[];
}

/** An empty library, for the state a view holds before the first answer arrives. */
export const NO_LIBRARY: LibraryIndex = { loops: [], clusters: [], factories: [] };

export interface LoopStatus {
  /**
   * The runner this describes: a loop's bare id, or `<loopId>#<n>` for one member
   * of a cluster. Not the loop id in the cluster case - see `loop` for that.
   */
  id: string;
  /**
   * The component the runner belongs to. Equal to `id` for a plain loop.
   *
   * Always sent, so nothing has to parse `id` to find out which card a frame is
   * about. A cluster produces one frame per member and the canvas needs them
   * grouped, which this is what makes cheap.
   */
  loop: string;
  /** Which member of a cluster this is. Absent on a plain loop. */
  member?: number;
  /**
   * `paused` is live: the loop is up and waiting for an item, and will take a turn
   * on its own when one lands. `stopping` is live too - Stop was pressed and the
   * final turn is draining. Anything asking "is this going" wants
   * `state !== 'stopped'`, not `state === 'running'`.
   */
  state: 'stopped' | 'running' | 'paused' | 'stopping';
  /**
   * Why it is `paused`, present only while it is: starved of work, or serving out
   * its interval between turns. The card has a mark per setting and each goes live
   * off its own cause, so a loop doing both does not light the wrong one.
   */
  pausedFor?: 'work' | 'interval';
  iteration: number;
  /**
   * The last stop was the loop's own: the agent confirmed there was nothing left
   * to do. Present only while true, cleared by the next start. The canvas paints
   * the "ends" mark yellow off this, so a converged loop reads differently from
   * one somebody stopped.
   */
  autoStopped?: boolean;
  /**
   * When an `stopAfterHours` run runs out, as epoch ms. Present only while such
   * a loop is live, so a card can count down on its own clock rather than
   * polling for a remaining time.
   */
  deadlineAt?: number;
  /**
   * When the next turn is due, as epoch ms. Present only while the loop is sitting
   * out its interval, so the card can count down to the next iteration the same way
   * it counts down to a run's deadline - locally, off an absolute instant, without
   * a request per second.
   */
  nextTurnAt?: number;
}

export interface OutputLine {
  /**
   * The runner that said it: a loop's bare id, or `<loopId>#<n>` for a cluster
   * member. Output is per member and stays per member - the member strip above
   * the log switches between them rather than interleaving, because five agents
   * narrating into one scroll is not a log anyone can read.
   */
  loop: string;
  ts: string;
  kind: 'text' | 'tool' | 'system' | 'iteration' | 'iteration-steered' | 'user';
  text: string;
}

/**
 * An MCP server a prompt can name, mirrored from server/mcp.ts.
 *
 * The name is both the config key and the token the operator types, so there is no
 * mapping to keep in step: what lands in the prompt is what the config calls it.
 */
export interface McpServer {
  name: string;
  scope: 'user' | 'workspace';
}

/**
 * A skill a prompt can name, mirrored from server/resources.ts.
 *
 * The description is what the picker shows as a hint and what the built prompt
 * repeats back to the agent. Both sides say the same thing about the skill because
 * both read it from the same frontmatter; there is nothing to keep in step.
 */
export interface Skill {
  name: string;
  scope: 'user' | 'workspace';
  description: string;
}

/**
 * A steering file a prompt can name, mirrored from server/resources.ts.
 *
 * `steeringFiles`, never `steering`: an operator steer message is a different
 * concept living in the same word, and the panel's message box is the only place
 * that one is named.
 */
export interface SteeringFile {
  name: string;
  scope: 'user' | 'workspace';
}

/** Everything a prompt in a factory can refer to beyond its wires and directories. */
export interface FactoryResources {
  skills: Skill[];
  steeringFiles: SteeringFile[];
}

/** One item on a wire. */
export interface QueueItem {
  id: string;
  ts: string;
  producer: string;
  payload?: unknown;
  artifact?: string;
}

/**
 * What the panel is showing. A loop and a wire are both selectable and need
 * different views, so the selection carries which it is rather than the panel
 * guessing from an id.
 */
export type Selection = { kind: 'loop'; id: string } | { kind: 'wire'; id: string };

/**
 * What a whole component is doing, from its members' statuses.
 *
 * The canvas draws one card per component, so a cluster's five frames have to
 * become one answer. Each field collapses the way the card reads it:
 *
 * `state` takes the most-alive member, in the order going, draining, waiting,
 * stopped. A cluster with one member working and four waiting is working, which
 * is what the border should say; the reverse reading would paint a busy cluster
 * as idle.
 *
 * `iteration` is the sum, because the number on the card answers "how much has
 * this component done" and a cluster of five that has taken three turns each has
 * done fifteen. A max would answer "how far has the furthest member got", which
 * is not a question anyone watching a canvas is asking.
 *
 * `autoStopped` needs *every* member converged and none of them live: one member
 * declaring there is nothing left to do says nothing about the cluster, and
 * painting the mark yellow off the first one to finish would call a cluster
 * converged while four members were still working.
 */
export function aggregate(loop: Loop, status: Map<string, LoopStatus>): LoopStatus {
  const keys = memberKeys(loop);
  const parts = keys.map(
    (key) => status.get(key) ?? { id: key, loop: loop.id, state: 'stopped' as const, iteration: 0 },
  );
  const has = (s: LoopStatus['state']): boolean => parts.some((p) => p.state === s);
  const state: LoopStatus['state'] = has('running')
    ? 'running'
    : has('stopping')
      ? 'stopping'
      : has('paused')
        ? 'paused'
        : 'stopped';
  const live = parts.filter((p) => p.state !== 'stopped');
  /*
   * Why the component is paused, and only when its paused members agree.
   *
   * They can disagree - one member starved of work while another counts out its
   * interval - and there is no honest way to pick a winner between two true
   * answers. Carrying neither leaves both beacons grey, which reads as "this
   * cluster is idle for the reasons its settings say" rather than as a claim about
   * which. The card's marks are still there to say what those settings are.
   */
  const paused = parts.filter((p) => p.state === 'paused');
  const why =
    paused.length > 0 && paused.every((p) => p.pausedFor === paused[0]!.pausedFor)
      ? paused[0]!.pausedFor
      : undefined;
  const due = parts
    .map((p) => p.nextTurnAt)
    .filter((t): t is number => t !== undefined);
  const nextTurnAt = due.length > 0 ? Math.min(...due) : undefined;
  return {
    id: loop.id,
    loop: loop.id,
    state,
    ...(state === 'paused' && why !== undefined ? { pausedFor: why } : {}),
    iteration: parts.reduce((sum, p) => sum + p.iteration, 0),
    ...(live.length === 0 && parts.every((p) => p.autoStopped) ? { autoStopped: true } : {}),
    // Members of a run start together, so their deadlines agree; the first live
    // one is as good an answer as averaging them and is the one actually ticking.
    ...(live.find((p) => p.deadlineAt !== undefined)?.deadlineAt !== undefined
      ? { deadlineAt: live.find((p) => p.deadlineAt !== undefined)!.deadlineAt }
      : {}),
    /*
     * The soonest next turn among the waiting members, because the question the
     * card answers is when *this component* next does something and the first
     * member to wake is the answer.
     *
     * The soonest rather than the first, unlike the deadline above: members of a
     * cluster finish their turns at different times, so they enter their intervals
     * at different times and their due times genuinely differ. A card counting to
     * the last of them would sit at two minutes while a member woke up and worked.
     */
    ...(nextTurnAt !== undefined ? { nextTurnAt } : {}),
  };
}

/** How many of a component's members are live, for the count on a cluster card. */
export function liveMembers(loop: Loop, status: Map<string, LoopStatus>): number {
  return memberKeys(loop).filter((key) => (status.get(key)?.state ?? 'stopped') !== 'stopped').length;
}

/**
 * One stream carries every factory's events, so status and output arrive tagged
 * with the factory they belong to and a view ignores what is not its own.
 */
export type Tagged<T> = T & { factory: string };
