/**
 * The queue bridge: local folders on one side, one cluster's S3 queues on the other.
 *
 * Two pumps, both idempotent, both restartable from whatever is on disk:
 *
 * **Input** (local to remote, every 2 s while there is anything to do). Items on
 * the loop's incoming folders are *taken* - renamed into `outgoing/` under the
 * bridge folder, the same atomic claim a local consumer makes, so a local loop
 * competing on the same queue keeps its semantics - then uploaded to
 * `queue/in/<id>.json` with if-none-match, and only then removed from
 * `outgoing/`. A crash between the rename and the upload leaves the item in
 * `outgoing/`, which is the first thing the next tick looks at. A 412 on upload
 * means the previous attempt landed, and counts as success.
 *
 * **Output** (remote to local, every 5 s while the cluster is live, 30 s when it
 * is stopped). `queue/out/` is listed, each result is written to every folder
 * the loop's outgoing wires deliver into (deterministic name, create-only, so a
 * repeat is a no-op), and then the remote object is *moved* to
 * `queue/claimed/out/` - put, then delete. Whatever is still in `out/` has not
 * been collected; there is no local ledger to lose.
 *
 * Delivery is at least once. The window between the local write and the remote
 * move can, on a crash, deliver one item twice; the deterministic file name
 * means only a consumer that already took the first copy sees the second.
 *
 * Nothing here touches cluster state. Starting, stopping and resuming are
 * `RemoteCluster`'s; the bridge only asks what the state is and says when it
 * has uploaded something, so the cluster can wake an autopaused flock.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { channelDir, isSafeId, wiresOf, type Factory } from '../factory.ts';
import type { QueueItem } from '../queue.ts';
import { SignedOutError } from './auth.ts';
import { FlockApiError, QueueExistsError, type ClusterState, type FlockClient, type QueueEntry } from './client.ts';
import type { Sidecar } from './sidecar.ts';

export type SyncState = 'live' | 'catching-up' | 'signed-out' | 'unreachable';

/**
 * An id a remote result may use as its local filename: `isSafeId`'s rules, no
 * leading dot (a dotfile is skipped by the consumer and could shadow the temp
 * names `writeOnce` uses), and short enough for any filesystem with `.json`.
 */
export function isSafeItemId(id: string): boolean {
  return isSafeId(id) && !id.startsWith('.') && id.length <= 200 && !/[\s]/.test(id);
}

/** The most bytes one item may carry inline, including an inlined artifact. */
export const ITEM_MAX_BYTES = 262_144;
/** How many `out/` items one collector pass handles before yielding. */
export const COLLECT_BATCH = 200;
const PUMP_MS = 2000;
const COLLECT_LIVE_MS = 5000;
const COLLECT_STOPPED_MS = 30_000;
const BACKOFF_MIN_S = 2;
const BACKOFF_MAX_S = 60;

export interface BridgeCounts {
  /** Items in `queue/in/` at the last listing. */
  inboxPending: number;
  /** Items in `queue/out/` at the last listing. */
  outboxPending: number;
  /** Items taken locally and not yet uploaded. */
  outgoing: number;
}

export interface BridgeDeps {
  client: FlockClient;
  clusterId: string;
  /** The deployment group the cluster runs with, which nests its folder; null when none. */
  group: () => string | null;
  connectionId: string;
  loopId: string;
  baseDir: string;
  sidecar: Sidecar;
  /** The current document; re-read every tick so wiring changes take effect. */
  factory(): Factory;
  /** The cluster's last known state, from the status poll. */
  clusterState(): ClusterState | 'gone' | 'unknown';
  /** A system line for the bridge log. */
  log(line: string): void;
  /** Something was uploaded; the cluster may want to resume an autopause. */
  onUploaded(): void;
  /** Sync state changed. */
  onSync(state: SyncState): void;
}

export class QueueBridge {
  private readonly d: BridgeDeps;
  private dir: string | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private failures = 0;
  private lastCollectEmpty = false;
  private lastCollectAt = 0;
  private syncState: SyncState = 'live';
  private counts: BridgeCounts = { inboxPending: 0, outboxPending: 0, outgoing: 0 };
  private wake: (() => void) | null = null;

  constructor(deps: BridgeDeps) {
    this.d = deps;
  }

  get sync(): SyncState {
    return this.syncState;
  }

  get pending(): BridgeCounts {
    return this.counts;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.dir = await this.d.sidecar.bridgeDir(this.d.connectionId, this.d.clusterId);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
  }

  /** Forget the backoff: the next tick is now. For a sign-in or a flock that came back. */
  kick(): void {
    this.failures = 0;
    if (this.syncState === 'signed-out' || this.syncState === 'unreachable') this.setSync('live');
    if (this.running) this.schedule(0);
  }

  /** Run both pumps once, now. Tests and the reconnect path use it. */
  async tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    this.ticking = this.runOnce().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Collect until `out/` is exhausted (the catch-up after a gap). */
  async catchUp(): Promise<void> {
    if (this.dir === null) this.dir = await this.d.sidecar.bridgeDir(this.d.connectionId, this.d.clusterId);
    for (;;) {
      const more = await this.collect(true);
      this.lastCollectAt = Date.now();
      this.setSync(more ? 'catching-up' : 'live');
      if (!more) break;
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().then(() => this.schedule(this.nextDelay()));
    }, ms);
    this.timer.unref?.();
  }

  private nextDelay(): number {
    if (this.failures > 0) return Math.min(BACKOFF_MAX_S, BACKOFF_MIN_S * 2 ** (this.failures - 1)) * 1000;
    return PUMP_MS;
  }

  private setSync(s: SyncState): void {
    if (s === this.syncState) return;
    this.syncState = s;
    this.d.onSync(s);
  }

  private async runOnce(): Promise<void> {
    if (this.dir === null) return;
    const now = Date.now();
    try {
      await this.pump();
      const state = this.d.clusterState();
      const interval = state === 'stopped' && this.lastCollectEmpty ? COLLECT_STOPPED_MS : COLLECT_LIVE_MS;
      if (now - this.lastCollectAt >= interval) {
        const more = await this.collect(false);
        this.lastCollectAt = now;
        this.setSync(more ? 'catching-up' : 'live');
      } else if (this.syncState !== 'catching-up') {
        this.setSync('live');
      }
      this.failures = 0;
      await this.d.sidecar.writeBridgeState(this.dir, { lastSyncAt: new Date().toISOString() });
    } catch (e) {
      this.failures += 1;
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof SignedOutError) {
        this.setSync('signed-out');
      } else {
        this.setSync('unreachable');
        if (this.failures === 1) this.d.log(`flock not reachable: ${message}; retrying`);
      }
      await this.d.sidecar.writeBridgeState(this.dir, { lastError: message }).catch(() => {});
    }
  }

  // ---- input -----------------------------------------------------------------

  private incomingDirs(): string[] {
    const factory = this.d.factory();
    return [...new Set(wiresOf(factory, this.d.loopId).reads.map(channelDir))].map((rel) => path.resolve(this.d.baseDir, rel));
  }

  private async pump(): Promise<void> {
    const dir = this.dir as string;
    const outgoing = path.join(dir, 'outgoing');
    // Whatever a previous run left behind goes first.
    await this.uploadAll(outgoing);
    for (const incoming of this.incomingDirs()) {
      let names: string[];
      try {
        names = (await fsp.readdir(incoming)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          await fsp.rename(path.join(incoming, name), path.join(outgoing, name));
        } catch {
          // A local consumer on the same queue took it first. Theirs now.
        }
      }
    }
    await this.uploadAll(outgoing);
    this.counts = { ...this.counts, outgoing: (await fsp.readdir(outgoing)).filter((n) => n.endsWith('.json')).length };
  }

  private async uploadAll(outgoing: string): Promise<void> {
    const names = (await fsp.readdir(outgoing)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
    if (names.length === 0) return;
    // Oldest first by the item's own timestamp, so a backlog arrives in order.
    const items: { name: string; item: QueueItem }[] = [];
    for (const name of names) {
      try {
        const item = JSON.parse(await fsp.readFile(path.join(outgoing, name), 'utf8')) as QueueItem;
        items.push({ name, item });
      } catch {
        await this.reject(outgoing, name, 'not a JSON item');
      }
    }
    items.sort((a, b) => (a.item.ts < b.item.ts ? -1 : a.item.ts > b.item.ts ? 1 : 0));
    let uploaded = 0;
    for (const { name, item } of items) {
      const body = await this.inlineArtifact(item);
      if (body === null) {
        await this.reject(outgoing, name, `over ${ITEM_MAX_BYTES} bytes with its artifact`);
        continue;
      }
      const key = `queue/in/${name}`;
      try {
        await this.d.client.queuePut(this.d.clusterId, key, body, true);
      } catch (e) {
        if (!(e instanceof QueueExistsError)) throw e;
      }
      await fsp.rm(path.join(outgoing, name), { force: true });
      uploaded += 1;
    }
    if (uploaded > 0) {
      this.d.log(`${uploaded} item${uploaded === 1 ? '' : 's'} sent to the cluster`);
      this.d.onUploaded();
    }
  }

  /**
   * The item as it goes up: with an `artifact` read and inlined as
   * `payload.artifactContent`, since the agent has no view of this disk. Null
   * when the result would be over the put limit.
   */
  private async inlineArtifact(item: QueueItem): Promise<string | null> {
    let out: QueueItem & { payload?: unknown } = item;
    if (typeof item.artifact === 'string') {
      const abs = path.resolve(this.d.baseDir, item.artifact);
      // Inside the factory's base directory only: an artifact is a relative
      // pointer written by a local loop, and a `..` in it is not followed.
      const rel = path.relative(this.d.baseDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      try {
        const content = await fsp.readFile(abs, 'utf8');
        const payload = typeof item.payload === 'object' && item.payload !== null ? { ...(item.payload as object) } : {};
        out = { ...item, payload: { ...payload, artifactContent: content, artifactPath: item.artifact } };
      } catch {
        // Unreadable: send the pointer as is; the agent will say so.
      }
    }
    const body = JSON.stringify(out);
    return Buffer.byteLength(body, 'utf8') > ITEM_MAX_BYTES ? null : body;
  }

  private async reject(outgoing: string, name: string, why: string): Promise<void> {
    const dir = this.dir as string;
    await fsp.rename(path.join(outgoing, name), path.join(dir, 'rejected', name)).catch(() => {});
    this.d.log(`${name} could not be forwarded (${why}); parked in rejected/`);
  }

  // ---- output ----------------------------------------------------------------

  private outgoingDirs(): string[] {
    const factory = this.d.factory();
    return [...new Set(wiresOf(factory, this.d.loopId).writes.map(channelDir))].map((rel) => path.resolve(this.d.baseDir, rel));
  }

  /**
   * One pass over `queue/out/`. Returns true when there is more to do (the
   * listing was truncated or the batch filled), so the caller can keep going.
   */
  private async collect(exhaustive: boolean): Promise<boolean> {
    const page = await this.d.client.queueList(this.d.clusterId, { prefix: 'queue/out/', limit: exhaustive ? 1000 : COLLECT_BATCH, inline: true });
    const inbox = await this.d.client.queueList(this.d.clusterId, { prefix: 'queue/in/', limit: 1000 });
    this.counts = { ...this.counts, inboxPending: inbox.files.length + (inbox.next ? 1 : 0), outboxPending: page.files.length + (page.next ? 1 : 0) };
    const entries = page.files.filter((f) => f.key.endsWith('.json'));
    this.lastCollectEmpty = entries.length === 0;
    if (entries.length === 0) return false;

    const destinations = this.outgoingDirs();
    if (destinations.length === 0) {
      // Nowhere to deliver: leave the results in out/ so they are not lost and
      // the count shows on the card. Wiring the loop later collects them.
      return false;
    }
    for (const dest of destinations) await fsp.mkdir(dest, { recursive: true });

    const moved: string[] = [];
    let delivered = 0;
    for (const entry of entries) {
      const g = this.d.group();
      const body = entry.content ?? (await this.d.client.readFile(`environment/${g ? `${g}/` : ''}${this.d.clusterId}/${entry.key}`));
      const item = this.toItem(entry, body);
      if (item === null) {
        await this.parkRemote(entry.key, body);
        continue;
      }
      for (const dest of destinations) {
        if (await writeOnce(dest, `${item.id}.json`, JSON.stringify(item, null, 2))) delivered += 1;
      }
      // Move: put to claimed/out/, then delete from out/. Put first so a crash
      // between the two leaves a copy in both places rather than in neither.
      const name = entry.key.slice('queue/out/'.length);
      await this.d.client.queuePut(this.d.clusterId, `queue/claimed/out/${name}`, body);
      moved.push(entry.key);
      if (moved.length >= 100) {
        await this.d.client.queueDelete(this.d.clusterId, moved.splice(0));
      }
    }
    if (moved.length > 0) await this.d.client.queueDelete(this.d.clusterId, moved);
    if (delivered > 0) this.d.log(`${entries.length} result${entries.length === 1 ? '' : 's'} collected from the cluster`);
    return page.next !== null || entries.length >= (exhaustive ? 1000 : COLLECT_BATCH);
  }

  /**
   * A result file as a local queue item. Null when the body is not JSON, or when
   * it names an id this side will not use as a filename.
   *
   * Everything in the body is untrusted: any agent on the flock can write to
   * `queue/out/`, and what is written here becomes a file on the operator's
   * machine that a local loop with shell access then acts on. Two fields matter:
   *
   * - `id` becomes the local filename. It must pass `isSafeId` (no separators,
   *   not `.` or `..`) and be short; `writeOnce` checks the resolved path too.
   *   The S3 key stem is only a fallback once it passes the same test - the
   *   Lambda's scoped routes already refuse `..` in keys, but nothing this side
   *   should depend on that.
   * - `artifact` is dropped. On upload it names a file inside this project; on
   *   download it would name a file on this machine for the local loop to read,
   *   and a remote agent has no business choosing which. Anything a cluster
   *   wants to hand back travels inline as `payload`.
   */
  private toItem(entry: QueueEntry, body: string): QueueItem | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const stem = entry.key.slice('queue/out/'.length).replace(/\.json$/, '');
    const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { payload: parsed };
    // A present-but-unusable id is refused rather than renamed: a result that
    // tried to pick its own path is one to look at, not to quietly deliver.
    const id = typeof obj.id === 'string' && obj.id.length > 0 ? (isSafeItemId(obj.id) ? obj.id : null) : isSafeItemId(stem) ? stem : null;
    if (id === null) return null;
    return {
      id,
      ts: typeof obj.ts === 'string' ? obj.ts : entry.lastModified || new Date().toISOString(),
      producer: this.d.loopId,
      ...(obj.payload !== undefined ? { payload: obj.payload } : {}),
    };
  }

  /** A result the factory will not take goes to `queue/rejected/` on the flock. */
  private async parkRemote(key: string, body: string): Promise<void> {
    const name = key.slice('queue/out/'.length);
    try {
      await this.d.client.queuePut(this.d.clusterId, `queue/rejected/${name}`, body);
      await this.d.client.queueDelete(this.d.clusterId, [key]);
      this.d.log(`${name} from the cluster is not JSON or has an unusable id; parked in queue/rejected/`);
    } catch (e) {
      if (e instanceof FlockApiError) throw e;
    }
  }
}

/**
 * Write a file only if it does not exist. Temp file plus `link`, which fails
 * with EEXIST rather than overwriting; the temp is removed either way. Returns
 * whether a new file appeared.
 */
async function writeOnce(dir: string, name: string, text: string): Promise<boolean> {
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  // Belt to `isSafeItemId`'s braces: whatever the name, both paths stay in `dir`.
  const root = path.resolve(dir);
  for (const p of [target, tmp]) {
    if (path.dirname(path.resolve(p)) !== root) throw new Error(`refusing to write outside ${dir}: ${name}`);
  }
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.link(tmp, target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
