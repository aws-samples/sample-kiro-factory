/**
 * One open factory: its document, its runners, and the folders it owns on disk.
 *
 * This is the state that used to be module-level in the server, which is exactly
 * what stopped there being more than one factory. Moving it into an object is the
 * whole of what tabs required; the server file became routing.
 *
 * Everything this class writes or deletes is under `<baseDir>/.kirofactory`. That
 * boundary matters more than it used to: the base directory is now a project of
 * yours rather than a folder inside the app, so a delete that escaped it would be
 * deleting your work. Every path is resolved and checked against it.
 */
import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Driver } from './acp.ts';
import {
  INTERNAL,
  channelDir,
  docPath,
  inside,
  isHomeDir,
  liveChannelDirs,
  memberKeys,
  parse,
  producerMode,
  save,
  splitMemberId,
  type Factory,
  type FactoryRef,
  type Loop,
  type WireMode,
} from './factory.ts';
import { listMcpServers, type McpServer } from './mcp.ts';
import { Queue, type QueueItem } from './queue.ts';
import {
  listSkills,
  listSteeringFiles,
  type Skill,
  type SteeringFile,
} from './resources.ts';
import { Runner, type LoopStatus, type OutputLine } from './runner.ts';
import {
  provision,
  readSessions,
  release,
  writeSessions,
  type Released,
  type SessionCheckout,
  type Sessions,
} from './worktrees.ts';

/** A frame going out to the browser, tagged with the factory it came from. */
export type Emit = (event: string, data: unknown) => void;

/**
 * A change refused because of what is running right now, not because of what it
 * says. The document may well be fine; it is the moment that is wrong. The route
 * answers 409 so the canvas can tell "try again once the loop is stopped" from
 * "this document is not acceptable" (`DocumentError`, 400).
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * How often a scaled cluster compares its live members against its backlog.
 *
 * The same two seconds a waiting loop polls its queues on, and for the same
 * reason: items are files another process writes, so there is nothing to
 * subscribe to. Against a turn that takes seconds at best, two seconds of
 * latency before the second member joins is not something anyone notices, and
 * the cost is one `readdir` per incoming folder.
 */
const SCALE_POLL_MS = 2000;

export class Host {
  private factory: Factory;
  private readonly driver: Driver;
  private readonly emit: Emit;
  private readonly runners = new Map<string, Runner>();
  /**
   * The worktree sidecar, cached so `runnerFor` can resolve a session's
   * checkout synchronously - it is called from the supervisor's poll and from
   * routes that have no business waiting on a file read. Loaded by `prepare`,
   * replaced by provisioning and release, which are the only writers.
   */
  private sessions: Sessions = {};

  constructor(factory: Factory, driver: Driver, emit: Emit) {
    this.factory = factory;
    this.driver = driver;
    this.emit = emit;
  }

  get id(): string {
    return this.factory.id;
  }

  get baseDir(): string {
    return this.factory.baseDir;
  }

  /** The one folder this factory owns, and the boundary for every delete. */
  get internal(): string {
    return path.join(this.factory.baseDir, INTERNAL);
  }

  doc(): Factory {
    return this.factory;
  }

  /**
   * What the registry needs to list this factory, minus whether it is a tab: the
   * host is the loaded factory, so by existing it says nothing about that. The
   * registry decides, and treats an absent flag as open.
   */
  ref(): Omit<FactoryRef, 'open'> {
    return { id: this.factory.id, name: this.factory.name, baseDir: this.factory.baseDir };
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Make the factory's folders match its document.
   *
   * Called on open and after the document changes, rather than left to whenever a
   * loop next takes a turn: `/api/queues` reads the filesystem, so a queue that
   * has not been created yet reports nothing and the UI shows zero for a wire that
   * is about to be busy.
   */
  async prepare(): Promise<void> {
    await fsp.mkdir(this.internal, { recursive: true });
    // The worktree sidecar rides with `.kirofactory`, so this reload covers the
    // open, every document change, and a move to another directory in one line:
    // whatever directory the factory is in now, these are its checkouts.
    this.sessions = await readSessions(this.factory.baseDir);
    await this.migrateWireDirs();
    for (const dir of liveChannelDirs(this.factory)) {
      // `create` removes legacy subfolders recursively, so it goes through the
      // containment check like every other mutation built from an id.
      const abs = this.contained(dir);
      if (abs !== null) await new Queue(abs).create();
    }
    await this.pruneOrphanQueues();
  }

  /**
   * Move a pre-modes workspace off the folder-per-wire layout.
   *
   * Queues used to live at `wires/<wireId>`, one per wire. They now live at
   * `queues/<producer>` or `topics/<producer>/<subscriber>` depending on the
   * wire's mode, and `parse` has already decided that mode so as to keep what the
   * old layout meant (see the fan-out note there). So this is only the file move
   * that follows, and it is a move rather than a copy: two folders left behind
   * with the same items is two loops able to claim the same work.
   *
   * Nothing is merged and nothing is dropped. Each old folder has exactly one
   * destination, because an old fan-out becomes topics and each of those keeps its
   * own folder.
   */
  private async migrateWireDirs(): Promise<void> {
    const wiresRoot = path.join(this.internal, 'wires');
    if (!existsSync(wiresRoot)) return;

    for (const wire of this.factory.wires) {
      const from = path.join(INTERNAL, 'wires', wire.id);
      if (!existsSync(path.join(this.factory.baseDir, from))) continue;
      await this.moveItems(from, channelDir(wire));
      process.stdout.write(
        `  [${this.factory.name}] moved ${from} to ${channelDir(wire)} (${wire.mode})\n`,
      );
    }

    // Whatever is left belonged to wires the document no longer has, which is
    // what pruning would have deleted anyway.
    await fsp.rm(wiresRoot, { recursive: true, force: true });
  }

  /**
   * Drop queue folders no live wire delivers into.
   *
   * Deleting a wire removes its folder when nothing else shares it, but folders
   * from before that existed are still lying around, and a queue no wire can reach
   * is unreachable state. Logged rather than done silently: it deletes items.
   *
   * Both layouts are walked to the depth their names have meaning at: `queues/`
   * is one level, named by producer, and `topics/` is two, producer then
   * subscriber. A topic producer folder left with no subscribers goes too, so an
   * unwired loop does not leave an empty shell behind.
   */
  private async pruneOrphanQueues(): Promise<void> {
    const live = liveChannelDirs(this.factory);
    const prune = async (dir: string): Promise<void> => {
      const rel = path.relative(this.factory.baseDir, dir);
      if (live.has(rel)) return;
      await fsp.rm(dir, { recursive: true, force: true });
      process.stdout.write(`  [${this.factory.name}] pruned orphaned queue ${rel}\n`);
    };

    for (const child of await this.subdirs(path.join(this.internal, 'queues'))) await prune(child);

    for (const producer of await this.subdirs(path.join(this.internal, 'topics'))) {
      for (const subscriber of await this.subdirs(producer)) await prune(subscriber);
      if ((await this.subdirs(producer)).length === 0) {
        await fsp.rm(producer, { recursive: true, force: true });
      }
    }
  }

  /** Absolute paths of a folder's subfolders, or none if it is not there. */
  private async subdirs(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  }

  /** Stop every loop and wait for the turns in flight, so no subprocess is orphaned. */
  async dispose(): Promise<void> {
    // Supervisors first: one that ticked after the stops below would start a
    // member back up into a host that is going away.
    for (const loopId of [...this.supervisors.keys()]) this.unsupervise(loopId);
    for (const runner of this.runners.values()) runner.stop();
    await Promise.all([...this.runners.values()].map((r) => r.finished()));
    this.runners.clear();
  }

  /* -------------------------------------------------------------- document */

  /**
   * Replace the document. The canvas saves through this on every edit.
   *
   * Identity and location are not taken from the body: the canvas has no business
   * moving a factory, and a stale tab must not be able to rewrite where the
   * factory lives. Those change through `rename` and `setBaseDir`.
   */
  async replace(input: unknown): Promise<Factory> {
    const before = this.factory.wires.slice();
    const next = parse(input, {
      id: this.factory.id,
      name: this.factory.name,
      baseDir: this.factory.baseDir,
    });

    /*
     * A mode switch under a running fan-out is refused, before anything is saved.
     *
     * The canvas greys the control out, and that used to be the only guard. The
     * server has to hold the rule itself for the same reason it holds every other
     * one: a stale tab, a second tab, or a request by hand does not read greyed-out
     * controls. Switching mode rewrites the folders the loops at either end are
     * using right now - an agent mid-turn was handed the old paths in its prompt,
     * and the migration below would delete them under it. `paused` counts as
     * running, because a paused loop still wakes into the same paths.
     *
     * Only the fan-outs whose mode actually changes are checked; every other edit
     * to a running factory is allowed, as before, and picked up on the next turn.
     */
    for (const from of new Set(before.map((w) => w.from))) {
      const was = producerMode(before, from);
      const now = producerMode(next.wires, from);
      if (was === undefined || now === undefined || was === now) continue;
      const ends = new Set([from, ...before.filter((w) => w.from === from).map((w) => w.to)]);
      const live = this.statusAll().some((s) => ends.has(s.loop) && s.state !== 'stopped');
      if (live) {
        const name = this.factory.loops.find((l) => l.id === from)?.name ?? from;
        throw new ConflictError(
          `stop the loops on ${name}'s wires before switching between queue and topic - a turn in flight was handed the old folders`,
        );
      }
    }

    this.factory = { ...next, id: this.factory.id, name: this.factory.name, baseDir: this.factory.baseDir };
    await save(this.factory);

    /*
     * Retire folders the new document no longer delivers into.
     *
     * A wire is no longer its own folder, so this cannot be "wire gone, folder
     * gone": several wires share a producer's queue, and pulling one of them out
     * must leave the backlog for the readers still on it. The question is about
     * the folder rather than the wire - is anything still pointing here - which
     * covers deleting a wire, deleting a loop, and switching a mode in one rule.
     *
     * A wire that still exists but has vacated its folder is a mode switch, and
     * its work is carried across rather than dropped. That only happens when the
     * folder it left is now unreferenced: a wire switched off a shared queue that
     * others are still reading takes nothing with it, because those items were
     * never its own.
     *
     * What is left after that is a folder nothing can reach, and deleting it does
     * destroy items. That is the intent, but it is real data, so the UI asks first
     * when the folder is not empty and nobody else is on it.
     */
    /*
     * A producer that changed mode takes its backlog with it.
     *
     * This runs before the pruning below and mostly disarms it: both directions
     * empty the folders they are leaving, so the loop that follows finds nothing to
     * carry and nothing to delete. It has to be its own step because neither
     * direction is a move from one folder to one other, which is all that loop can
     * express - one becomes many, or many become one.
     */
    for (const from of new Set(before.map((w) => w.from))) {
      const was = producerMode(before, from);
      const now = producerMode(this.factory.wires, from);
      // No wires left is a deletion, which the pruning handles; nothing to migrate.
      if (was === undefined || now === undefined || was === now) continue;
      const topicDirs = (now === 'topic' ? this.factory.wires : before)
        .filter((w) => w.from === from)
        .map((w) => path.join(INTERNAL, 'topics', from, w.to));
      const queueDir = path.join(INTERNAL, 'queues', from);
      if (now === 'topic') await this.fanOut(queueDir, topicDirs);
      else await this.collapse(topicDirs, queueDir);
    }

    const liveAfter = liveChannelDirs(this.factory);
    const nowById = new Map(this.factory.wires.map((w) => [w.id, w]));
    for (const old of before) {
      const from = channelDir(old);
      if (liveAfter.has(from)) continue;
      const now = nowById.get(old.id);
      if (now) await this.moveItems(from, channelDir(now));
      await this.removeChannelDir(from);
    }
    // And the other direction: a wire that has just appeared gets its folder now
    // rather than when its loop first takes a turn, so the queue the panel names is
    // a folder that is actually there.
    await this.prepare();

    /*
     * A session the new document no longer has stops; the rest see the new
     * document on their next turn, so an edited prompt takes effect with no
     * restart.
     *
     * Three ways a runner can be orphaned now, not one. Its loop was deleted, as
     * before. Or its loop stopped being a cluster, which leaves its members
     * without a component. Or the cluster *shrank*, which leaves the members past
     * the new size without a place - and those have to be stopped, or a cluster
     * turned down from eight to three would keep five invisible members working a
     * queue nobody could see them on.
     *
     * `memberKeys` is the whole test: it is exactly the set of sessions the
     * document says should exist, so anything keyed outside it is by definition
     * orphaned, whichever of the three reasons put it there.
     */
    const wanted = new Set(this.factory.loops.flatMap((l) => memberKeys(l)));
    for (const [key, runner] of this.runners) {
      if (!wanted.has(key)) {
        runner.stop();
        /*
         * Out of the map when the drain finishes, not now. `stop()` is graceful,
         * so the turn in flight - an agent holding a claimed item, possibly
         * mid-edit - runs on for minutes, and everything that reasons about live
         * sessions reasons over this map: `anyRunning` guards the base-directory
         * switch, the stop-alls are the operator's escape hatch, `dispose` is
         * what shutdown awaits. Dropping the runner at once made the orphan
         * invisible to all three, so a loop deleted and a directory changed in
         * the same minute ran the switch under a subprocess still writing into
         * the old one, and Ctrl+C could exit with it alive. `statusAll` walks
         * the document's keys, not this map, so the lingering runner never shows
         * on the canvas; and the identity check keeps a regrow in the meantime -
         * shrink to 3, back to 4 - from having its fresh member 3 deleted by the
         * old member 3's drain finishing.
         */
        void runner.finished().then(() => {
          if (this.runners.get(key) === runner) this.runners.delete(key);
        });
      } else {
        runner.update(this.factory);
      }
    }
    // A cluster that is no longer scaled - or no longer a cluster - keeps no
    // supervisor. One that has just become scaled gets its on the next Start;
    // supervising it here would start members on a component nobody has run.
    for (const loopId of [...this.supervisors.keys()]) {
      const loop = this.factory.loops.find((l) => l.id === loopId);
      if (!loop?.cluster || loop.cluster.mode !== 'scaled') this.unsupervise(loopId);
    }
    this.emit('factory', this.factory);
    return this.factory;
  }

  async rename(name: string): Promise<Factory> {
    this.factory = { ...this.factory, name };
    await save(this.factory);
    this.emit('factory', this.factory);
    return this.factory;
  }

  /**
   * Point the factory at a different directory.
   *
   * Loops are stopped first: their agents are running with the old directory as
   * their cwd, and letting a turn finish writing into a folder the factory has
   * just left is how work goes missing.
   *
   * Queues are not moved. In-flight items belong to the run that produced them,
   * and silently relocating them would mean the same item existing at two paths
   * with two loops able to claim it. The old `.kirofactory` stays where it is, so
   * pointing back at that directory finds the work exactly as it was left.
   */
  async setBaseDir(dir: string): Promise<Factory> {
    const baseDir = path.resolve(dir);
    if (baseDir === this.factory.baseDir) return this.factory;

    /*
     * The home directory is the one path refused for its own sake rather than
     * because of what is in it, so it is checked before the document there is even
     * looked for: `~/.kirofactory/` is where the registry lives, and a factory based
     * at `$HOME` would want that same folder for its own. See `isHomeDir`.
     *
     * An error rather than the quiet fallback `pickBaseDir` uses, for the reason
     * every refusal in here is an error: this path was typed into the directory bar,
     * and using a different one than the operator asked for is worse than saying no.
     */
    if (isHomeDir(baseDir)) {
      throw new Error(
        `A factory cannot live directly in your home directory - that is where the ` +
          `list of factories is kept. Make a folder for it instead - ${baseDir}`,
      );
    }

    const existing = docPath(baseDir);
    if (existsSync(existing)) {
      let otherId: unknown;
      try {
        const other: unknown = JSON.parse(await fsp.readFile(existing, 'utf8'));
        otherId =
          typeof other === 'object' && other !== null ? (other as { id?: unknown }).id : undefined;
      } catch {
        // A malformed document there is not something to protect, so only a real
        // identity clash stops the move. Read inside the try and thrown outside it,
        // rather than thrown from within and let back out by matching on its own
        // wording: that made the refusal depend on a sentence, so any parse failure
        // whose message happened to contain that phrase was reported as a clash.
      }
      if (typeof otherId === 'string' && otherId !== this.factory.id) {
        // What went wrong, then where. The other way round reads better in prose and
        // worse in the interface: the message lands in a one-line slot in the
        // toolbar, and an absolute path at the front fills it on its own - see
        // `.error` in the stylesheet.
        throw new Error(
          `That folder already holds a different factory. Open it as its own tab instead of moving this one onto it - ${baseDir}`,
        );
      }
    }

    await this.dispose();
    await fsp.mkdir(path.join(baseDir, INTERNAL), { recursive: true });
    this.factory = { ...this.factory, baseDir };
    await save(this.factory);
    await this.prepare();
    this.emit('factory', this.factory);
    return this.factory;
  }

  /**
   * Delete a queue folder, given its path relative to the base directory.
   *
   * The containment check is not paranoia about our own ids: a document can be
   * hand-edited or imported, and a loop id of `../..` would otherwise turn a wire
   * deletion into a recursive delete of whatever sits above the factory's folder -
   * which is now your project directory.
   */
  private async removeChannelDir(rel: string): Promise<void> {
    const dir = this.contained(rel);
    if (dir === null) return;
    await fsp.rm(dir, { recursive: true, force: true });
  }

  /**
   * A document-derived path, resolved, or null if it would land outside `INTERNAL`.
   *
   * The check `removeChannelDir` used to do alone, made the shape every filesystem
   * mutation below goes through. `parse` refuses ids that could escape, and this is
   * the independent second line: a mutation is allowed to trust the parser about
   * what the document *means*, and is not allowed to trust it about where an
   * `rm` or a `rename` is going to land. Null rather than a throw, because every
   * caller here already treats "nothing to do" as a normal answer.
   */
  private contained(rel: string): string | null {
    const abs = path.resolve(this.factory.baseDir, rel);
    return inside(this.internal, abs) ? abs : null;
  }

  /**
   * Queue to topic: every item in the shared backlog, copied to every subscriber.
   *
   * A copy per destination, which is the one place in this design that deliberately
   * duplicates an item. It is what the switch means - from here on everybody gets
   * everything, and a backlog that predates the switch is no less everybody's than
   * the next item will be. Leaving it as one item for one consumer would make the
   * change retroactively unfair to the other subscribers, and dropping it would
   * lose work the operator can see sitting there.
   *
   * The source folder goes afterwards, which is also what makes the pruning that
   * follows a no-op for it.
   */
  private async fanOut(fromRel: string, toRels: string[]): Promise<void> {
    const from = this.contained(fromRel);
    if (from === null || !existsSync(from) || toRels.length === 0) return;
    const names = (await fsp.readdir(from)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    for (const toRel of toRels) {
      const to = this.contained(toRel);
      if (to === null) continue;
      await fsp.mkdir(to, { recursive: true });
      for (const name of names) {
        const target = path.join(to, name);
        // A subscriber that somehow already holds this item keeps what it has: its
        // copy is the one its consumer may already have been told about.
        if (!existsSync(target)) {
          await fsp.copyFile(path.join(from, name), target).catch(() => undefined);
        }
      }
    }
    await this.removeChannelDir(fromRel);
  }

  /**
   * Topic to queue: every subscriber's copies, gathered into the one backlog.
   *
   * The copies collapse. Three subscribers each holding `item-07.json` become one
   * queued item, because `moveItems` leaves a name that is already there - and that
   * is the correct reading of the switch rather than a compromise: one item, taken
   * once, by whichever consumer gets to it. It does mean files disappear, which is
   * the asymmetry with the other direction and the reason the panel says so before
   * you do it.
   */
  private async collapse(fromRels: string[], toRel: string): Promise<void> {
    for (const fromRel of fromRels) {
      await this.moveItems(fromRel, toRel);
      await this.removeChannelDir(fromRel);
    }
  }

  /**
   * Move every item from one queue folder to another, leaving neither duplicated.
   *
   * A move rather than a copy for the reason the whole queue design is built on:
   * the same item at two paths is two loops able to claim the same work.
   */
  private async moveItems(fromRel: string, toRel: string): Promise<void> {
    const from = this.contained(fromRel);
    const to = this.contained(toRel);
    if (from === null || to === null || from === to || !existsSync(from)) return;
    await fsp.mkdir(to, { recursive: true });
    for (const name of await fsp.readdir(from)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const target = path.join(to, name);
      // Same item name already there is the newer one; leave it alone.
      if (!existsSync(target)) await fsp.rename(path.join(from, name), target).catch(() => undefined);
    }
  }

  /* ----------------------------------------------------------------- loops */

  /**
   * A runner per *session*, created on demand and kept so status survives a stop.
   *
   * Keyed by the runner key rather than the loop id - the bare id for a plain
   * loop, `<loopId>#<n>` for one member of a cluster. A plain loop's key is
   * unchanged, so a document with no clusters behaves exactly as it did.
   *
   * The key is parsed rather than taken on trust: a member number past the
   * cluster's size, or a member key naming a loop that is not a cluster, gets
   * nothing back. Otherwise a stale tab could conjure runners for members that no
   * longer exist and they would sit in this map emitting status about them.
   */
  private runnerFor(key: string): Runner | undefined {
    const { loopId, member } = splitMemberId(key);
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) return undefined;
    if (member === undefined) {
      // A cluster has no session of its own: its work is done by its members, and
      // a bare key would be a runner nobody supervises writing into the folder
      // the members' folders live in.
      if (loop.cluster) return undefined;
    } else if (!loop.cluster || member >= loop.cluster.size) {
      return undefined;
    }

    let runner = this.runners.get(key);
    if (!runner) {
      /*
       * Where this session works. The base directory unless the loop opted into
       * per-session checkouts *and* the sidecar has one for this key - intent
       * without a provisioned checkout falls back to the base directory rather
       * than failing here, because `startLoop` provisions before it starts
       * anything and is the only path that may not fall back. A checkout is
       * fixed for the runner's lifetime; `refreshRunnerDirs` is what retires a
       * stopped runner whose directory no longer matches.
       */
      const checkout = loop.worktree === true ? this.sessions[key] : undefined;
      runner = new Runner({
        loopId,
        factory: this.factory,
        cwd: checkout?.dir ?? this.factory.baseDir,
        home: this.factory.baseDir,
        ...(checkout !== undefined ? { branch: checkout.branch } : {}),
        driver: this.driver,
        ...(member !== undefined ? { member } : {}),
      });
      runner.on('status', (s: LoopStatus) => this.emit('status', s));
      runner.on('output', (line: OutputLine) => this.emit('output', line));
      this.runners.set(key, runner);
    }
    return runner;
  }

  /**
   * One status per session, so a cluster of five reports five.
   *
   * Not aggregated here. The canvas draws one card per component and does the
   * collapsing itself (`aggregate` in the client's types), because the panel needs
   * the members individually for its strip and the card needs them counted - one
   * pre-collapsed number would serve neither, and sending both shapes would be two
   * things to keep in step.
   */
  statusAll(): LoopStatus[] {
    return this.factory.loops.flatMap((l) =>
      memberKeys(l).map((key) => {
        const known = this.runners.get(key)?.status();
        if (known) return known;
        const { member } = splitMemberId(key);
        return {
          id: key,
          loop: l.id,
          ...(l.cluster !== undefined && member !== undefined ? { member } : {}),
          state: 'stopped' as const,
          iteration: 0,
        };
      }),
    );
  }

  /**
   * Whether a start would be honoured. A disabled loop is skipped by every path
   * that starts loops - its own button, `Run all`, an API call made directly -
   * which is why the check lives here rather than in the button: the guarantee is
   * "a disabled loop does not run", not "the UI does not offer to run it".
   */
  private startable(loopId: string): boolean {
    return this.factory.loops.some((l) => l.id === loopId && !l.disabled);
  }

  /**
   * Start a component: one session, or a cluster's members.
   *
   * Takes a loop id, never a member key - Start is a button on a card and a card
   * is a component. Which members that turns into is this method's business, and
   * it differs by mode: a fixed cluster starts all of them, a scaled one starts
   * its supervisor and lets the backlog decide.
   *
   * Returns the component's status as one, which for a cluster means the
   * aggregate. The reply is only what the button needs to redraw itself; the
   * per-member truth follows on the event stream.
   */
  async startLoop(loopId: string): Promise<LoopStatus | undefined> {
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) return undefined;
    if (!this.startable(loopId)) return this.componentStatus(loop);

    /*
     * Per-session checkouts are made here, before any runner exists - not on
     * ticking the checkbox, because a checkbox should not spend a minute
     * checking out a repository, and not lazily at turn time, because a failure
     * there lands inside a turn that has already been counted. Sequential, with
     * progress on the loop's output stream; a failure partway means the
     * component does not start at all - members race one queue, so starting the
     * provisioned members while the rest silently lack a checkout would be a
     * cluster whose losers nobody chose. The checkouts already made stay in the
     * sidecar and the next start resumes by reusing them.
     */
    if (loop.worktree === true) {
      const say = (key: string, text: string): void =>
        this.emit('output', { loop: key, ts: new Date().toISOString(), kind: 'system', text });
      try {
        this.sessions = await provision(this.factory, loop, say);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        say(memberKeys(loop)[0]!, `could not provision checkouts - ${why}`);
        throw new Error(`could not provision checkouts: ${why}`);
      }
    }
    // Both directions: a stopped runner built before its checkout existed, and
    // one still pointing at a checkout the loop no longer wants.
    this.refreshRunnerDirs(loop);

    if (!loop.cluster) {
      this.runnerFor(loopId)?.start();
    } else if (loop.cluster.mode === 'fixed') {
      for (const key of memberKeys(loop)) this.runnerFor(key)?.start();
    } else {
      /*
       * A scaled cluster starts one member and its supervisor.
       *
       * One rather than none, even with an empty queue, because Start has to do
       * something: a component that reports `stopped` after being started offers no
       * Stop button and no way to tell "waiting for the first item" from "did not
       * work". The one member also costs nothing on the mode this pairs with - a
       * scaled cluster is almost always waiting for work, and a waiting member is
       * idle, not billing.
       */
      this.runnerFor(memberKeys(loop)[0]!)?.start();
      this.supervise(loopId);
    }
    return this.componentStatus(loop);
  }

  /** Stop a component: its one session, or every member of its cluster. */
  stopLoop(loopId: string): LoopStatus | undefined {
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) return undefined;
    // Before the members, so it cannot start one back up between the two.
    this.unsupervise(loopId);
    for (const key of memberKeys(loop)) this.runners.get(key)?.stop();
    return this.componentStatus(loop);
  }

  /**
   * Force stop a component: kill the turn in flight rather than let it finish.
   *
   * `stopLoop`'s impatient sibling and `forceStopAll` narrowed to one card, built
   * out of the same two moves in the same order - supervisor first, so a scaled
   * cluster cannot start a member back up in the gap, then every member key.
   *
   * A cluster force stops whole. Killing one member and leaving the rest is not
   * something a card can ask for, because a card is a component: the button sits
   * beside a Stop that acts on all of them and would otherwise mean something
   * different from the button next to it. The member strip picks which log you
   * read, not which session you may kill.
   *
   * What it costs does not scale with the member count but the number of places
   * it can be paid does. A killed turn had claimed an item off a queue and may
   * have written part of what it was doing, so sixteen killed members are sixteen
   * folders that could hold half-finished work. That is the operator's call and
   * the tooltip on the button is where it is stated; this does not second-guess it.
   */
  forceStopLoop(loopId: string): LoopStatus | undefined {
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) return undefined;
    this.unsupervise(loopId);
    for (const key of memberKeys(loop)) this.runners.get(key)?.forceStop();
    return this.componentStatus(loop);
  }

  /**
   * One status for a whole component, from its members'.
   *
   * The same collapse the canvas does, kept here for the start and stop replies
   * so a caller that never opens the event stream still gets a meaningful answer.
   * Most-alive member wins the state, iterations sum: see `aggregate` on the
   * client for why those two rules and not others.
   */
  private componentStatus(loop: Loop): LoopStatus {
    const parts = memberKeys(loop).map(
      (key) => this.runners.get(key)?.status() ?? { state: 'stopped' as const, iteration: 0 },
    );
    const has = (s: LoopStatus['state']): boolean => parts.some((p) => p.state === s);
    return {
      id: loop.id,
      loop: loop.id,
      state: has('running')
        ? 'running'
        : has('stopping')
          ? 'stopping'
          : has('paused')
            ? 'paused'
            : 'stopped',
      iteration: parts.reduce((sum, p) => sum + p.iteration, 0),
    };
  }

  /**
   * Retire stopped runners whose working directory no longer matches what the
   * document and the sidecar now say - a runner built before its checkout
   * existed, or still pointing at one the loop has since turned off. Only
   * stopped ones: a live runner owns a turn in a directory, and the next start
   * is when the new truth applies. The retired runner's buffered log goes with
   * it, which is the cost of a directory change and not of ordinary restarts.
   */
  private refreshRunnerDirs(loop: Loop): void {
    for (const key of memberKeys(loop)) {
      const runner = this.runners.get(key);
      if (!runner) continue;
      const want =
        (loop.worktree === true ? this.sessions[key]?.dir : undefined) ?? this.factory.baseDir;
      if (runner.cwd !== want && runner.status().state === 'stopped') this.runners.delete(key);
    }
  }

  /**
   * One component's checkouts, as the sidecar knows them, keyed by runner key.
   * The panel's per-loop badge reads this; an empty object is a loop that has
   * never provisioned, or has released.
   */
  worktreesOf(loopId: string): Record<string, SessionCheckout> {
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) return {};
    const out: Record<string, SessionCheckout> = {};
    for (const key of memberKeys(loop)) {
      const entry = this.sessions[key];
      if (entry !== undefined) out[key] = entry;
    }
    return out;
  }

  /** One session's checkout, or undefined when it works in the base directory. */
  checkoutFor(key: string): SessionCheckout | undefined {
    return this.sessions[key];
  }

  /**
   * Every checkout this factory has, in document order, labelled for a person.
   *
   * The file panel's worktree dropdown reads this, and the labels are composed
   * here because this is the side that holds both halves of the answer: the
   * sidecar knows the paths, the document knows what the loops are called. A
   * checkout whose loop has since unticked `worktree` is still listed - it is
   * still on disk, still holds work, and browsing it is exactly what an
   * operator deciding whether to release it wants to do. Keys no loop has any
   * more are not: a directory the document cannot name has no place in a
   * dropdown of the document's loops.
   */
  worktreesAll(): {
    key: string;
    loopId: string;
    loopName: string;
    member?: number;
    dir: string;
    branch: string;
  }[] {
    const out: ReturnType<Host['worktreesAll']> = [];
    for (const loop of this.factory.loops) {
      for (const key of memberKeys(loop)) {
        const entry = this.sessions[key];
        if (entry === undefined) continue;
        const { member } = splitMemberId(key);
        out.push({
          key,
          loopId: loop.id,
          loopName: loop.name,
          ...(member !== undefined ? { member } : {}),
          dir: entry.dir,
          branch: entry.branch,
        });
      }
    }
    return out;
  }

  /**
   * Take over a sessions map wholesale: write it as this base directory's
   * sidecar and serve it from the cache.
   *
   * One caller, the factory-level branch-off, carrying the loops' checkouts
   * across the move. Without this, branching a factory off orphans every loop
   * checkout it had - the sidecar stays behind with the old `.kirofactory`,
   * the new home reads empty, and the next start provisions a second set while
   * the first sits on disk holding work nobody can see. The carry is sound for
   * a branch-off and only a branch-off: the move stays inside one repository,
   * so every entry still passes the same-repository reuse check on the next
   * start. `setBaseDir` itself stays hands-off, because an arbitrary move is
   * to a different repository and those checkouts are not its to claim.
   */
  async adoptWorktrees(sessions: Sessions): Promise<void> {
    await writeSessions(this.factory.baseDir, sessions);
    this.sessions = sessions;
  }

  /**
   * Remove a component's checkouts - see `release` in worktrees.ts for the
   * rules. Refused while the component runs, with the same reasoning as the
   * factory-level branch-off: a turn in flight would finish into a directory
   * that had been deleted under it.
   */
  async releaseWorktrees(loopId: string): Promise<Released> {
    const loop = this.factory.loops.find((l) => l.id === loopId);
    if (!loop) throw new Error('no such loop');
    if (this.componentStatus(loop).state !== 'stopped') {
      throw new Error(
        'stop the loop first. Releasing removes its checkouts, and a turn in flight would finish into a directory that had been deleted under it.',
      );
    }
    const result = await release(this.factory.baseDir, memberKeys(loop));
    this.sessions = result.sessions;
    this.refreshRunnerDirs(loop);
    return result;
  }

  /**
   * An operator message for one session. Injected into the turn in flight when
   * there is one, queued for the next turn when there is not: see `Runner.steer`.
   *
   * Takes a runner key, not a loop id, and that asymmetry with start and stop is
   * deliberate. Start and stop act on the component, because that is what the card
   * offers. A message is a reply to something you just read, so it goes to the
   * member whose log you were reading - broadcasting it to all five members would
   * put five agents onto one remark meant for one of them.
   */
  steerLoop(key: string, text: string): boolean {
    const runner = this.runnerFor(key);
    if (!runner) return false;
    runner.steer(text);
    return true;
  }

  /**
   * Sequential on purpose, not for tidiness: a component with checkouts to
   * provision takes the repository's index lock, so two components provisioning
   * at once is one of them failing. A worktree component that cannot provision
   * fails its own start and the rest still go - Run all starting what it can is
   * more useful than all-or-nothing over a git error on one card.
   */
  async startAll(): Promise<LoopStatus[]> {
    for (const l of this.factory.loops) {
      if (l.disabled) continue;
      await this.startLoop(l.id).catch(() => undefined);
    }
    return this.statusAll();
  }

  stopAll(): LoopStatus[] {
    for (const loopId of [...this.supervisors.keys()]) this.unsupervise(loopId);
    for (const runner of this.runners.values()) runner.stop();
    return this.statusAll();
  }

  /** Stop everything now, killing any turn in flight. See `Runner.forceStop`. */
  forceStopAll(): LoopStatus[] {
    for (const loopId of [...this.supervisors.keys()]) this.unsupervise(loopId);
    for (const runner of this.runners.values()) runner.forceStop();
    return this.statusAll();
  }

  /** One session's log, by runner key. A cluster's members are separate logs. */
  output(key: string): OutputLine[] {
    return this.runners.get(key)?.recentOutput() ?? [];
  }

  /* ------------------------------------------------------ scaled clusters */

  /**
   * The poll loops keeping scaled clusters the right size, one per cluster.
   *
   * Only scaled clusters have one. A fixed cluster is N members started together
   * and needs no supervision at all - it is exactly N loops someone drew by hand,
   * and nothing watches those either.
   */
  private readonly supervisors = new Map<string, { cancel: () => void }>();

  /**
   * Keep a scaled cluster's live member count matching its backlog.
   *
   * `want = clamp(waiting + busy, 1, size)`: one member per item, whether the item
   * is still on the folders the cluster reads or already claimed by a member
   * working on it. Never fewer than one so the component stays live and can notice
   * the next item, never more than the ceiling the operator set.
   *
   * The `busy` term is what makes it a count of items rather than of files. A
   * claim moves the item *out* of the folder, so `waiting` alone stops counting an
   * item the moment somebody starts on it - and the member doing the work stopped
   * counting as capacity in use. Two things went wrong with that: with one member
   * mid-item and one item landing behind it, `want` was 1 and nothing started, so
   * the second member only ever came up when two items were unclaimed at once,
   * which a producer emitting one item a turn rarely arranges; and a burst of
   * twelve items started twelve members who each claimed one, at which point
   * `waiting` was 0, `want` was 1, and eleven of them were told to stop while
   * inside the turn they had just been started for. They drained gracefully, so
   * nothing was lost, but they read `stopping` for the length of the turn, which
   * counts as live here and refuses `start()`, so the next twelve items found
   * eleven slots blocked. The cluster ratcheted *down* under sustained load.
   *
   * Symmetric on purpose - it scales down as well as up - but the downward half
   * sheds only *idle* members: one that is `paused` waiting for work has finished
   * its item and is exactly the surplus this exists to trim. A `running` member is
   * counted in `busy`, so it is never surplus while it holds an item. That assumes
   * the cluster has `autoPause`, which is what makes an idle member `paused`
   * rather than spinning on an empty folder; a scaled consumer without it is never
   * shed, and the skill says so. Without the downward half a cluster would
   * ratchet up instead: twelve members running empty turns forever, which is the
   * failure mode "one loop per message" exists to avoid.
   *
   * A poll rather than a watcher, for the same reason `Runner.waitForWork` polls:
   * items are files written by another process, so there is nothing to subscribe
   * to. It is one `readdir` per incoming folder every two seconds.
   */
  private supervise(loopId: string): void {
    if (this.supervisors.has(loopId)) return;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const loop = this.factory.loops.find((l) => l.id === loopId);
      // The cluster was deleted, made fixed, made a plain loop, or parked. Any of
      // those means this poll is describing something that no longer exists.
      if (!loop?.cluster || loop.cluster.mode !== 'scaled' || loop.disabled) {
        this.unsupervise(loopId);
        return;
      }

      const waiting = await this.waitingFor(loopId);
      if (cancelled) return;
      const keys = memberKeys(loop);
      const stateOf = (key: string) => this.runners.get(key)?.status().state ?? 'stopped';
      const busy = keys.filter((key) => stateOf(key) === 'running').length;
      const want = Math.min(Math.max(waiting + busy, 1), loop.cluster.size);
      const liveKeys = keys.filter((key) => stateOf(key) !== 'stopped');

      if (liveKeys.length < want) {
        // Lowest-numbered stopped members first, so a cluster that breathes keeps
        // using the same few members and the same few folders rather than walking
        // through all sixteen and leaving scratch everywhere.
        for (const key of keys) {
          if (liveKeys.length >= want) break;
          if (stateOf(key) !== 'stopped') continue;
          this.runnerFor(key)?.start();
          liveKeys.push(key);
        }
      } else if (liveKeys.length > want) {
        // Highest-numbered first, the reverse of the order they were started in,
        // so the cluster shrinks back towards member 0 rather than leaving gaps.
        // Only idle members go - see the note above on why a running one is not
        // surplus, and why a stopping one is already on its way.
        let surplus = liveKeys.length - want;
        for (const key of [...liveKeys].reverse()) {
          if (surplus <= 0) break;
          if (stateOf(key) !== 'paused') continue;
          this.runners.get(key)?.stop();
          surplus -= 1;
        }
      }

      if (cancelled) return;
      timer = setTimeout(() => void tick(), SCALE_POLL_MS);
    };

    this.supervisors.set(loopId, {
      cancel: () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      },
    });
    // Straight away rather than after the first interval: the operator has just
    // pressed Start on a cluster with a backlog and should not watch one member
    // work alone for two seconds before the rest arrive.
    void tick();
  }

  private unsupervise(loopId: string): void {
    this.supervisors.get(loopId)?.cancel();
    this.supervisors.delete(loopId);
  }

  /**
   * How many items are waiting on the folders one component reads.
   *
   * Summed across its distinct incoming folders, deduplicated because queue wires
   * sharing a producer resolve to one folder. This is the number a scaled cluster
   * sizes itself against, so it counts items rather than asking whether there are
   * any - the difference between "something to do" and "how much".
   */
  private async waitingFor(loopId: string): Promise<number> {
    const dirs = new Set(
      this.factory.wires.filter((w) => w.to === loopId).map(channelDir),
    );
    const counts = await Promise.all(
      [...dirs].map((dir) => new Queue(path.join(this.factory.baseDir, dir)).count()),
    );
    return counts.reduce((sum, n) => sum + n, 0);
  }

  /**
   * Whether anything is going. A paused loop counts: it is waiting for an item and
   * will take a turn without being asked, so anything that treats this as "safe to
   * change things under it" would be wrong about it.
   */
  anyRunning(): boolean {
    return [...this.runners.values()].some((r) => r.status().state !== 'stopped');
  }

  /* ---------------------------------------------------------------- queues */

  /**
   * Outstanding item count per wire.
   *
   * Read off the filesystem on request rather than tracked: an agent adds and
   * removes files itself, so the folder is the only thing that knows what is in
   * it, and anything cached here would be a guess.
   *
   * Still keyed by wire even though wires now share folders, because that is the
   * question the canvas asks: it draws wires. Wires on one shared queue all report
   * the same number, which is the truth about them - there is one backlog and they
   * are all looking at it. Each folder is counted once and the count reused, so a
   * wide fan-out is one readdir rather than one per branch.
   */
  async queueCounts(): Promise<Record<string, number>> {
    const byDir = new Map<string, number>();
    for (const dir of liveChannelDirs(this.factory)) {
      byDir.set(dir, await new Queue(path.join(this.factory.baseDir, dir)).count());
    }
    const counts: Record<string, number> = {};
    for (const wire of this.factory.wires) counts[wire.id] = byDir.get(channelDir(wire)) ?? 0;
    return counts;
  }

  /**
   * Everything one loop is currently delivering, grouped by folder.
   *
   * Keyed by the producer rather than by a wire, which is the shape the answer
   * actually has now that mode belongs to the producer. A queue is one group however
   * many wires leave the loop, because there is one folder and they are all looking
   * at it. A topic is a group per subscriber, and returning them together is what
   * lets the panel show a broadcast working - the same item appearing under each
   * heading is the whole point of the mode, and it is invisible if you have to click
   * between three wires to see it.
   *
   * `to` is the subscriber's loop id for a topic group, and null for the queue,
   * which belongs to no single consumer. Names are left to the client: it holds the
   * document, so it can turn ids into names without this having to send them.
   */
  async outbox(loopId: string): Promise<
    | {
        mode: WireMode;
        groups: { to: string | null; dir: string; items: QueueItem[] }[];
      }
    | undefined
  > {
    const wires = this.factory.wires.filter((w) => w.from === loopId);
    const mode = producerMode(this.factory.wires, loopId);
    if (mode === undefined) return undefined;

    if (mode === 'queue') {
      const dir = channelDir(wires[0]!);
      const items = await new Queue(path.join(this.factory.baseDir, dir)).list();
      return { mode, groups: [{ to: null, dir, items }] };
    }

    const groups = await Promise.all(
      wires.map(async (w) => {
        const dir = channelDir(w);
        return { to: w.to, dir, items: await new Queue(path.join(this.factory.baseDir, dir)).list() };
      }),
    );
    return { mode, groups };
  }

  /**
   * Throw away everything waiting on the folders one loop delivers into.
   *
   * The counterpart of `outbox`, and scoped exactly the same way: a producer's
   * folders, all of them, whether that is one shared queue or a copy per subscriber.
   * `channelDir` keys on the producer, so this set is well defined without having to
   * say anything about which wire you had selected.
   *
   * Returns undefined for a loop with no wires out, which the route turns into the
   * same 404 `outbox` gives - there are no folders, so there is nothing to empty and
   * nothing to report.
   *
   * Deliberately allowed while loops run. Clearing a loop's own folder is refused
   * unless it is stopped, because that folder holds the item the turn in flight
   * claimed off a queue and no copy of it exists anywhere else. A queue is the
   * opposite case: an item on it is unclaimed by definition, and a consumer racing
   * this delete either wins its atomic move or finds the file gone, which is the
   * documented outcome on any contested queue. Refusing would also make the button
   * useless in the one situation you reach for it - watching a backlog build up while
   * the factory runs.
   *
   * Deduplicated, because every queue wire out of a loop resolves to one folder and
   * clearing it three times would just be two extra readdirs for the same answer.
   */
  async clearOutbox(loopId: string): Promise<number | undefined> {
    const wires = this.factory.wires.filter((w) => w.from === loopId);
    if (wires.length === 0) return undefined;

    let gone = 0;
    for (const dir of new Set(wires.map(channelDir))) {
      const abs = this.contained(dir);
      if (abs !== null) gone += await new Queue(abs).clear();
    }
    return gone;
  }

  /* ------------------------------------------------------------------ tools */

  /**
   * MCP servers a prompt in this factory can name.
   *
   * Scoped to the factory rather than the process because the workspace half of
   * the answer comes from the base directory, so two tabs pointed at different
   * projects can legitimately offer different tools.
   */
  async mcpServers(): Promise<Pick<McpServer, 'name' | 'scope'>[]> {
    // Names and scopes only. The entry carries env vars and headers, which is
    // where people put tokens, and the browser needs the name to offer and
    // nothing more - the config's one consumer is the driver, on this side.
    return (await listMcpServers(this.factory.baseDir)).map(({ name, scope }) => ({ name, scope }));
  }

  /**
   * Skills and steering files a prompt in this factory can name.
   *
   * The forward twin of `mcpServers()`, scoped to the factory for the same reason:
   * the workspace half of the answer comes from the base directory, so two tabs
   * pointed at different projects legitimately carry different skills.
   *
   * Nothing to strip on the way out, unlike the servers above. Those carry a
   * verbatim config with env vars and headers in it; these are names, scopes and a
   * one-line description, which is the whole of what a picker and a prompt bullet
   * need. See resources.ts for why no path comes with them.
   */
  async resources(): Promise<{ skills: Skill[]; steeringFiles: SteeringFile[] }> {
    const [skills, steeringFiles] = await Promise.all([
      listSkills(this.factory.baseDir),
      listSteeringFiles(this.factory.baseDir),
    ]);
    return { skills, steeringFiles };
  }
}
