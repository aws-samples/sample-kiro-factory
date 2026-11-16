/**
 * One remote loop, live: the flock cluster behind a card and everything that
 * keeps the card true.
 *
 * `Runner` is to a local loop what this is to a remote one, and it speaks the
 * same two events - `status` frames per member, `output` lines - so the host,
 * the event stream and the canvas need no new shapes. What differs is where the
 * work happens: nothing here runs an agent. It configures a cluster, pushes the
 * direction, asks the flock to start, polls its status, runs the queue bridge,
 * and stops the cluster when - and only when - the operator says so.
 *
 * ## What stops a cluster
 *
 * `stop()`, `forceStop()`, `destroy()`, and the "After N hours" run mode. That
 * is the whole list. On the card, the flock's own two verbs are offered: the
 * Pause button calls `pause()` (nodes idle, tasks keep billing) and Start on a
 * paused cluster calls `resume()`; the bolt ("zap") is the one that calls
 * `stop()`. `detach()` - called on server exit, on factory close, on a
 * document edit that removes the loop's connection - stops the poll and the
 * bridge and leaves the cluster running. A remote loop is meant to outlive this
 * process (plan decision D13); every path that ends the process goes through
 * `detach`, never `stop`.
 *
 * ## Reconnect
 *
 * `attach()` is `start()` without the start: it reads the cluster's state, runs
 * the bridge's catch-up over whatever accumulated in `queue/out/` while the
 * factory was away, wakes an autopaused cluster if there is work waiting, and
 * applies an overdue "After N hours" stop. `Host.prepare` calls it for every
 * remote loop the sidecar remembers, and for every remote loop in the document
 * whose cluster the flock lists (the sidecar-lost case).
 */
import { EventEmitter } from 'node:events';
import { memberKeys, nodeLabel, remoteClusterId, type Factory, type Loop, type RemoteAlgorithm, type RemoteTaskSize } from '../factory.ts';
import type { LoopStatus, OutputLine, RemoteStatus } from '../runner.ts';
import { SignedOutError, type CognitoAuth } from './auth.ts';
import { QueueBridge, type SyncState } from './bridge.ts';
import { FlockApiError, type ClusterConfig, type ClusterState, type ClusterStatus, type FlockClient } from './client.ts';
import { buildRemoteDirection, promptFromDirection, protocolText, readMarker, remoteTools } from './direction.ts';
import type { Sidecar } from './sidecar.ts';
import { startProblems, describeProblems } from './validate.ts';

const STATUS_POLL_MS = 5000;
const STATUS_POLL_STOPPED_MS = 30_000;
/**
 * How often the config and the direction are read back while attached, for
 * the flock-to-document half of the sync. Their own routes, not the `config`
 * on the status: that one is a snapshot a Lambda rebuilds on a timer and can
 * trail a write by a minute, which read as an edit on the flock and flapped
 * the document to the old value and back.
 */
const SYNC_POLL_MS = 15_000;
const START_WAIT_MS = 10 * 60_000;
const OUTPUT_KEEP = 500;

export interface RemoteClusterDeps {
  loopId: string;
  connectionId: string;
  connectionName: string;
  apiUrl: string;
  client: FlockClient;
  auth: CognitoAuth;
  sidecar: Sidecar;
  factory(): Factory;
  /**
   * Write a change the flock made into the document: the settings and the
   * prompt follow an edit on the flock's dashboard. Saves and tells the canvas;
   * does not push back to the flock (the cluster already agrees).
   */
  patchLoop(loopId: string, patch: Partial<Loop>): Promise<void>;
  emit(event: 'status', data: LoopStatus): void;
  emit(event: 'output', data: OutputLine): void;
}

/**
 * The settings that travel both ways between the document and the flock's
 * config. Each is a config key; `desiredConfig` says what the document wants
 * for it and `loopPatchFor` says what a flock-side value means for the loop.
 * `computeType` is pushed but never pulled: the factory fixes it and a
 * flock-side change is overwritten.
 */
const SYNCED: readonly (keyof ClusterConfig)[] = [
  'concurrency', 'algorithm', 'neighbourRadius', 'swarmK', 'taskSize', 'browserAutomation', 'trustDeploy', 'selfOptimizing', 'autopause', 'model', 'loopIntervalSeconds',
];

/** The flock config the document asks for. The whole of it; the caller diffs. */
export function desiredConfig(loop: Loop, group: string | null = null): Partial<ClusterConfig> {
  const remote = loop.remote!;
  // Ticked or named in the prompt; see `remoteTools`.
  const tools = remoteTools(loop);
  const size = loop.cluster?.size ?? 2;
  const algorithm: RemoteAlgorithm = remote.algorithm ?? 'amorphous';
  return {
    algorithm,
    concurrency: size,
    // Radius and K only matter to the algorithm that reads them; the flock
    // validates each only under its own algorithm, so the other is left as the
    // flock has it rather than sent as a value nothing checks.
    ...(algorithm === 'amorphous' ? { neighbourRadius: remote.neighbourRadius ?? 1 } : {}),
    ...(algorithm === 'swarm' ? { swarmK: remote.swarmK ?? 1 } : {}),
    computeType: 'ecs',
    taskSize: remote.taskSize ?? 'medium',
    loopIntervalSeconds: loop.intervalSeconds ?? 0,
    autopause: loop.autoPause,
    model: loop.model ?? null,
    browserAutomation: tools.browser,
    selfOptimizing: remote.selfOptimizing === true,
    trustDeploy: tools.trustDeploy,
    // The factory's deployment group: all its remote loops share
    // environment/<group>/, and a deployer's records go to its deployed/.
    // Applied by the flock at start only (the agents read it at boot), so
    // pushDocument leaves it out while the cluster is live; see `group`.
    ...(group !== null ? { everforgeGroup: group } : {}),
  };
}

/** What one flock-side config value means for the loop. The parse clamps it. */
function loopPatchFor(loop: Loop, key: keyof ClusterConfig, value: unknown): Partial<Loop> {
  const remote = loop.remote!;
  switch (key) {
    case 'concurrency':
      return { cluster: { mode: 'fixed', comms: 'flock', size: typeof value === 'number' ? value : loop.cluster?.size ?? 2 } };
    case 'algorithm':
      return { remote: { ...remote, algorithm: value === 'amorphous' ? undefined : (value as RemoteAlgorithm) } };
    case 'neighbourRadius':
      return { remote: { ...remote, neighbourRadius: typeof value === 'number' ? value : undefined } };
    case 'swarmK':
      return { remote: { ...remote, swarmK: typeof value === 'number' ? value : undefined } };
    case 'taskSize':
      return { remote: { ...remote, taskSize: value as RemoteTaskSize } };
    case 'browserAutomation':
      return { remote: { ...remote, browser: value === true ? true : undefined } };
    case 'trustDeploy':
      return { remote: { ...remote, trustDeploy: value === true ? true : undefined } };
    case 'selfOptimizing':
      return { remote: { ...remote, selfOptimizing: value === true ? true : undefined } };
    case 'autopause':
      return { autoPause: value === true };
    case 'model':
      return { model: typeof value === 'string' && value.length > 0 ? value : undefined };
    case 'loopIntervalSeconds':
      return { intervalSeconds: typeof value === 'number' && value >= 1 ? value : undefined };
    default:
      return {};
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Refused start: the message is for the operator, verbatim. */
export class RemoteStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteStartError';
  }
}

export class RemoteCluster extends EventEmitter {
  readonly clusterId: string;
  /**
   * The deployment group the cluster runs with, which decides where its folder
   * is on the flock. The flock's config is the source of truth (read on every
   * pull and after a start); the document's `remoteGroup` only becomes it at the
   * next start. Null until the flock has been read, and for ungrouped clusters.
   */
  private group: string | null = null;
  private readonly d: RemoteClusterDeps;
  private readonly bridge: QueueBridge;
  private readonly output: OutputLine[] = [];
  private clusterState: RemoteStatus['clusterState'] = 'unknown';
  private stateReason: string | undefined;
  private lastError: string | undefined;
  private lastSeenAt: string | undefined;
  private infraCostUsd: number | undefined;
  private agents: ClusterStatus['agents'] = [];
  private sync: SyncState = 'live';
  private problem: string | undefined;
  private attached = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private stopping = false;
  private runUntil: number | undefined;
  private lastStatusAt = 0;
  /**
   * What the document and the flock last agreed on: the config as the flock
   * holds it after the factory's last write, and the direction as last pushed or
   * pulled. The two-way sync is a diff against this, from both sides. A flock
   * value that differs from it is an edit made on the flock, and goes into the
   * document; a document value that differs from it is an edit made here, and
   * goes to the flock. Both at once in the same poll window: the document wins,
   * because the operator just made that edit in front of this factory.
   * Undefined until the cluster is started or attached.
   */
  private agreed: { config: Partial<ClusterConfig>; direction: string } | undefined;
  private lastSyncAt = 0;
  private syncing: Promise<void> | null = null;

  constructor(deps: RemoteClusterDeps) {
    super();
    this.d = deps;
    this.clusterId = remoteClusterId(deps.connectionId, deps.factory().id, deps.loopId);
    this.bridge = new QueueBridge({
      client: deps.client,
      clusterId: this.clusterId,
      group: () => this.group,
      connectionId: deps.connectionId,
      loopId: deps.loopId,
      baseDir: deps.factory().baseDir,
      sidecar: deps.sidecar,
      factory: deps.factory,
      clusterState: () => this.clusterState,
      log: (line) => this.say(line),
      onUploaded: () => void this.wakeIfAutopaused(),
      onSync: (s) => {
        this.sync = s;
        if (s === 'signed-out') this.say('signed out of the flock - sign in to resume syncing; the cluster is still running');
        this.emitStatus();
      },
    });
  }

  private loop(): Loop | undefined {
    return this.d.factory().loops.find((l) => l.id === this.d.loopId);
  }

  get uiUrl(): string {
    return `${this.d.apiUrl.replace(/\/+$/, '')}/?cluster=${encodeURIComponent(this.clusterId)}`;
  }
  /** The connection this object was built for; the host compares it with the document. */
  get connectionId(): string {
    return this.d.connectionId;
  }
  get connectionName(): string {
    return this.d.connectionName;
  }

  nodeUrl(agentIndex: number): string {
    return `${this.d.apiUrl.replace(/\/+$/, '')}/?section=kiro-node&cluster=${encodeURIComponent(this.clusterId)}&agent=${agentIndex}`;
  }

  /** Whether the cluster is doing anything the factory should keep watching. */
  isLive(): boolean {
    return this.clusterState === 'running' || this.clusterState === 'starting' || this.clusterState === 'paused' || this.clusterState === 'stopping';
  }

  // ---- status ----------------------------------------------------------------

  private remoteStatus(): RemoteStatus {
    return {
      clusterState: this.clusterState,
      ...(this.stateReason !== undefined ? { stateReason: this.stateReason } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      signedIn: this.d.auth.state().signedIn,
      sync: this.sync,
      ...(this.lastSeenAt !== undefined ? { lastSeenAt: this.lastSeenAt } : {}),
      ...(this.infraCostUsd !== undefined ? { infraCostUsd: this.infraCostUsd } : {}),
      uiUrl: this.uiUrl,
      clusterId: this.clusterId,
      connection: this.d.connectionId,
      inboxPending: this.bridge.pending.inboxPending,
      outboxPending: this.bridge.pending.outboxPending,
      ...(this.problem !== undefined ? { problem: this.problem } : {}),
    };
  }

  /** One frame per member, the shape `Runner.status()` has. */
  statuses(): LoopStatus[] {
    const loop = this.loop();
    if (loop === undefined) return [];
    const remote = this.remoteStatus();
    const state: LoopStatus['state'] =
      this.clusterState === 'running' || this.clusterState === 'starting'
        ? 'running'
        : this.clusterState === 'paused'
          ? 'paused'
          : this.clusterState === 'stopping'
            ? 'stopping'
            : 'stopped';
    return memberKeys(loop).map((key, i) => {
      const agent = this.agents.find((a) => a.agentId === `agent-${i}`);
      const iteration = agent?.lastEntry?.iteration ?? 0;
      return {
        id: key,
        loop: loop.id,
        member: i,
        state,
        ...(state === 'paused' && this.stateReason === 'autopause' ? { pausedFor: 'work' as const } : {}),
        iteration,
        ...(typeof agent?.totalCredits === 'number' ? { credits: agent.totalCredits } : {}),
        ...(this.runUntil !== undefined && state !== 'stopped' ? { deadlineAt: this.runUntil } : {}),
        remote,
      };
    });
  }

  private emitStatus(): void {
    for (const s of this.statuses()) this.d.emit('status', s);
  }

  /** The bridge log: system lines, the same for every member. */
  recentOutput(): OutputLine[] {
    return this.output;
  }

  private say(text: string): void {
    const loop = this.loop();
    const ts = new Date().toISOString();
    // One line per member key so every tab of the strip shows it; the buffer
    // keeps one copy under the loop id.
    const line: OutputLine = { loop: this.d.loopId, ts, kind: 'system', text };
    this.output.push(line);
    if (this.output.length > OUTPUT_KEEP) this.output.splice(0, this.output.length - OUTPUT_KEEP);
    if (loop === undefined) return;
    for (const key of memberKeys(loop)) this.d.emit('output', { ...line, loop: key });
  }

  // ---- the poll -------------------------------------------------------------

  private schedulePoll(ms: number): void {
    if (!this.attached) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().then(() => this.schedulePoll(this.isLive() ? STATUS_POLL_MS : STATUS_POLL_STOPPED_MS));
    }, ms);
    this.pollTimer.unref?.();
  }

  /** Read the cluster's status once and apply it. */
  async poll(): Promise<void> {
    if (this.polling !== null) return this.polling;
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    try {
      const st = await this.d.client.getStatus(this.clusterId);
      this.apply(st);
      this.lastStatusAt = Date.now();
      if (this.attached && Date.now() - this.lastSyncAt >= SYNC_POLL_MS) await this.pullFromFlock();
      await this.d.sidecar.patch(this.d.connectionId, this.clusterId, { lastState: st.clusterState, lastSeenAt: this.lastSeenAt });
      if (this.runUntil !== undefined && Date.now() >= this.runUntil && this.isLive() && !this.stopping) {
        const loop = this.loop();
        this.say(`run time of ${loop?.stopAfterHours ?? '?'} hours reached - stopping the cluster`);
        await this.stop();
      }
    } catch (e) {
      if (e instanceof SignedOutError) {
        this.sync = 'signed-out';
      } else if (e instanceof FlockApiError && e.status === 404) {
        if (this.clusterState !== 'gone') this.say('the cluster is no longer on the flock; nothing was recreated');
        this.clusterState = 'gone';
        await this.d.sidecar.patch(this.d.connectionId, this.clusterId, { lastState: 'gone' });
      } else if (this.sync === 'live' || this.sync === 'catching-up') {
        this.sync = 'unreachable';
      }
      this.emitStatus();
    }
  }

  private apply(st: ClusterStatus): void {
    const before = this.clusterState;
    // A poll that worked means the flock is reachable and the token is good;
    // what the sync says from here is the bridge's to say.
    if (this.sync === 'signed-out' || this.sync === 'unreachable') this.sync = this.bridge.sync;
    this.clusterState = st.clusterState;
    this.stateReason = st.stateReason ?? undefined;
    this.lastError = st.lastError ? `${st.lastError.code}: ${st.lastError.message}` : undefined;
    this.lastSeenAt = new Date().toISOString();
    this.infraCostUsd = typeof st.infraCostUsd === 'number' ? st.infraCostUsd : undefined;
    this.agents = st.agents;
    if (before !== this.clusterState) {
      if (this.clusterState === 'running' && before === 'starting') this.say('cluster is running');
      if (this.clusterState === 'paused') this.say(`cluster paused${this.stateReason ? ` (${this.stateReason})` : ''}`);
      if (this.clusterState === 'stopped' && (before === 'stopping' || before === 'running')) {
        this.say(this.lastError ? `cluster stopped: ${this.lastError}` : 'cluster stopped');
      }
    }
    this.emitStatus();
  }

  // ---- lifecycle -------------------------------------------------------------

  /**
   * Start: validate, probe, configure, push the direction, start, attach.
   * Throws `RemoteStartError` with the flock's own words when it refuses.
   */
  async start(): Promise<void> {
    const loop = this.loop();
    const factory = this.d.factory();
    if (loop === undefined || loop.remote === undefined) throw new RemoteStartError('not a remote loop');
    this.problem = undefined;

    let models: string[] | undefined;
    try {
      models = (await this.d.client.listModels()).models.map((m) => m.model_id);
    } catch (e) {
      if (e instanceof SignedOutError) throw new RemoteStartError('the connection is signed out - sign in first');
      throw new RemoteStartError(`flock not reachable: ${(e as Error).message}`);
    }
    const problems = startProblems(loop, factory, { models, connectionExists: true, signedIn: this.d.auth.state().signedIn });
    if (problems.length > 0) throw new RemoteStartError(describeProblems(problems));

    if (!(await this.d.client.hasQueueRoutes(this.clusterId))) {
      this.problem = 'Update your flock to use remote loops: route env-list is missing';
      this.emitStatus();
      throw new RemoteStartError(this.problem);
    }

    const size = loop.cluster?.size ?? 2;
    const want = desiredConfig(loop, factory.remoteGroup);
    try {
      // Read first and send only what differs: the flock merges partial updates,
      // and a config nobody changed should not be rewritten on every start.
      let current: Partial<ClusterConfig> = {};
      try {
        current = await this.d.client.getConfig(this.clusterId);
      } catch (e) {
        if (!(e instanceof FlockApiError) || e.status !== 404) throw e;
      }
      const patch: Partial<ClusterConfig> = {};
      for (const [k, v] of Object.entries(want) as [keyof ClusterConfig, unknown][]) {
        if (!same(current[k], v)) (patch as Record<string, unknown>)[k] = v;
      }
      let agreedConfig = current;
      if (Object.keys(patch).length > 0 || Object.keys(current).length === 0) agreedConfig = await this.d.client.setConfig(this.clusterId, patch);
      // The group the cluster will run with is now settled; every path below uses it.
      this.group = agreedConfig.everforgeGroup ?? null;
      const direction = buildRemoteDirection(loop, factory, this.clusterId, this.d.connectionId, this.group);
      await this.d.client.setDirection(this.clusterId, direction);
      await this.d.client.queuePut(this.clusterId, 'queue/PROTOCOL.md', protocolText(this.clusterId, this.group));
      await this.d.client.start(this.clusterId);
      // The flock's answer to the write, not what was sent: it fills in what the
      // document left out, and a diff against anything else would read those
      // as edits on the flock.
      this.agreed = { config: { ...agreedConfig }, direction };
      this.lastSyncAt = Date.now();
    } catch (e) {
      if (e instanceof RemoteStartError) throw e;
      throw new RemoteStartError(e instanceof Error ? e.message : String(e));
    }

    this.stopping = false;
    this.runUntil = loop.stopAfterHours !== undefined ? Date.now() + loop.stopAfterHours * 3_600_000 : undefined;
    await this.d.sidecar.put({
      loopId: loop.id,
      connection: this.d.connectionId,
      clusterId: this.clusterId,
      startedAt: new Date().toISOString(),
      lastState: 'starting',
      ...(this.runUntil !== undefined ? { runUntil: new Date(this.runUntil).toISOString() } : {}),
    });
    this.clusterState = 'starting';
    this.say(`starting ${size} nodes on ${this.d.connectionName} as ${this.clusterId} - ECS tasks take a minute or two`);
    this.emitStatus();
    await this.attachInternal(false);
    // Watch the start land, in the background: a launch failure shows up as
    // `lastError` with the state back at stopped.
    void this.awaitRunning();
  }

  private async awaitRunning(): Promise<void> {
    const end = Date.now() + START_WAIT_MS;
    while (this.attached && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 3000));
      await this.poll();
      if (this.clusterState !== 'starting') return;
    }
  }

  /**
   * Reconnect to a cluster this factory started earlier. Reads the status,
   * catches up on output, wakes an autopause with work waiting, applies an
   * overdue timed stop. Never starts or stops anything otherwise.
   */
  async attach(): Promise<void> {
    const entry = await this.d.sidecar.get(this.d.connectionId, this.clusterId);
    if (entry?.runUntil !== undefined) {
      const t = new Date(entry.runUntil).getTime();
      if (Number.isFinite(t)) this.runUntil = t;
    }
    /*
     * Is the cluster still there? `status` on an unknown id answers `stopped`
     * (the flock synthesises a state for a cluster that never wrote one), so
     * absence has to be read off the registry. A cluster deleted in the flock UI
     * while the factory was away is marked `gone` and nothing is recreated.
     */
    try {
      const listed = (await this.d.client.listClusters()).some((c) => c.id === this.clusterId);
      if (!listed) {
        this.clusterState = 'gone';
        this.say('the cluster is no longer on the flock; nothing was recreated');
        await this.d.sidecar.patch(this.d.connectionId, this.clusterId, { lastState: 'gone' });
        this.emitStatus();
        return;
      }
    } catch (e) {
      if (e instanceof SignedOutError) {
        this.sync = 'signed-out';
        this.emitStatus();
      }
      // Unreachable: attach anyway; the poll's backoff takes it from here.
    }
    await this.attachInternal(true);
  }

  /**
   * The operator signed in again (or the flock came back): stop waiting out the
   * backoff and sync now. The bridge's and the poll's own next ticks would get
   * there within a minute; this makes the banner go away when the button is pressed.
   */
  async resumeSync(): Promise<void> {
    if (!this.attached) {
      await this.attach();
      return;
    }
    await this.poll();
    this.bridge.kick();
    await this.bridge.tick();
  }

  private async attachInternal(catchUp: boolean): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    if (this.agreed === undefined) await this.adopt();
    await this.poll();
    if (this.clusterState === 'gone') {
      this.attached = false;
      return;
    }
    await this.bridge.start();
    this.schedulePoll(STATUS_POLL_MS);
    if (catchUp) {
      this.say('reconnected to the cluster - collecting output produced while the factory was away');
      this.sync = 'catching-up';
      this.emitStatus();
      try {
        await this.bridge.catchUp();
        await this.bridge.tick();
        // The bridge only reports a *change*; its state may have been `live` all
        // along, so read it rather than wait to be told.
        this.sync = this.bridge.sync;
      } catch (e) {
        if (e instanceof SignedOutError) this.sync = 'signed-out';
        else {
          this.sync = 'unreachable';
          this.say(`catch-up interrupted: ${(e as Error).message}; retrying in the background`);
        }
      }
      await this.wakeIfAutopaused();
    }
    this.emitStatus();
  }

  /** Stop the poll and the bridge. The cluster is left exactly as it is. */
  detach(): void {
    this.attached = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.bridge.stop();
  }

  /**
   * Pause the cluster: the nodes go to a slow poll and spend no credits. The
   * tasks stay up and keep billing, which the button's tooltip says. The flock
   * records the reason as `manual`, so the bridge's autopause wake-up (which
   * only resumes an `autopause`) leaves it alone until Start is pressed.
   */
  async pause(): Promise<void> {
    if (this.clusterState !== 'running' && this.clusterState !== 'starting') return;
    this.say('pausing the cluster - nodes stop taking turns; the tasks keep running and billing');
    try {
      await this.d.client.pause(this.clusterId);
    } catch (e) {
      this.say(`pause failed: ${(e as Error).message}`);
      throw e;
    }
    this.clusterState = 'paused';
    this.stateReason = 'manual';
    this.emitStatus();
    void this.poll();
  }

  /** Resume a paused cluster. Start on a paused remote loop lands here. */
  async resume(): Promise<void> {
    if (this.clusterState !== 'paused') return;
    this.say('resuming the cluster');
    try {
      await this.d.client.resume(this.clusterId);
    } catch (e) {
      this.say(`resume failed: ${(e as Error).message}`);
      throw e;
    }
    this.clusterState = 'running';
    this.stateReason = undefined;
    this.emitStatus();
    void this.poll();
  }

  /** Ask the flock to stop the cluster and watch it land. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.say('stopping the cluster - remote nodes do not finish their current turn');
    try {
      await this.d.client.stop(this.clusterId);
    } catch (e) {
      this.stopping = false;
      this.say(`stop failed: ${(e as Error).message}`);
      throw e;
    }
    this.clusterState = 'stopping';
    this.emitStatus();
    // Collect what the nodes wrote on their way out, then poll until stopped.
    void (async () => {
      const end = Date.now() + 120_000;
      while (this.attached && Date.now() < end && this.clusterState === 'stopping') {
        await new Promise((r) => setTimeout(r, 2000));
        await this.poll();
      }
      if (!this.attached) return;
      try {
        await this.bridge.catchUp();
      } catch {
        /* the regular tick retries */
      }
      this.stopping = false;
      this.runUntil = undefined;
      await this.d.sidecar.patch(this.d.connectionId, this.clusterId, { runUntil: undefined, lastState: this.clusterState === 'gone' ? 'gone' : 'stopped' });
    })();
  }

  /** The same flock call; the bridge stops at once and nothing is awaited. */
  async forceStop(): Promise<void> {
    this.stopping = true;
    this.say('force stop - stopping the cluster now');
    try {
      await this.d.client.stop(this.clusterId);
    } catch (e) {
      this.say(`stop failed: ${(e as Error).message}`);
    }
    this.clusterState = 'stopping';
    this.runUntil = undefined;
    this.stopping = false;
    this.emitStatus();
    void this.poll();
  }

  /**
   * Remove the cluster from the flock: stop if live, wait, unregister.
   * `removeFiles` also deletes `environment/<id>/`, which is irreversible.
   */
  async destroy(removeFiles: boolean): Promise<void> {
    await this.poll();
    if (this.isLive()) {
      await this.d.client.stop(this.clusterId);
      const end = Date.now() + 180_000;
      while (Date.now() < end) {
        await new Promise((r) => setTimeout(r, 2000));
        await this.poll();
        if (!this.isLive()) break;
      }
    }
    this.detach();
    if (this.clusterState !== 'gone') {
      try {
        await this.d.client.deleteCluster(this.clusterId);
      } catch (e) {
        if (!(e instanceof FlockApiError) || e.status !== 404) throw e;
      }
    }
    if (removeFiles) await this.d.client.deleteEnvFolder(this.group ? `environment/${this.group}/${this.clusterId}/` : `environment/${this.clusterId}/`);
    await this.d.sidecar.remove(this.d.connectionId, this.clusterId);
    await this.d.sidecar.removeBridgeDir(this.d.connectionId, this.clusterId);
  }

  /** Resume a cluster the flock paused for idleness, now that there is work. */
  private async wakeIfAutopaused(): Promise<void> {
    if (this.clusterState !== 'paused' || this.stateReason !== 'autopause') return;
    const loop = this.loop();
    if (loop === undefined) return;
    try {
      const inbox = await this.d.client.queueList(this.clusterId, { prefix: 'queue/in/', limit: 1 });
      if (inbox.files.length === 0 && this.bridge.pending.outgoing === 0) return;
      await this.d.client.resume(this.clusterId);
      this.say('work arrived - resumed the autopaused cluster');
      await this.poll();
    } catch (e) {
      if (!(e instanceof FlockApiError && e.status === 409)) this.say(`could not resume: ${(e as Error).message}`);
    }
  }

  // ---- two-way sync ----------------------------------------------------------

  /**
   * Reconnecting to a cluster started earlier: take the document as the agreed
   * state, then let whatever the flock holds that differs flow into the document.
   * The flock is what has been running while the factory was away, and an edit
   * made on its dashboard in the meantime is the newer one.
   */
  private async adopt(): Promise<void> {
    const loop = this.loop();
    if (loop === undefined || loop.remote === undefined) return;
    this.agreed = {
      config: desiredConfig(loop, this.d.factory().remoteGroup),
      direction: buildRemoteDirection(loop, this.d.factory(), this.clusterId, this.d.connectionId, this.d.factory().remoteGroup),
    };
    await this.pullFromFlock();
  }

  /**
   * The flock's side of the sync, one run at a time: read the config and the
   * direction, and write whatever differs from the agreed state into the
   * document. Called from the poll every `SYNC_POLL_MS`, and once on attach.
   */
  async pullFromFlock(): Promise<void> {
    if (this.syncing !== null) return this.syncing;
    this.syncing = this.pullOnce().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async pullOnce(): Promise<void> {
    const loop = this.loop();
    if (loop === undefined || loop.remote === undefined || this.agreed === undefined) return;
    this.lastSyncAt = Date.now();
    let cfg: Partial<ClusterConfig>;
    let onFlock: string;
    try {
      cfg = await this.d.client.getConfig(this.clusterId);
      onFlock = await this.d.client.getDirection(this.clusterId);
    } catch (e) {
      if (e instanceof SignedOutError) this.sync = 'signed-out';
      // Anything else: the next run reads again.
      return;
    }
    // What the cluster actually runs with; a document that wants another group
    // gets it at the next start, not now (the agents read theirs at boot).
    const flockGroup = cfg.everforgeGroup ?? null;
    if (flockGroup !== this.group) {
      this.group = flockGroup;
      this.agreed.direction = buildRemoteDirection(loop, this.d.factory(), this.clusterId, this.d.connectionId, this.group);
    }
    this.agreed.config.everforgeGroup = cfg.everforgeGroup ?? undefined;
    let patch: Partial<Loop> = {};
    const changed: string[] = [];
    for (const key of SYNCED) {
      if (!(key in cfg) || same(cfg[key], this.agreed.config[key])) continue;
      // One patch on top of the other: two remote keys both rewrite `remote`.
      const next = loopPatchFor({ ...loop, ...patch }, key, cfg[key]);
      patch = { ...patch, ...next };
      this.agreed.config[key] = cfg[key] as never;
      changed.push(key);
    }
    if (changed.length > 0) {
      try {
        await this.d.patchLoop(loop.id, patch);
        this.say(`settings changed on the flock, taken into the document: ${changed.join(', ')}`);
      } catch (e) {
        this.say(`could not take the flock's settings into the document: ${(e as Error).message}`);
      }
    }
    try {
      await this.pullDirection(onFlock);
    } catch (e) {
      this.say(`could not sync the direction: ${(e as Error).message}`);
    }
  }

  /**
   * A direction that is not the one last agreed was edited on the flock. The
   * prompt between the marker and the queues block becomes the loop's prompt,
   * then the direction is rebuilt from that prompt and written back, so the
   * marker and the queues block are whole again whatever was done to them.
   */
  private async pullDirection(onFlock: string): Promise<void> {
    const loop = this.loop();
    if (loop === undefined || loop.remote === undefined || this.agreed === undefined) return;
    if (onFlock === this.agreed.direction) return;
    const factory = this.d.factory();
    const pulled = promptFromDirection(onFlock, this.clusterId, this.group);
    if (pulled === null) {
      // Emptied, or only the factory's parts left: the prompt stands and the
      // direction is put back.
      await this.d.client.setDirection(this.clusterId, this.agreed.direction);
      this.say('the direction on the flock was emptied; the prompt was written back');
      return;
    }
    // Build, then read the build back: the prompt the document keeps is the one
    // that round-trips, so the next poll sees agreement rather than a second
    // change. Parameter values written on the flock stay as values here.
    const built = buildRemoteDirection({ ...loop, prompt: pulled }, factory, this.clusterId, this.d.connectionId, this.group);
    const prompt = promptFromDirection(built, this.clusterId, this.group) ?? pulled;
    this.agreed.direction = built;
    if (built !== onFlock) await this.d.client.setDirection(this.clusterId, built);
    if (prompt !== loop.prompt) {
      try {
        await this.d.patchLoop(loop.id, { prompt });
        const hasParams = (factory.parameters ?? []).length > 0;
        this.say(`prompt changed on the flock, taken into the document${hasParams ? ' (parameters appear as their values)' : ''}`);
      } catch (e) {
        this.say(`could not take the flock's direction into the document: ${(e as Error).message}`);
      }
    }
  }

  /**
   * The document changed. Every setting and the direction that differ from the
   * agreed state go to the flock, live cluster or not; the flock applies the
   * dynamic ones (autopause, model, interval, direction) on the nodes' next turn
   * and keeps the restart-required ones (size, algorithm, radius, K, task size,
   * browser, trust deploy, reflect) for the next Start, which is said in the log.
   */
  async pushDocument(): Promise<void> {
    const loop = this.loop();
    if (loop === undefined || loop.remote === undefined || this.agreed === undefined || !this.attached) return;
    const factory = this.d.factory();
    try {
      const direction = buildRemoteDirection(loop, factory, this.clusterId, this.d.connectionId, this.group);
      if (direction !== this.agreed.direction) {
        await this.d.client.setDirection(this.clusterId, direction);
        this.agreed.direction = direction;
        this.say('direction updated - nodes read it on their next turn');
      }
      // The group is start-only: while the cluster runs, keep the one it has.
      const want = desiredConfig(loop, this.isLive() ? this.group : factory.remoteGroup);
      const patch: Partial<ClusterConfig> = {};
      for (const [k, v] of Object.entries(want) as [keyof ClusterConfig, unknown][]) {
        if (!same(this.agreed.config[k], v)) (patch as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(patch).length > 0) {
        const merged = await this.d.client.setConfig(this.clusterId, patch);
        this.agreed.config = { ...merged };
        const keys = Object.keys(patch);
        this.say(`config updated: ${keys.join(', ')}`);
        const restart = keys.filter((k) => ['concurrency', 'algorithm', 'neighbourRadius', 'swarmK', 'taskSize', 'browserAutomation', 'trustDeploy', 'selfOptimizing'].includes(k));
        if (restart.length > 0 && this.isLive()) this.say(`${restart.join(', ')}: the flock applies these on the next start`);
      }
    } catch (e) {
      this.say(`could not push the document: ${(e as Error).message}`);
    }
  }

  /** The timed stop, from the document, applied without a restart. */
  setRunUntilFromDocument(): void {
    const loop = this.loop();
    if (loop === undefined) return;
    if (loop.stopAfterHours === undefined) {
      if (this.runUntil !== undefined) {
        this.runUntil = undefined;
        void this.d.sidecar.patch(this.d.connectionId, this.clusterId, { runUntil: undefined });
      }
    }
  }

  /** Whether a cluster on the flock carries this factory's marker. */
  static async ownedBy(client: FlockClient, clusterId: string, factoryId: string, loopId: string, connectionId: string): Promise<boolean> {
    try {
      const m = readMarker(await client.getDirection(clusterId));
      return m !== null && m.factoryId === factoryId && m.loopId === loopId && m.connectionId === connectionId;
    } catch {
      return false;
    }
  }

  /** For the panel: the flock's own per-agent label. */
  static agentLabel(member: number): string {
    return `${nodeLabel(member)} (agent-${member})`;
  }

  get state(): ClusterState | 'gone' | 'unknown' {
    return this.clusterState;
  }

  get lastPolledAt(): number {
    return this.lastStatusAt;
  }
}
