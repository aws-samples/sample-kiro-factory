/**
 * The loop: run a turn, run it again, until told to stop.
 *
 * One runner per session: per loop on the canvas, or per *member* of a loop
 * cluster. Two verbs, start and stop, because those are the only two the UI
 * offers and there is nothing else a loop needs.
 *
 * A cluster is N of these rather than one of these driving N sessions, which is
 * what keeps this file almost unchanged by clusters existing: every scalar below
 * - the state, the generation, the one abort controller, the one idle waker, the
 * auto-stop handshake - stays a scalar, because it describes one session and a
 * member *is* one session. The only member-shaped things here are `member`, which
 * only ever picks a folder and a ring position, and the flock broadcast at the end
 * of a turn. See `Cluster` in factory.ts for why that division was chosen.
 *
 * ## Waiting for work
 *
 * A loop with `autoPause` on checks its incoming queues before taking a turn, and
 * if they are all empty it waits rather than spending one. That is not a third
 * verb: nobody asks for a pause and nobody has to end one. The loop is `paused`
 * for as long as there is nothing to do and `running` again the moment an item
 * lands, and Stop still means stop throughout.
 *
 * Resuming by itself is the part that matters. A pause you have to leave by hand
 * deadlocks the ordinary shape of a factory - a slow producer feeding a fast
 * consumer starves the consumer, and by the time the producer emits there is
 * nobody left awake to read it. The queue is the signal, so it is the queue that
 * lifts the pause.
 *
 * Two things the check deliberately does not do. It does not fire for a loop with
 * no incoming wires, because a source has nothing to be starved of and pausing one
 * would mean ticking the box killed it on the spot. And it does not ask whether
 * the *last* turn had work: only the agent knows what it consumed, so the question
 * is the answerable one, is there anything there now.
 *
 * Still deliberately absent:
 *
 *  - **No manual pause.** Pause as a button is stop plus the expectation that
 *    state survives, and nothing here holds state between turns - the session is
 *    fresh each pass and the memory is on disk. Stop and start does the same thing
 *    honestly. The pause above is different: it is not a state you put the loop
 *    into, it is the loop reporting that it has nothing to do.
 *
 * ## Pacing
 *
 * `intervalSeconds` is the gap a loop leaves between one turn ending and the next
 * beginning. Absent by default, and absent is still the right default: turn after
 * turn is what a loop working through a backlog should do.
 *
 * This was a documented non-goal for a while, on the grounds that a fixed delay
 * was a workaround for a starved loop spinning and `autoPause` solved that
 * properly. That reasoning was sound and answered a different question. Waiting
 * for work is about whether there is anything to do; pacing is about how often to
 * ask, and there are loops for which the honest answer is "hourly" - one watching
 * an external system that only changes on its own schedule, one deliberately
 * spending a budget over a day, one whose turns cost a rate limit rather than a
 * queue. None of those is starvation and none of them has a queue that could
 * signal.
 *
 * So the two compose rather than compete, and every pairing means something: a
 * waiting consumer that also throttles once work arrives, a capped run spread out,
 * a forever loop polling on the hour. Which is why this is its own field and not a
 * sixth run mode.
 *
 * The wait is taken after a turn, so Start always produces work at once; it is
 * `paused` while it lasts, because that is what the state means; and Stop or a
 * message to the loop ends it early, because a loop that made someone wait an hour
 * to be heard is a loop nobody would talk to. See `waitInterval`.
 *
 * ## Run modes
 *
 * How a run ends is one setting of five, and exactly one - the parse enforces it,
 * because the combinations do not describe anything a person chose. In the order
 * the parse resolves them, narrowest first:
 *
 *  - `autoStop` - the agent ends the run when it judges the job done. Below.
 *  - `stopAfterIterations` - a cap on turns *this run*, checked before each turn.
 *  - `stopAfterHours` - a deadline from the start of the run, likewise.
 *  - `autoPause` - waits for work rather than spending a turn on an empty queue.
 *  - none of them - turns until Stop is pressed.
 *
 * The two counted modes are graceful in the same way `stop` is: they decide
 * whether another turn *begins*, never cut one short. Both count from the start
 * of the run rather than the loop's lifetime, so a cap set on a loop that has
 * already taken forty turns means what it says.
 *
 * A `disabled` loop is left out of every start - see `Host.startLoop`, which is
 * where that is enforced, since the guarantee is about running and not about
 * which buttons the UI draws.
 *
 * ## Stopping itself
 *
 * A loop with `autoStop` on may end its own run, and it takes two iterations to
 * do it. The first is the declaration: the agent finishes a turn, sees nothing
 * further to do, and says so with a `NO FURTHER WORK:` line. The second is the
 * confirmation: the next turn is told about the declaration and asked to either
 * find work - which withdraws it, silently, by being work - or contribute
 * nothing and close with `CONFIRM STOP:`. Only that second phrase stops the
 * loop.
 *
 * Two turns rather than one because "looks done to me" is precisely the
 * judgement an agent gets wrong on a queue that is momentarily empty, and the
 * cost of being wrong is asymmetric: a spurious extra turn costs cents, a
 * spurious stop strands a factory. kiro-flock's autopause reached the same shape
 * - three consecutive idle iterations across a quorum - for the same reason; this
 * is the single-loop version, with the quorum replaced by a handshake with
 * yourself.
 *
 * The declaration is withdrawn by anything that changes the picture: the agent
 * not repeating it, an operator message (someone leaning in clearly wants
 * something), or the run mode being changed away. `autoStop` and `autoPause`
 * are exclusive - waiting is a claim that more work is coming, auto stop a
 * claim that the work can finish, and the parse keeps a document from holding
 * both - so a confirmation turn is never held up by the wait-for-work check.
 */
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Driver } from './acp.ts';
import type { Factory, Loop, Wire } from './factory.ts';
import {
  channelDir,
  flockLog,
  flockNeighbours,
  memberId,
  ownDirFor,
  wiresOf,
} from './factory.ts';
import { listMcpServers, serversNamedIn } from './mcp.ts';
import { listSkills, listSteeringFiles } from './resources.ts';
import {
  BROADCAST_SENTINEL,
  buildPrompt,
  CONFIRM_SENTINEL,
  DECLARE_SENTINEL,
  type FlockView,
} from './prompt.ts';
import { Queue } from './queue.ts';

/**
 * `paused` is a live state, not a halfway house between the other two: the runner
 * is up, watching its queues, and will take the next turn without being asked.
 * Everything that cares whether a loop is going - the Stop button, the base
 * directory lock - must treat it the way it treats `running`. `stopped` is the
 * only state in which nothing is going to happen.
 *
 * `stopping` is live too, but on its way out: Stop was pressed while a turn was
 * in flight, and the turn is being allowed to finish. It exists so the box on
 * the canvas can say what the output log already says - final iteration,
 * shutting down - instead of reading `stopped` for the length of a drain that
 * can take minutes. Nothing new starts in it: the start guard treats it as not
 * stopped, so a loop cannot be restarted out from under its own drain.
 */
export type LoopState = 'stopped' | 'running' | 'paused' | 'stopping';

export interface LoopStatus {
  /**
   * The runner: a loop's bare id, or `<loopId>#<n>` for one member of a cluster.
   * See `memberId` - this is the key `Host.runners` uses, and the client's status
   * map uses the same one.
   */
  id: string;
  /** The component it belongs to. Equal to `id` unless this is a cluster member. */
  loop: string;
  /** Which member of the cluster. Absent on a plain loop. */
  member?: number;
  state: LoopState;
  /**
   * Why the runner is `paused`, present only while it is.
   *
   * `work` is a starved consumer waiting for an item; `interval` is a loop sitting
   * out the gap it was told to leave between turns. One state covers both because
   * from outside they are the same fact - up, idle, about to move - but the card
   * carries a separate mark for each setting and each mark goes live off its own
   * cause. Without this, a loop that both waits for work and throttles itself
   * would light the queue beacon while it was really just counting down.
   */
  pausedFor?: 'work' | 'interval';
  iteration: number;
  /**
   * The loop's last stop was its own: the agent confirmed there was nothing left
   * to do. Carried until the next start, so the canvas can say *why* a box is
   * stopped for as long as it stays that way - a factory someone walks back to
   * hours later should distinguish "converged" from "somebody pressed Stop".
   */
  autoStopped?: boolean;
  /**
   * When a `stopAfterHours` run runs out, as epoch ms. Present only while such a
   * loop is live.
   *
   * An absolute instant rather than a remaining duration, so the card can count
   * down on its own clock without asking the server every second. The cost is
   * that a browser whose clock disagrees with the server's counts down to the
   * wrong wall time - worth it, since the alternative is a poll per second per
   * card to display something nobody acts on to the second.
   */
  deadlineAt?: number;
  /**
   * When the next turn is due to open, as epoch ms. Present only while the loop is
   * sitting out its `intervalSeconds` - that is, exactly while `pausedFor` is
   * `interval`.
   *
   * An absolute instant for the same reason `deadlineAt` is one: the card counts
   * down on its own clock rather than asking per second. Recomputed and re-emitted
   * whenever the interval is edited mid-wait, so the number the card is counting to
   * is always the one the runner will act on.
   */
  nextTurnAt?: number;
}

/** One line of a loop's output, as the UI receives it. */
export interface OutputLine {
  /** The runner key: a bare loop id, or `<loopId>#<n>` for a cluster member. */
  loop: string;
  ts: string;
  /**
   * `text` is the agent talking, `tool` is it doing something, `system` is us,
   * `user` is the operator speaking to the loop, and `iteration` is the marker
   * that separates one turn from the next. `iteration-steered` is that same
   * marker for a turn opened by an operator message, drawn in the operator's
   * colour - after an interruption the plain marker read as an odd non sequitur
   * between the message and its answer.
   *
   * `iteration` is its own kind rather than another `system` line because the UI
   * draws it as a divider. Styling it by matching on the message text would break
   * the first time the wording changed.
   */
  kind: 'text' | 'tool' | 'system' | 'iteration' | 'iteration-steered' | 'user';
  text: string;
}

/**
 * How many output blocks are kept per loop, so a long run cannot exhaust memory.
 * A block is one message, not one streamed token: see `say`.
 */
const OUTPUT_LIMIT = 500;

/**
 * How often a paused loop looks at its queues again.
 *
 * There is nothing to subscribe to: items are files an agent writes with its own
 * tools, in another process, so a poll is the only way to hear about one. Two
 * seconds against a turn that takes seconds to minutes is latency nobody will
 * notice, and a readdir of a folder with nothing in it is close to free.
 *
 * A watcher would be the tidier answer and is not worth it here - recursive watch
 * semantics differ per platform, fire on writes that are still in progress, and
 * would need this poll as a fallback anyway.
 */
const IDLE_POLL_MS = 2000;

/** The longest a loop waits after a failed turn, however many have failed in a row. */
const FAILURE_BACKOFF_MAX_S = 60;

/**
 * How a turn's text is scanned for the auto-stop phrases.
 *
 * Line-start, case-insensitive, and tolerant of markdown dressing (`**bold**`,
 * a heading, a blockquote) because agents decorate: kiro-flock's exact-match
 * predicate missed 69% of its idle broadcasts to exactly this. Deliberately not
 * tolerant of `-` or a backtick, so a turn that *restates the rule* - a bullet
 * quoting \`NO FURTHER WORK:\` back - does not read as invoking it.
 */
function sentinelRe(phrase: string): RegExp {
  return new RegExp(`^[ \\t*_#>]*${phrase}\\b`, 'im');
}

const DECLARE_RE = sentinelRe(DECLARE_SENTINEL);
const CONFIRM_RE = sentinelRe(CONFIRM_SENTINEL);

/**
 * Events: `status` (LoopStatus), `output` (OutputLine).
 */
export class Runner extends EventEmitter {
  readonly loopId: string;
  /**
   * Which member of a cluster this runner is, or undefined for a plain loop.
   *
   * Two things depend on it and nothing else does: which folder is this session's
   * `@loop` (see `ownDirFor`), and where it sits in the flock ring. Everything
   * else in this class is written against "one session" and a member is one
   * session, so there was nothing else to make member-aware.
   */
  readonly member?: number;
  /**
   * How this runner is keyed and reported: the loop's bare id, or `<loopId>#<n>`.
   *
   * Every status frame's `id` and every output line's `loop` carries this rather
   * than the loop id, so a cluster's five members are five distinguishable
   * streams. A plain loop's key is its unchanged loop id, which is why a document
   * with no clusters produces byte-identical traffic to before they existed.
   */
  readonly key: string;
  /**
   * Working directory of the turn: the factory's base directory, or this
   * session's own checkout when the loop opted into one.
   *
   * One of two roots where there used to be one, and the split is the whole of
   * what per-session worktrees changed in this class. `cwd` is where the agent
   * works - the project. `home` is where `.kirofactory` lives - the queues this
   * session counts and creates, its own folder, the flock ring, always the
   * factory's base directory, because the factory coordinating with itself must
   * not fork per session. Loop A writing into `<checkoutA>/.kirofactory` while
   * loop B reads `<checkoutB>/.kirofactory` is different folders and a factory
   * whose every wire silently stops delivering.
   *
   * Public and readonly: the host compares it against the sidecar on start, so
   * a stopped runner built before its checkout existed is rebuilt rather than
   * reused with the wrong directory. When the loop has no checkout,
   * `cwd === home` and everything collapses to what happened before the split.
   */
  readonly cwd: string;
  /** Where `.kirofactory` lives. Always the factory's base directory. */
  private readonly home: string;
  /**
   * The branch this session's checkout is on, when it has one. Only for the
   * prompt, which tells the agent what its working directory is a checkout of.
   */
  private readonly branch?: string;
  private readonly driver: Driver;
  private factory: Factory;

  private state: LoopState = 'stopped';
  private iteration = 0;
  private stopping = false;
  /**
   * Which run is the current one.
   *
   * Bumped by every start and every stop, and carried by the `run` task it began.
   * A task whose number no longer matches has been superseded and must unwind
   * without taking another turn or reporting any state.
   *
   * This exists because `stopping` cannot answer the question on its own. A stop
   * reports `stopped` at once and lets the turn in flight drain, which is
   * deliberate - see `stop` - but it means that for the length of that drain the
   * runner looks stopped to `start`, whose guard is exactly that. Pressing Start in
   * that window used to clear `stopping` and spawn a second `run`, and then the
   * draining one re-read `stopping`, found it false, and carried on: two tasks on
   * one loop, two turns per iteration, and a loop taking turns after being told to
   * stop. The number is not derived from the state, so it cannot be fooled by it.
   */
  private generation = 0;
  /**
   * Every `run` task still unwinding, so a shutdown can wait for all of them.
   *
   * A set rather than one field: a superseded task is still live for as long as its
   * turn takes to finish, and holding only the newest meant `finished` returned
   * while a subprocess was still going - the orphan this class is careful to avoid.
   */
  private readonly tasks = new Set<Promise<void>>();
  private readonly output: OutputLine[] = [];
  /**
   * Set while the loop is waiting between polls, so a stop lands at once instead
   * of after up to `IDLE_POLL_MS`. A paused loop is doing nothing, and taking two
   * seconds to admit it had been told to stop would look like a hung button.
   */
  private wakeIdle?: () => void;
  /**
   * Why the runner is `paused`, when it is: starved of work, or serving out its
   * interval between turns.
   *
   * The state is deliberately one state for both - from outside, a paused loop is
   * a paused loop, up and about to move - and the two are never live at once,
   * since one happens before a turn and the other after it. This exists only so
   * the sentence written when a stop lands mid-wait is the true one: "stopped
   * while waiting for work" said to a loop that was sitting out an interval sends
   * the operator looking for a queue that was never the problem.
   */
  private pausedFor?: 'work' | 'interval';
  /**
   * Aborts the turn in flight, if there is one. Held only for the length of the
   * turn; a graceful stop never touches it, a force stop fires it.
   */
  private turnAbort?: AbortController;
  /**
   * Operator messages waiting for the next turn.
   *
   * Every message lands here, whatever the loop was doing: sent mid-turn (the
   * turn is interrupted and the message opens its replacement), between turns,
   * paused, or stopped. Drained into the next turn's prompt, so a message is
   * delayed at worst and never lost. Survives a stop on purpose - a message
   * typed at a stopped loop is an instruction for whenever it next runs.
   */
  private readonly pendingSteer: string[] = [];
  /**
   * Set when `steer` kills the turn in flight, so `run` can tell that rejection
   * apart from the turn actually failing - one is the operator being heard, the
   * other is worth an error line. Consumed by the catch that reads it.
   */
  private steerInterrupted = false;
  /**
   * The recent log, captured at the moment of an interruption.
   *
   * A turn is a fresh session with no memory of the last one, so without this
   * the replacement turn could not know what the operator was reacting to - an
   * interruption of work it cannot see. Handed to the next prompt alongside
   * the message: see `recentTranscript` for what the slice is and why.
   */
  private interruptedTranscript?: string;
  /**
   * A `NO FURTHER WORK` declaration is pending: the next turn is the
   * confirmation turn. See "Stopping itself" in the header for the handshake.
   * Cleared by anything that changes the picture - the agent not repeating it,
   * an operator message, the box being unticked, a fresh start.
   */
  private stopDeclared = false;
  /**
   * The last stop was the loop's own doing - see `LoopStatus.autoStopped`.
   * Set at the moment of a confirmed stop, cleared by the next start; a manual
   * stop of an already-stopped loop cannot occur, so nothing else touches it.
   */
  private autoStopped = false;
  /**
   * Turns taken since the current run began, for `stopAfterIterations`.
   *
   * Separate from `iteration`, which is the loop's lifetime count and
   * deliberately survives a stop and start. A cap of five pressed on a loop
   * already at #40 has to mean five more turns, not a loop that stops before
   * taking one, so the cap counts from the start of the run.
   */
  private runTurns = 0;

  /** Failed turns since the last one that did not fail. Drives the back-off in `run`. */
  private consecutiveFailures = 0;
  /**
   * When the current run began, as epoch ms, for `stopAfterHours`. The deadline
   * is derived from this on every pass rather than stamped once, so editing the
   * number on a running loop moves it instead of needing a restart.
   */
  private runStartedAt = 0;
  /**
   * When the interval wait now in progress began, as epoch ms, for `nextTurnAt`.
   *
   * The instant the last turn ended, not the instant the next one is due: the due
   * time is derived from this plus the loop's current `intervalSeconds` on every
   * read, which is what lets an edit mid-wait move the target rather than needing
   * the wait restarted. Undefined whenever no interval wait is in progress, which
   * is also how `status` knows whether to report one.
   */
  private intervalSince?: number;

  constructor(opts: {
    loopId: string;
    factory: Factory;
    /** Working directory of the turn: the base directory, or this session's checkout. */
    cwd: string;
    /** Where `.kirofactory` lives. Always the factory's base directory. */
    home: string;
    /** The checkout's branch, when `cwd` is one. For the prompt only. */
    branch?: string;
    driver: Driver;
    /** Which member of a cluster. Omit for a plain loop. */
    member?: number;
  }) {
    super();
    this.loopId = opts.loopId;
    this.factory = opts.factory;
    this.cwd = opts.cwd;
    this.home = opts.home;
    if (opts.branch !== undefined) this.branch = opts.branch;
    this.driver = opts.driver;
    if (opts.member !== undefined) this.member = opts.member;
    this.key = opts.member === undefined ? opts.loopId : memberId(opts.loopId, opts.member);
  }

  status(): LoopStatus {
    const hours = this.loop?.stopAfterHours;
    return {
      id: this.key,
      loop: this.loopId,
      ...(this.member !== undefined ? { member: this.member } : {}),
      state: this.state,
      iteration: this.iteration,
      // Spread-in rather than always present, so the wire format only carries
      // these while they apply and older readers see the shape they know.
      ...(this.state === 'paused' && this.pausedFor !== undefined
        ? { pausedFor: this.pausedFor }
        : {}),
      ...(this.autoStopped ? { autoStopped: true } : {}),
      // Only for a live loop: on a stopped one the number would be a deadline
      // for a run that is not happening, and a card counting down to it would be
      // describing a future that has been cancelled.
      /*
       * Derived on every read rather than stamped when the wait began, so an
       * interval edited mid-wait moves the target the card is counting to.
       *
       * Gated on the state rather than on `intervalSince` having been cleared,
       * which is what keeps that field from needing a lifetime at all: this is
       * exactly true while the runner is paused on an interval, and `pausedFor` is
       * already cleared on every path out of the wait - including the stop that
       * cuts one short, which emits its own frame before the wait unwinds.
       */
      ...(this.state === 'paused' &&
      this.pausedFor === 'interval' &&
      this.intervalSince !== undefined &&
      this.loop?.intervalSeconds !== undefined
        ? { nextTurnAt: this.intervalSince + this.loop.intervalSeconds * 1000 }
        : {}),
      ...(hours !== undefined && this.state !== 'stopped'
        ? { deadlineAt: this.runStartedAt + hours * 3_600_000 }
        : {}),
    };
  }

  recentOutput(): OutputLine[] {
    return this.output;
  }

  /** The design changed under a running loop; the next turn uses the new prompt. */
  update(factory: Factory): void {
    this.factory = factory;
  }

  /**
   * Only a stopped loop starts. A paused one is already running - it is between
   * turns waiting for an item - and starting it again would reset the iteration
   * count, wipe the log and leave two `run` tasks on the same loop. This is what
   * makes `Run all` safe to press while some loops sit idle.
   */
  start(): void {
    if (this.state !== 'stopped') return;
    // Claims the loop for this run. Any earlier task - a turn still draining from a
    // stop a moment ago - is superseded by the bump and unwinds on its next check
    // instead of quietly continuing alongside this one.
    const generation = ++this.generation;
    this.stopping = false;
    // A fresh start is a fresh judgement: whatever the last run declared about
    // there being no work, the operator pressing Start has overruled it - and
    // the yellow "stopped itself" beacon comes down with it.
    this.stopDeclared = false;
    this.autoStopped = false;
    // Both counted stop modes measure this run, not the loop's history.
    this.runTurns = 0;
    this.consecutiveFailures = 0;
    this.runStartedAt = Date.now();
    this.state = 'running';
    /*
     * Neither the iteration counter nor the log resets. A stop and start is a
     * pause in one loop's life, not a new loop: iteration numbers keep counting
     * - which is also what makes keeping the log coherent, since a scroll with
     * two "Iteration 1"s in it was the reason the log used to be wiped - and the
     * operator's conversation with the loop survives the restart it usually
     * caused. The `started` line is the seam between runs; the buffer's cap
     * (`OUTPUT_LIMIT`) is what keeps a long-lived loop's log from growing
     * without bound.
     */
    if (this.iteration > 0) this.say('system', 'started again');
    this.emit('status', this.status());
    const task = this.run(generation);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /**
   * Stop after the current turn finishes.
   *
   * The in-flight turn is not killed. A turn is an agent halfway through editing
   * files, and interrupting one leaves the work in a state nobody chose. Waiting
   * costs seconds; the state reads `stopping` for the length of the drain so the
   * UI is honest about both the intent and the fact that the last turn is still
   * going, and flips to `stopped` when it is not. `forceStop` is the impatient
   * sibling that kills the turn instead.
   *
   * A paused loop has no turn to drain, so it stops now and says so - the wording
   * differs because promising to finish a turn that is not running would be a lie
   * the operator could sit and wait on.
   */
  stop(): void {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    const waiting = this.state === 'paused';
    const because = this.pausedFor === 'interval' ? 'between turns' : 'waiting for work';
    // Bumped as well as flagged, so the task is superseded rather than only asked to
    // notice. `stopping` alone is a request a later start can withdraw on its
    // behalf; the number cannot be withdrawn.
    this.generation += 1;
    this.stopping = true;
    // A paused loop has nothing to drain, so it is stopped the moment it is told.
    // A running one reads `stopping` while its last turn finishes - the state the
    // canvas paints yellow - and the handler below flips it to `stopped` when the
    // drain is actually done. The superseded task cannot do that itself: its
    // generation no longer matches, and `run` rightly refuses to let a task
    // report on a loop it no longer owns.
    this.state = waiting ? 'stopped' : 'stopping';
    this.say('system', waiting ? `stopped while ${because}` : 'stopping after this turn');
    this.emit('status', this.status());
    this.wakeIdle?.();
    if (this.state === 'stopping') {
      const generation = this.generation;
      void this.finished().then(() => {
        // Only if nothing else claimed the loop while the turn drained. A force
        // stop in that window already said `stopped`; saying it again is harmless
        // but saying it over a newer run's state would not be.
        if (this.generation !== generation || this.state !== 'stopping') return;
        this.state = 'stopped';
        this.emit('status', this.status());
      });
    }
  }

  /**
   * Stop now, killing the turn in flight.
   *
   * The graceful stop's trade, inverted: no waiting, and in exchange the agent
   * dies wherever it stood - possibly halfway through an edit, leaving files in
   * a state nobody chose. The button that calls this says so. The kill lands via
   * the turn's abort signal, which the driver turns into a dead subprocess and a
   * rejected turn; the rejected turn belongs to a superseded generation, so it
   * unwinds silently.
   */
  forceStop(): void {
    if (this.state === 'stopped') return;
    this.generation += 1;
    this.stopping = true;
    this.state = 'stopped';
    this.say('system', 'force stopped - the turn in flight was killed');
    this.emit('status', this.status());
    this.wakeIdle?.();
    this.turnAbort?.abort();
  }

  /**
   * An operator message for the loop, arriving whenever it arrives.
   *
   * An operator who interjects is reacting to something wrong *now* - a loop
   * stuck in a browser automation, an agent chasing the wrong file - so the
   * message does not wait its turn: a turn in flight is killed where it stands,
   * and the message opens the replacement immediately. kiro-cli allows no second
   * prompt on an active session ("Prompt already in progress" - measured, not
   * guessed), so interruption is not merely the preferred delivery, it is the
   * only immediate one. The recent log rides along as a transcript, because the
   * replacement is a fresh session that would otherwise have no idea what it
   * was that the operator interrupted.
   *
   * No turn in flight - between turns, paused, stopped - and the message simply
   * queues for the next one; a paused loop wakes for it, because the message is
   * work. Echoed into the output log first in every case, as its own kind, so
   * the scroll reads as the conversation it is.
   */
  steer(text: string): void {
    const message = text.trim();
    if (message.length === 0) return;
    this.say('user', message);
    this.pendingSteer.push(message);
    // An operator leaning in wants something, which is the opposite of there
    // being nothing to do: a pending stop declaration is withdrawn unheard.
    this.stopDeclared = false;

    if (this.turnAbort) {
      // Snapshot before the kill: the abort unwinds through `run`, and lines
      // written after it belong to the aftermath, not to what was interrupted.
      this.interruptedTranscript = this.recentTranscript();
      this.steerInterrupted = true;
      this.turnAbort.abort();
      return;
    }

    if (this.state === 'stopped') {
      this.say('system', 'the loop is stopped - the message will be in its next turn, once started');
    }
    // A loop waiting for work has been given some: the message is the work.
    this.wakeIdle?.();
  }

  /**
   * The recent log, flattened for a prompt.
   *
   * Not just the current iteration. It used to be, and the transcript was
   * routinely almost empty: the operator reacts to what they watched the *last*
   * iteration do, and by the time they have typed, a new iteration has often
   * already opened - slicing at its marker cut away exactly the thing being
   * reacted to. So the slice is simply the tail of the log: the last handful of
   * blocks whatever they are - the agent talking, tools running, iteration
   * markers, earlier operator messages - so the replacement turn reads the same
   * conversation the operator was reading. Only `system` lines are dropped;
   * they are our bookkeeping, not the work.
   *
   * Two caps, because blocks are wildly uneven: a whole turn's narration merges
   * into one text block while a tool line is a dozen characters. The block
   * count keeps the shape conversational; the character cap, taken from the
   * tail, keeps one enormous block from swallowing the budget - the most recent
   * output is the part the operator is reacting to.
   */
  private recentTranscript(): string {
    const BLOCKS = 15;
    const CAP = 6000;
    const lines = this.output
      .filter((l) => l.kind !== 'system')
      .slice(-BLOCKS)
      .map((l) => {
        if (l.kind === 'iteration' || l.kind === 'iteration-steered') return `--- ${l.text} ---`;
        if (l.kind === 'tool') return `[tool] ${l.text}`;
        if (l.kind === 'user') return `[operator] ${l.text}`;
        return l.text;
      });
    const joined = lines.join('\n').trim();
    return joined.length > CAP ? `…${joined.slice(-CAP)}` : joined;
  }

  async finished(): Promise<void> {
    // Snapshotted, because a task removes itself from the set as it settles and
    // iterating it while that happens is not something to rely on.
    await Promise.all([...this.tasks]);
  }

  /**
   * Whether this task should stop what it is doing.
   *
   * Two reasons, and the caller never needs to tell them apart: it was stopped, or
   * a newer run has taken the loop over. Either way this task is finished and must
   * not take another turn, report a state, or say anything.
   */
  private stale(generation: number): boolean {
    return this.stopping || generation !== this.generation;
  }

  private get loop(): Loop | undefined {
    return this.factory.loops.find((l) => l.id === this.loopId);
  }

  /**
   * Record a line, and stream it.
   *
   * The agent's text arrives token by token, so consecutive `text` chunks are
   * appended to the block already in progress rather than each becoming their own
   * entry. Without that, OUTPUT_LIMIT counts tokens instead of messages: a single
   * turn is easily more than 500 chunks, so the buffer would hold the tail of one
   * reply and nothing else, and every `iteration N` marker would already have
   * scrolled out of it.
   *
   * The chunk is still emitted as it arrives, so the UI streams. The client joins
   * consecutive text chunks the same way this buffer does.
   */
  private say(kind: OutputLine['kind'], text: string): void {
    const last = this.output[this.output.length - 1];
    if (kind === 'text' && last?.kind === 'text') {
      last.text += text;
    } else {
      this.output.push({ loop: this.key, ts: new Date().toISOString(), kind, text });
      if (this.output.length > OUTPUT_LIMIT) this.output.splice(0, this.output.length - OUTPUT_LIMIT);
    }
    // Keyed by the member rather than the loop, so a cluster's members are
    // separate streams the panel can switch between. Interleaving five agents'
    // narration into one buffer would merge their `text` blocks into each other.
    this.emit('output', { loop: this.key, ts: new Date().toISOString(), kind, text });
  }

  private async run(generation: number): Promise<void> {
    while (!this.stale(generation)) {
      const loop = this.loop;
      if (!loop) break; // deleted from the canvas mid-run

      /*
       * The two counted stop modes, checked before a turn rather than after.
       *
       * Before, because both answer the same question - may another turn start -
       * and asking it here means the mode can be set or edited on a running loop
       * and take effect on the next pass, like every other setting the loop
       * re-reads. A turn already in flight is never cut short by either: the
       * clock decides whether to begin one, not whether to finish one.
       */
      if (loop.stopAfterIterations !== undefined && this.runTurns >= loop.stopAfterIterations) {
        this.autoStopped = true;
        const n = loop.stopAfterIterations;
        this.say('system', `auto-stopped - ${n} ${n === 1 ? 'iteration' : 'iterations'} done, the cap for this run`);
        break;
      }
      if (
        loop.stopAfterHours !== undefined &&
        Date.now() >= this.runStartedAt + loop.stopAfterHours * 3_600_000
      ) {
        this.autoStopped = true;
        this.say('system', `auto-stopped - the time limit for this run is up (${describeHours(loop.stopAfterHours)})`);
        break;
      }

      /*
       * The pacing interval, between the two stop checks above and the turn below.
       *
       * After them, so a run that has just used its last permitted turn stops
       * rather than sitting out a twelve-hour wait it will never come back from -
       * the checks decide whether another turn happens at all, and there is no
       * sense pacing towards one that does not.
       *
       * Before `waitForWork`, so the queue is read as late as possible: an item
       * that lands during the interval should be seen by the check that follows
       * it, not waited for again afterwards.
       *
       * Skipped on the first turn of a run, which is what makes this an interval
       * *between* turns rather than a delay before Start does anything. Pressing
       * Start and watching nothing happen for an hour would be indistinguishable
       * from a loop that failed to start.
       */
      if (this.runTurns > 0) {
        await this.waitInterval(generation);
        if (this.stale(generation)) break;
      }

      // Read off `loop`, which is re-read from the document each pass, so changing
      // the run mode on a running loop takes effect on the next iteration rather
      // than needing a restart. `autoPause` and `autoStop` are exclusive - the
      // parse enforces it - so a loop mid-handshake is never held here waiting
      // for work it just declared does not exist.
      if (loop.autoPause) {
        await this.waitForWork(loop, generation);
        // The wait ends because work arrived, because we were stopped, or because a
        // newer run took over; the `while` condition sorts out which.
        if (this.stale(generation)) break;
      }

      this.iteration += 1;
      this.runTurns += 1;
      this.emit('status', this.status());

      // Which phase of the auto-stop handshake this turn is, frozen before the
      // turn: `stopDeclared` can be cleared mid-turn by an operator message, and
      // a confirmation given to a withdrawn declaration must not stop the loop -
      // the check below requires the flag to have survived the whole turn.
      const confirmTurn = loop.autoStop && this.stopDeclared;

      let failed = false;
      try {
        this.steerInterrupted = false;
        const turnText = await this.runTurn(loop);

        if (!loop.autoStop) {
          // The run mode moved away, possibly mid-handshake: the declaration
          // goes with it.
          this.stopDeclared = false;
        } else if (confirmTurn && this.stopDeclared && CONFIRM_RE.test(turnText)) {
          this.autoStopped = true;
          this.say(
            'system',
            'auto-stopped - the loop confirmed there is nothing left to do. Start runs it again.',
          );
          break;
        } else if (DECLARE_RE.test(turnText)) {
          // A re-declaration on a confirmation turn keeps the handshake open
          // rather than resetting it: the agent is still saying there is nothing
          // to do, just not in the confirming words. It gets another
          // confirmation turn, not a stop.
          if (!this.stopDeclared) {
            this.say('system', 'the loop declared no further work - one more turn to confirm or withdraw');
          }
          this.stopDeclared = true;
        } else if (this.stopDeclared) {
          this.stopDeclared = false;
          if (confirmTurn) this.say('system', 'the declaration was withdrawn - the loop carries on');
        }
      } catch (err) {
        // A failed turn must not kill the loop: report it and take the next one.
        // Unless this task has been superseded - a force stop kills the turn and
        // the kill surfaces here as a rejection, which is the stop working, not a
        // failure worth a line in the log. An operator interruption is the third
        // case: the kill is the message being heard, and the loop goes straight
        // into the turn that answers it.
        const interrupted = this.steerInterrupted;
        this.steerInterrupted = false;
        if (this.stale(generation)) {
          // superseded: nothing to report
        } else if (interrupted) {
          this.say('system', 'turn interrupted - your message opens the next one');
        } else {
          this.say('system', `turn failed: ${String(err)}`);
          failed = true;
        }
      }

      /*
       * Back off after a failure, harder after each one in a row.
       *
       * A turn that fails at once - kiro-cli refusing to start a session on an
       * expired login, a model id the subscription no longer offers, a checkout
       * that has gone read-only - used to be retried at once, and a loop with no
       * interval went straight back into the spawn. That is a hot loop: a few
       * failed processes a second per runner, a few dozen for a cluster, the
       * iteration count in the thousands, until somebody pressed Stop. None of
       * the run modes could end it, because no item was ever taken and no turn
       * ever spoke. Doubling from one second and capping at a minute keeps a
       * transient failure cheap - one retry a second later - and a persistent one
       * from costing anything but one attempt a minute. A turn that succeeds
       * resets the clock.
       */
      if (failed) {
        this.consecutiveFailures += 1;
        const seconds = Math.min(FAILURE_BACKOFF_MAX_S, 2 ** (this.consecutiveFailures - 1));
        if (this.consecutiveFailures > 1) {
          this.say('system', `${this.consecutiveFailures} turns failed in a row - waiting ${describeSeconds(seconds)} before trying again`);
        }
        await this.backOff(generation, seconds);
      } else {
        this.consecutiveFailures = 0;
      }
    }
    // Only the current task reports the loop stopped. A superseded one describing
    // the runner it used to own would set `stopped` over the state of the run that
    // replaced it, and the canvas would show a loop halted while it is taking turns.
    if (generation !== this.generation) return;
    this.state = 'stopped';
    this.wakeIdle = undefined;
    this.pausedFor = undefined;
    this.emit('status', this.status());
  }

  /**
   * Hold here for the loop's configured interval, if it has one.
   *
   * Returns at once when there is no interval, which is the default, so a loop
   * without one runs exactly as it did before this existed - no timer, no state
   * change, not a line in the log.
   *
   * The deadline is re-derived from the document on every slice rather than
   * stamped once, which is the same trick `stopAfterHours` uses and for the same
   * reason: an operator who shortens a twelve-hour interval to a minute means the
   * loop should be back in a minute, not in twelve hours. Turning it off mid-wait
   * resumes immediately. That is why this polls in slices instead of taking one
   * long `setTimeout` - a single timer cannot be told the number moved.
   *
   * The state is `paused` while waiting, which is exactly what that state says:
   * the runner is up and will take the next turn without being asked. It also
   * means `stop()` sees a loop with nothing to drain and stops it on the spot
   * rather than leaving the button dead until the wait expires.
   *
   * Called only from `run`, and only past the first turn of a run - see the note
   * there for why the position in that loop is load-bearing.
   */
  /**
   * Hold after a failed turn. See the note in `run`.
   *
   * Slices rather than one timer, like the other two waits, so a Stop or an
   * operator message during the hold is honoured within a slice instead of after
   * a minute. No state change and no `paused`: the loop is not waiting for work
   * or for its interval, it is recovering, and the line `run` already wrote says
   * so. A message waiting to be heard ends the hold at once - it may well be the
   * operator fixing the thing that failed.
   */
  private async backOff(generation: number, seconds: number): Promise<void> {
    const until = Date.now() + seconds * 1000;
    while (!this.stale(generation) && Date.now() < until && this.pendingSteer.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(IDLE_POLL_MS, until - Date.now())));
    }
  }

  private async waitInterval(generation: number): Promise<void> {
    if (this.stale(generation)) return;
    const seconds = this.loop?.intervalSeconds;
    if (seconds === undefined) return;
    // An operator message is already waiting to be heard: making it wait out an
    // interval as well would be the loop ignoring somebody for an hour.
    if (this.pendingSteer.length > 0) return;

    const since = Date.now();
    this.intervalSince = since;
    this.state = 'paused';
    this.pausedFor = 'interval';
    this.say('system', `waiting ${describeSeconds(seconds)} before the next turn`);
    this.emit('status', this.status());

    // Why the wait ended, so the line the operator reads is the true one - the
    // same contract `waitForWork` keeps. An empty string means the interval
    // simply elapsed, which needs no line: the next iteration marker says it.
    let resumed = '';
    // What the card is currently counting down to, so a change to it can be sent
    // and an unchanged one costs no traffic. Without this the choice would be a
    // status frame every slice - one per loop every two seconds for the length of
    // a twelve-hour wait, to report a number that has not moved.
    let target = since + seconds * 1000;
    while (!this.stale(generation)) {
      const current = this.loop;
      // Deleted from the canvas: nothing to resume and nobody to tell. `run` sees
      // the same absence and ends.
      if (!current) return;
      if (current.intervalSeconds === undefined) {
        resumed = 'the interval was removed - resuming';
        break;
      }
      // Edited mid-wait. Say so as well as re-emitting: the operator who moved it
      // is watching the log, and a countdown that jumps with no line beside it
      // reads as a glitch rather than as their own edit landing.
      const moved = since + current.intervalSeconds * 1000;
      if (moved !== target) {
        target = moved;
        this.say('system', `the interval is now ${describeSeconds(current.intervalSeconds)}`);
        this.emit('status', this.status());
      }
      const left = target - Date.now();
      if (left <= 0) break;

      await new Promise<void>((resolve) => {
        // Sliced rather than one long timer, so the loop notices the number
        // changing. Capped at the poll cadence and floored at the remainder, so a
        // ten-second interval is accurate to the second rather than rounded up to
        // the next slice.
        const timer = setTimeout(resolve, Math.min(IDLE_POLL_MS, left));
        // Stop and `steer` both resolve this early. Clearing the timer matters:
        // an unresolved timer keeps the process's event loop alive after a
        // shutdown.
        this.wakeIdle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeIdle = undefined;
      if (this.stale(generation)) return;

      if (this.pendingSteer.length > 0) {
        resumed = 'the operator said something - resuming';
        break;
      }
    }

    if (this.stale(generation)) return;
    this.state = 'running';
    this.pausedFor = undefined;
    if (resumed.length > 0) this.say('system', resumed);
    this.emit('status', this.status());
  }

  /**
   * Hold here while every queue feeding this loop is empty.
   *
   * Returns immediately in the two cases where waiting would be wrong: a loop with
   * no incoming wires, which is a source and has nothing to wait for, and a queue
   * that already has something in it, which is the common case and costs one
   * readdir per folder.
   *
   * The state only moves to `paused` if we are actually going to wait, so a loop
   * that never starves never reports a pause and the canvas does not flicker
   * between two states on every iteration.
   */
  private async waitForWork(loop: Loop, generation: number): Promise<void> {
    const dirs = this.incomingDirs(loop.id);
    if (dirs.length === 0) return;
    // An operator message is work too: it wants a turn to be heard in.
    if (this.pendingSteer.length > 0) return;
    if (await this.hasWork(dirs)) return;
    // The one `await` in this file that was followed by a write to `state` with no
    // staleness check between them. A Stop landing during that `readdir` set
    // `stopping` and armed the flip to `stopped`; this line then wrote `paused`
    // over it, the flip saw a state that was not `stopping` and declined, and the
    // runner sat at `paused` with no task behind it - Start refused, the directory
    // lock held, until a second Stop cleared a wait that was never happening.
    if (this.stale(generation)) return;

    this.state = 'paused';
    this.pausedFor = 'work';
    this.say('system', 'nothing on the incoming queue - waiting for work');
    this.emit('status', this.status());

    // Why the wait ended, so the line the operator reads is the true one. Coming
    // back because someone unticked the box is not work arriving, and saying so
    // would send them looking for an item that was never there.
    let resumed = '';
    while (!this.stale(generation)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, IDLE_POLL_MS);
        // Stop resolves this early. Clearing the timer matters: an unresolved
        // timer keeps the process's event loop alive after a shutdown.
        //
        // One waker for the runner rather than one per task, which is enough
        // because only one task waits here for long: a superseded one unwinds at
        // the check below, within a single poll of losing the loop. The cost is
        // that a stop landing inside that window waits out the poll instead of
        // returning at once, which is two seconds in a case that needs two
        // conflicting commands to reach.
        this.wakeIdle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeIdle = undefined;
      if (this.stale(generation)) return;

      // Re-read the loop each poll: the box may have been unticked, or the wires
      // redrawn, while we were waiting. Either one means stop waiting.
      const current = this.loop;
      // Deleted from the canvas: nothing to resume and nobody to tell. `run` sees
      // the same absence and ends.
      if (!current) return;
      if (!current.autoPause) {
        resumed = 'no longer waiting for work - resuming';
        break;
      }
      const now = this.incomingDirs(loop.id);
      if (now.length === 0) {
        resumed = 'nothing feeds this loop any more - resuming';
        break;
      }
      if (this.pendingSteer.length > 0) {
        resumed = 'the operator said something - resuming';
        break;
      }
      if (await this.hasWork(now)) {
        resumed = 'work arrived - resuming';
        break;
      }
    }

    if (this.stale(generation)) return;
    this.state = 'running';
    this.pausedFor = undefined;
    this.say('system', resumed);
    this.emit('status', this.status());
  }

  /**
   * The distinct folders this loop reads from.
   *
   * Deduplicated because queue wires sharing a producer resolve to one folder
   * (see `channelDir`), and asking the same directory twice would just be two
   * readdirs for one answer.
   */
  private incomingDirs(loopId: string): string[] {
    return [...new Set(wiresOf(this.factory, loopId).reads.map(channelDir))];
  }

  /** Whether any of those folders holds an item. A missing folder counts as empty. */
  private async hasWork(dirs: string[]): Promise<boolean> {
    const counts = await Promise.all(
      dirs.map((dir) => new Queue(path.join(this.home, dir)).count()),
    );
    return counts.some((n) => n > 0);
  }

  /**
   * One turn, returning everything the agent said in it.
   *
   * Returned rather than re-read from the output buffer, because the buffer is
   * shared, capped and merged: the caller scanning it for an auto-stop phrase
   * would be scanning earlier iterations too, and a declaration from three turns
   * ago must not read as this turn's.
   */
  private async runTurn(loop: Loop): Promise<string> {
    const { reads, writes } = wiresOf(this.factory, loop.id);
    // A plain loop owns `loops/<id>/`; a cluster member owns `loops/<id>/m<n>/`.
    // See `ownDirFor` for why members cannot share one - the claim protocol moves
    // items in here, and so do a member's notes to its own next turn.
    const ownDir = ownDirFor(loop.id, this.member);

    // Every folder this turn might touch exists before the turn starts, so an
    // agent finds an empty queue rather than a missing path. Deduplicated because
    // wires sharing a queue resolve to one folder.
    await fsp.mkdir(path.join(this.home, ownDir), { recursive: true });
    for (const dir of new Set([...reads, ...writes].map(channelDir))) {
      await new Queue(path.join(this.home, dir)).create();
    }

    // Re-read each turn rather than at start: the operator edits the MCP config
    // outside this app, so a server added mid-run is usable on the next pass
    // without stopping the loop. It is two small file reads against a turn that
    // takes seconds at best. Read from `cwd`, not `home`: kiro-cli reads the
    // copy in its own working directory, so anything else here would describe
    // servers the agent does not have.
    const allServers = await listMcpServers(this.cwd);

    /*
     * Skills and steering files, read the same way and for the same reason: fresh
     * each turn from `cwd`, so a skill dropped onto the machine mid-run is
     * nameable on the next pass without stopping the loop, and so the list
     * describes what kiro-cli will actually have loaded rather than what was
     * there when the run started.
     *
     * Input-gathering only. Nothing about the agent changes on the strength of
     * these - kiro-cli loads both regardless of what is in here - and the turn
     * request is untouched. They exist so the prompt can explain a name the
     * operator wrote.
     */
    const [skills, steeringFiles] = await Promise.all([
      listSkills(this.cwd),
      listSteeringFiles(this.cwd),
    ]);

    /*
     * The loop's MCP scope, resolved for this turn.
     *
     * No `mcp` field means trusted: the agent loads the machine's own config and
     * `granted` stays undefined, which is what the driver reads as "don't
     * interfere". A list means scoped, and the effective set is the list plus
     * whatever the prompt names with `@` - naming a tool is asking for it, and a
     * prompt that says `@aws-docs` must never run against an agent that does
     * not have it. Both halves are matched against the live config by name, so a
     * granted server that has since been removed or disabled simply drops out.
     *
     * `visible` is the same answer for the prompt's benefit: the servers whose
     * names may be described to the agent. For a trusted loop that is everything;
     * for a scoped loop, exactly what it was granted.
     */
    const scoped = loop.mcp !== undefined;
    /*
     * The factory's parameter names, which share the `@` namespace with the servers
     * and win it. Passed here and not only to the prompt because this is the
     * decision that hands a scoped loop a capability: without it a parameter called
     * `github` would grant the github server to a loop whose scope never listed it,
     * as a side effect of the operator setting a value. See `tokensIn` in mcp.ts.
     */
    const claimed = (this.factory.parameters ?? []).map((p) => p.name);
    const visible = scoped
      ? allServers.filter(
          (s) =>
            loop.mcp!.some((name) => name.toLowerCase() === s.name.toLowerCase()) ||
            serversNamedIn(loop.prompt, [s], claimed).length > 0,
        )
      : allServers;
    const granted = scoped ? visible.map((s) => ({ name: s.name, config: s.config })) : undefined;
    const mcpServers = visible;

    /*
     * Say which granted servers the config no longer has, every turn they are
     * missing. Dropping them out is right - the operator may have turned one off
     * on purpose - but dropping them silently is not: a scoped loop's whole point
     * is that its capabilities are stated, and a loop whose document says
     * `github` running with no `github` because `mcp.json` grew a trailing comma
     * this morning was a capability loss nothing reported. The prompt text still
     * says `@github`, the agent has no such tool, and it improvises. One line here
     * is what turns that into something the operator can see and fix.
     */
    if (scoped) {
      const have = new Set(allServers.map((s) => s.name.toLowerCase()));
      const missing = loop.mcp!.filter((name) => !have.has(name.toLowerCase()));
      if (missing.length > 0) {
        this.say(
          'system',
          `granted MCP server${missing.length === 1 ? '' : 's'} not in the config: ${missing.join(', ')} - ` +
            'this turn runs without it. Check mcp.json (a malformed file reads as empty).',
        );
      }
    }

    const nameOf = (id: string): string => this.factory.loops.find((l) => l.id === id)?.name ?? id;

    /*
     * Reads stay one entry per wire, writes are grouped by folder.
     *
     * The asymmetry is not an oversight, it follows from what sharing does to each
     * side. Downstream, one wire is one producer to describe, and two wires from
     * different producers are two things to say even if the folders were somehow
     * the same. Upstream, a shared queue is one place to write no matter how many
     * loops are reading it, and listing it once per reader would tell the agent to
     * write the same item three times into the same folder.
     *
     * `rivals` is the other half of that: the loops competing for a folder this
     * loop reads. Without it a contested queue looks private, and an item vanishing
     * mid-turn looks like a fault rather than someone else getting there first.
     */
    /*
     * Siblings count as rivals, and they are usually the only ones.
     *
     * A cluster member competes with its own siblings for every item on every
     * folder the component reads - that is what makes a cluster a work pool, and
     * `channelDir` gives it to us for free by keying on the loop rather than the
     * member. But it also means a *lone* consuming cluster reads a folder that
     * looks private by the wire graph and is not. Without this line every member
     * would be told it had the queue to itself, and an item vanishing mid-turn
     * would read as a fault worth investigating rather than as a sibling winning
     * the race.
     *
     * One collective phrase rather than a name per sibling: sixteen members would
     * otherwise produce sixteen near-identical names in a sentence whose only
     * point is "you are not alone here".
     */
    const siblings =
      loop.cluster !== undefined && this.member !== undefined
        ? [`your ${loop.cluster.size - 1} sibling ${loop.cluster.size === 2 ? 'member' : 'members'}`]
        : [];

    const rivalsOn = (dir: string, self: string): string[] => [
      ...siblings,
      ...this.factory.wires
        .filter((w) => channelDir(w) === dir && w.to !== self)
        .map((w) => nameOf(w.to)),
    ];

    const writesByDir = new Map<string, { dir: string; peers: string[]; mode: Wire['mode'] }>();
    for (const w of writes) {
      const dir = channelDir(w);
      const entry = writesByDir.get(dir) ?? { dir, peers: [], mode: w.mode };
      entry.peers.push(nameOf(w.to));
      writesByDir.set(dir, entry);
    }

    // The ring, read before the turn so the neighbours' words are in the prompt
    // rather than something the agent has to go and fetch. See `readFlock`.
    const flock = await this.readFlock(loop);

    /*
     * Every machinery path the prompt names is absolute, resolved against
     * `home` here because this class is the thing that knows where home is.
     * `channelDir`'s relative strings stay relative for everything above -
     * `rivalsOn` compares them, the map keys on them - and become absolute only
     * at the boundary where they turn into words for the agent.
     */
    const built = buildPrompt({
      loop,
      reads: reads.map((w) => {
        const dir = channelDir(w);
        return {
          dir: path.join(this.home, dir),
          peers: [nameOf(w.from)],
          mode: w.mode,
          rivals: rivalsOn(dir, w.to),
        };
      }),
      writes: [...writesByDir.values()].map((e) => ({ ...e, dir: path.join(this.home, e.dir) })),
      cwd: this.cwd,
      home: this.home,
      ownDir: path.join(this.home, ownDir),
      iteration: this.iteration,
      // Only when this session works in a checkout of its own: the prompt then
      // says what the directory is a checkout of and what to make of the
      // committed `.kirofactory` copy inside it.
      ...(this.cwd !== this.home ? { checkout: { branch: this.branch ?? 'its own branch' } } : {}),
      mcpServers,
      skills,
      steeringFiles,
      /*
       * Read off the document every turn rather than captured at start, which is
       * what makes a parameter worth having: changing a value reaches a running
       * loop on its next iteration, the same way an edited prompt does, because
       * the host hands each new document straight to the runners.
       */
      ...(this.factory.parameters !== undefined ? { parameters: this.factory.parameters } : {}),
      ...(this.member !== undefined && loop.cluster !== undefined
        ? { cluster: { self: this.member, size: loop.cluster.size, comms: loop.cluster.comms } }
        : {}),
      ...(flock !== undefined ? { flock } : {}),
      // Which auto-stop wording this turn gets, if any: the standing offer, or
      // the confirmation question when a declaration is pending.
      ...(loop.autoStop ? { autoStop: this.stopDeclared ? ('confirm' as const) : ('armed' as const) } : {}),
    });

    /*
     * Whatever the operator said since the last turn rides in with this one.
     *
     * Drained, not read: a steering message is spoken once. It is appended after
     * the built prompt rather than woven into it because it is not part of the
     * loop's standing instructions - it is the operator leaning in, and the agent
     * is told to treat it with exactly that priority. When the message killed a
     * turn to get here, that turn's transcript comes too: the agent must see
     * what the operator was reacting to, or the interruption reads as a non
     * sequitur.
     */
    const steered = this.pendingSteer.splice(0);
    const interrupted = this.interruptedTranscript;
    this.interruptedTranscript = undefined;
    const prompt = steered.length === 0 ? built : built + steerSection(steered, interrupted);

    if (steered.length > 0) {
      this.say('iteration-steered', `Iteration ${this.iteration} - answering your message`);
    } else {
      this.say('iteration', `Iteration ${this.iteration}`);
    }
    // One controller per turn, so a force stop kills exactly the turn in flight.
    // Cleared on the way out only if still ours: a force stop followed by a fresh
    // start can have the next turn's controller in place before this one unwinds.
    const abort = new AbortController();
    this.turnAbort = abort;
    // This turn's words alone, for the auto-stop scan - see the doc comment.
    let turnText = '';
    try {
      const result = await this.driver.runTurn({
        // The point of the whole split: the agent works in its own checkout
        // when it has one, and in the base directory when it does not.
        cwd: this.cwd,
        prompt,
        signal: abort.signal,
        ...(granted !== undefined ? { mcp: granted } : {}),
        ...(loop.tools !== undefined ? { tools: loop.tools } : {}),
        ...(loop.model !== undefined ? { model: loop.model } : {}),
        onText: (text) => {
          turnText += text;
          this.say('text', text);
        },
        // `kind: title` - `read: Reading notes.md`. A failure says so, since the
        // driver only reports a second time for a call that did not work.
        onTool: (info) =>
          this.say(
            'tool',
            `${info.kind ?? 'tool'}: ${info.title}${info.status === 'failed' ? ' - failed' : ''}`,
          ),
        // What kiro-cli says about its own setup - a server that would not connect,
        // an agent it could not resolve. In the log rather than nowhere, because a
        // loop whose tools failed to load has to be able to say so.
        onNote: (text) => this.say('system', text),
      });
      if (result.stopReason !== 'end_turn') this.say('system', `turn ended: ${result.stopReason}`);
    } finally {
      if (this.turnAbort === abort) this.turnAbort = undefined;
    }
    await this.broadcast(loop, turnText);
    return turnText;
  }

  /* ------------------------------------------------------------------ flock */

  /**
   * What this member's ring neighbours last said, for the prompt.
   *
   * Read here rather than left to the agent, and that is the simplification the
   * whole feature rests on. Telling an agent to go and read two files costs a
   * tool call it may skip, may misread, or may decide to write to; reading them
   * on this side costs a `readFile` and arrives in the prompt as text it cannot
   * avoid seeing. kiro-flock hands its agents paths because its filesystem is S3
   * behind an MCP bridge and there is no other way. Here the files are on the
   * same disk as this process.
   *
   * Missing or unreadable is not an error and produces no note: on the first
   * iteration nobody has written anything yet, and a member told its neighbour's
   * log "failed" would reasonably go and investigate the machinery instead of
   * doing its work.
   */
  private async readFlock(loop: Loop): Promise<FlockView | undefined> {
    if (this.member === undefined || loop.cluster?.comms !== 'flock') return undefined;
    const neighbours = await Promise.all(
      flockNeighbours(this.member, loop.cluster.size).map(async (n) => ({
        member: n,
        entries: await tail(path.join(this.home, flockLog(loop.id, n)), FLOCK_TAIL),
      })),
    );
    return { neighbours };
  }

  /**
   * Append this member's one line to its own flock log.
   *
   * Called after every turn of a flock member, whether or not the agent said
   * anything worth broadcasting, because the line is a heartbeat as much as a
   * message: a member that contributed nothing this turn is a fact its neighbours
   * need - it is the difference between "idle" and "gone". A log that only gets
   * written when there is news leaves a neighbour unable to tell a quiet member
   * from a dead one.
   *
   * `ts`, `iteration` and `member` are stamped here rather than taken from what
   * the agent wrote, so the fields the ring actually reasons about cannot be
   * wrong. Whatever the agent put after `BROADCAST:` fills the rest: parsed when
   * it is the JSON object it was asked for, and carried verbatim under `note`
   * when it is not, because a member's words are worth more to a neighbour than
   * the schema they arrived in.
   *
   * Only ever this member's own file, only ever appended. That is the entire
   * concurrency design: no member opens a sibling's log for writing, so there is
   * nothing to lock and no read-modify-write to lose a race in.
   */
  private async broadcast(loop: Loop, turnText: string): Promise<void> {
    if (this.member === undefined || loop.cluster?.comms !== 'flock') return;
    const said = BROADCAST_RE.exec(turnText)?.[1]?.trim();
    const stamp = { ts: new Date().toISOString(), iteration: this.iteration, member: this.member };
    let body: Record<string, unknown> = { action: 'no broadcast', result: 'the turn said nothing' };
    if (said !== undefined && said.length > 0) {
      try {
        const parsed: unknown = JSON.parse(said);
        // An array or a bare string is valid JSON and not a broadcast; only an
        // object can be merged, and anything else keeps the `note` treatment.
        body =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { note: said };
      } catch {
        body = { note: said };
      }
    }
    const file = path.join(this.home, flockLog(loop.id, this.member));
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify({ ...body, ...stamp })}\n`, 'utf8');
    } catch (err) {
      // The ring is coordination, not the work. A log that cannot be written is
      // worth saying once and is not worth failing a turn over.
      this.say('system', `could not write the flock log: ${String(err)}`);
    }
  }
}

/**
 * How many of a neighbour's entries a member is shown.
 *
 * Enough to see a direction rather than a snapshot - what a neighbour has been
 * doing, not just the last thing it said - and few enough that a ring of two
 * neighbours costs a few hundred characters of prompt. Five turns back is about
 * where a neighbour's recent history stops being informative and starts being
 * history.
 */
const FLOCK_TAIL = 5;

/** Captures whatever followed `BROADCAST:`, with the same tolerance for markdown. */
const BROADCAST_RE = new RegExp(`^[ \\t*_#>]*${BROADCAST_SENTINEL}:\\s*(.+)$`, 'im');

/**
 * The last `n` non-empty lines of a file, or none if it is not there.
 *
 * Reads the whole file, which is right at this size: a member's log is one short
 * line per turn, so even a long run is kilobytes, and seeking backwards through a
 * file to save reading a few of them would be machinery earning nothing.
 */
async function tail(file: string, n: number): Promise<string[]> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(-n);
  } catch {
    return [];
  }
}

/**
 * `2 hours`, `1 hour`, `30 minutes`. Only for the log line, so it reads as a
 * sentence: the document allows fractional hours and "0.5 hours are up" is not
 * how anyone says it.
 */
function describeHours(hours: number): string {
  if (hours < 1) {
    const mins = Math.round(hours * 60);
    return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  }
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

/**
 * `30 seconds`, `5 minutes`, `2 hours`, for the interval's log line.
 *
 * Largest whole unit that divides it, and nothing else: the panel's rungs are all
 * whole seconds, minutes or hours, so `1h 30m` never arises from the app and a
 * hand-written 5400 reading as `90 minutes` is honest rather than clumsy. Its own
 * function rather than a call into `describeHours` with a division, because the
 * interesting end of this range is seconds and that one's is hours - it rounds
 * anything under a minute away to `0 minutes`.
 */
function describeSeconds(seconds: number): string {
  const unit = (n: number, name: string): string => `${n} ${n === 1 ? name : `${name}s`}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/* ---------------------------------------------------------------- steering */

/**
 * The section operator messages ride into a turn's prompt with.
 *
 * Appended, not merged: the standing prompt describes the job, this describes
 * what the operator just said, and the agent is told which one wins. When the
 * messages interrupted a running turn, that turn's transcript leads the section
 * - the agent is a fresh session, and without seeing the interrupted work it
 * would be answering a complaint about something it never did.
 */
function steerSection(messages: string[], interrupted?: string): string {
  const said =
    messages.length === 1
      ? 'The operator sent this message since your last turn.'
      : 'The operator sent these messages since your last turn, oldest first.';
  const context =
    interrupted !== undefined && interrupted.length > 0
      ? 'The operator interrupted your previous turn to say this - the turn was stopped mid-work ' +
        'so you could hear it. This is the recent log up to the interruption: your last iterations ' +
        'talking and running tools, with `--- Iteration N ---` markers between turns and earlier ' +
        '`[operator]` messages inline. The message below is a reaction to it - read the log as the ' +
        'conversation so far, not as instructions to repeat:\n\n```\n' +
        interrupted +
        '\n```\n\n'
      : '';
  return (
    '\n\n## Operator steering\n\n' +
    context +
    `${said} It is direct instruction from the human watching this loop: it applies to this turn ` +
    'and takes priority over the routine above.\n\n' +
    messages.join('\n\n')
  );
}
