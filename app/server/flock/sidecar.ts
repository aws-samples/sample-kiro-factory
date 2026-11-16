/**
 * What this machine remembers about remote loops: `<baseDir>/.kirofactory/remote.json`
 * and one folder per cluster under `<baseDir>/.kirofactory/remote/`.
 *
 * Never committed, like `worktrees.json`, and for the same reason: it describes
 * this machine's view of clusters that live elsewhere, not the design. Losing it
 * loses nothing that matters - the document still names the loop, the cluster id
 * is recomputable, the queues are in S3 - and `Host.prepare` rebuilds it by
 * asking the flock (plan section 9.3).
 *
 * Keyed by `connectionId/clusterId`, so two flocks with a cluster of the same
 * name, or two connections to one flock, never share an entry or a folder.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { INTERNAL } from '../factory.ts';
import type { ClusterState } from './client.ts';

const FORMAT = 1;

export interface RemoteEntry {
  loopId: string;
  connection: string;
  clusterId: string;
  startedAt?: string;
  /** Last `clusterState` seen, or `gone` when the flock no longer lists it. */
  lastState?: ClusterState | 'gone';
  lastSeenAt?: string;
  /** Only when the run mode is "After N hours": when the factory stops it. */
  runUntil?: string;
}

interface RemoteFile {
  format: number;
  host: string;
  entries: Record<string, RemoteEntry>;
}

export interface BridgeState {
  lastSyncAt?: string;
  lastError?: string;
}

export function entryKey(connectionId: string, clusterId: string): string {
  return `${connectionId}/${clusterId}`;
}

export class Sidecar {
  private readonly file: string;
  private readonly root: string;
  private data: RemoteFile | null = null;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, INTERNAL, 'remote.json');
    this.root = path.join(baseDir, INTERNAL, 'remote');
  }

  /** The host name recorded on the file, for the "last driven from" warning. */
  static thisHost(): string {
    return os.hostname();
  }

  private async load(): Promise<RemoteFile> {
    if (this.data !== null) return this.data;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Partial<RemoteFile>;
      if (typeof raw !== 'object' || raw === null || typeof raw.entries !== 'object' || raw.entries === null) throw new Error('shape');
      this.data = { format: FORMAT, host: typeof raw.host === 'string' ? raw.host : Sidecar.thisHost(), entries: raw.entries as Record<string, RemoteEntry> };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt rather than absent: keep it for a look, start clean. The
        // sidecar-lost path in Host.prepare does the rest.
        await fsp.rename(this.file, `${this.file}.bad-${Date.now()}`).catch(() => {});
      }
      this.data = { format: FORMAT, host: Sidecar.thisHost(), entries: {} };
    }
    return this.data;
  }

  private async save(): Promise<void> {
    const data = await this.load();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  async host(): Promise<string> {
    return (await this.load()).host;
  }

  async entries(): Promise<RemoteEntry[]> {
    return Object.values((await this.load()).entries);
  }

  async get(connectionId: string, clusterId: string): Promise<RemoteEntry | undefined> {
    return (await this.load()).entries[entryKey(connectionId, clusterId)];
  }

  async forLoop(loopId: string): Promise<RemoteEntry | undefined> {
    return (await this.entries()).find((e) => e.loopId === loopId);
  }

  async put(entry: RemoteEntry): Promise<void> {
    const data = await this.load();
    data.host = Sidecar.thisHost();
    data.entries[entryKey(entry.connection, entry.clusterId)] = entry;
    await this.save();
  }

  async patch(connectionId: string, clusterId: string, changes: Partial<RemoteEntry>): Promise<void> {
    const data = await this.load();
    const key = entryKey(connectionId, clusterId);
    const current = data.entries[key];
    if (current === undefined) return;
    data.entries[key] = { ...current, ...changes };
    await this.save();
  }

  async remove(connectionId: string, clusterId: string): Promise<void> {
    const data = await this.load();
    delete data.entries[entryKey(connectionId, clusterId)];
    await this.save();
  }

  /** The per-cluster bridge folder, created. */
  async bridgeDir(connectionId: string, clusterId: string): Promise<string> {
    const dir = path.join(this.root, connectionId, clusterId);
    await fsp.mkdir(path.join(dir, 'outgoing'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'rejected'), { recursive: true });
    return dir;
  }

  async removeBridgeDir(connectionId: string, clusterId: string): Promise<void> {
    await fsp.rm(path.join(this.root, connectionId, clusterId), { recursive: true, force: true });
  }

  async readBridgeState(dir: string): Promise<BridgeState> {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, 'bridge.json'), 'utf8')) as BridgeState;
      return typeof raw === 'object' && raw !== null ? raw : {};
    } catch {
      return {};
    }
  }

  async writeBridgeState(dir: string, state: BridgeState): Promise<void> {
    const file = path.join(dir, 'bridge.json');
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fsp.rename(tmp, file);
  }
}

/**
 * The user-level list of clusters a removed factory left running:
 * `~/.kirofactory/remote-detached.json`. Keyed like the sidecar, with the
 * folder the factory lived in, so the orphan list can say where it came from.
 */
export interface DetachedRecord {
  connection: string;
  clusterId: string;
  loopId: string;
  factoryName: string;
  baseDir: string;
  detachedAt: string;
}

export class DetachedStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  async list(): Promise<DetachedRecord[]> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as { records?: unknown };
      return Array.isArray(raw.records) ? (raw.records as DetachedRecord[]) : [];
    } catch {
      return [];
    }
  }

  async add(record: DetachedRecord): Promise<void> {
    const list = (await this.list()).filter((r) => !(r.connection === record.connection && r.clusterId === record.clusterId));
    list.push(record);
    await this.write(list);
  }

  async remove(connectionId: string, clusterId: string): Promise<void> {
    await this.write((await this.list()).filter((r) => !(r.connection === connectionId && r.clusterId === clusterId)));
  }

  private async write(records: DetachedRecord[]): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, `${JSON.stringify({ format: FORMAT, records }, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.file);
  }
}
