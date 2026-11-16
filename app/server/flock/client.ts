/**
 * The flock REST API, as this program uses it.
 *
 * A port of the subset of `kiro-flock-mcp/src/flockClient.ts` a remote loop
 * needs, over `flockFetch` (so every call is SSRF-guarded) and `FlockAuth`
 * (so every call carries a fresh id token). Two things are fixed on the way:
 * `ClusterStatus.state` is really `clusterState` in the handler's response,
 * and the three Phase 0 queue routes are added. Everything the MCP has for
 * forge, the browser sign-in path, the coder bridge and `sleep`-based waiting is left out.
 *
 * Errors are `FlockApiError` with the HTTP status and the flock's own
 * `error` text, so the UI can show the flock's words - `concurrency 40 exceeds
 * the configured cap of 32` - rather than a paraphrase.
 */
import type { FlockAuth } from './auth.ts';
import { flockFetch, FlockNetError, type Fetcher, type FlockResponse } from './net.ts';

export class FlockApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'FlockApiError';
    this.status = status;
    this.body = body;
  }
}

export type ClusterState = 'stopped' | 'starting' | 'running' | 'stopping' | 'paused';
export type TaskSize = 'small' | 'medium' | 'large' | 'xlarge';

export interface ClusterConfig {
  concurrency: number;
  neighbourRadius: number;
  computeType?: 'ec2' | 'ecs';
  instanceType: string;
  taskSize?: TaskSize;
  loopIntervalSeconds: number;
  model: string | null;
  models?: Record<string, string | null>;
  algorithm: 'amorphous' | 'mesh' | 'swarm' | 'single';
  swarmK: number;
  autopause: boolean;
  selfOptimizing: boolean;
  browserAutomation: boolean;
  trustDeploy?: boolean;
  everforgeGroup?: string | null;
}

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface AgentSnapshot {
  agentId: string;
  instanceId: string | null;
  instanceState: string;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
  status?: string;
  totalCredits: number | null;
  infraCostUsd: number | null;
}

export interface ClusterStatus {
  clusterState: ClusterState;
  paused?: boolean;
  lastError?: { code: string; message: string; at: string } | null;
  stateReason?: string | null;
  agents: AgentSnapshot[];
  config?: ClusterConfig | null;
  lastBuilt?: string | null;
  clusterStartTime?: string | null;
  totalCredits?: number | null;
  infraCostUsd?: number | null;
}

export interface ClusterRegistryEntry {
  id: string;
  name: string;
  algorithm: string;
  createdAt: string;
  state?: ClusterState;
  totalCredits?: number | null;
  infraCostUsd?: number | null;
  lastError?: { code: string; message: string; at: string } | null;
}

export interface ModelCatalogEntry {
  model_id: string;
  model_name?: string;
  description?: string;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  default_model?: string | null;
}

export interface Limits {
  concurrencyCap: number;
  vcpuQuota?: number;
}

export type StreamKind = 'acp' | 'console';

export interface StreamResult {
  agentIndex: number;
  kind: StreamKind;
  content: string | null;
  unavailable?: string;
  sessionId?: string;
  sessionStatus?: 'active' | 'completed';
  sessionSizeBytes?: number;
  turnError?: string;
  fetchedAt: string;
}

export interface AcpSessionInfo {
  sessionId: string;
  iteration: number;
  exact: boolean;
  mtime: number;
  sizeBytes: number;
  active: boolean;
}

export interface SessionListResult {
  agentIndex: number;
  sessions: AcpSessionInfo[];
  unavailable?: string;
  fetchedAt: string;
}

export interface AgentCosts {
  agentIndex: number;
  entries: { ts: string; iteration: number; sessionId: string; credits: number | null; unmetered: boolean; totalCredits: number }[];
  totalCredits: number | null;
  unmeteredCount?: number;
}

/** One entry of `env-list`. `key` is relative to `environment/<clusterId>/`. */
export interface QueueEntry {
  key: string;
  size: number;
  lastModified: string;
  content?: string;
}

export interface QueueListPage {
  files: QueueEntry[];
  next: string | null;
}

/** Thrown by `queuePut` with `ifNoneMatch` when the object already exists. */
export class QueueExistsError extends FlockApiError {
  constructor(key: string) {
    super(`${key} exists`, 412, { error: 'exists' });
    this.name = 'QueueExistsError';
  }
}

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class FlockClient {
  private readonly base: string;
  private readonly auth: FlockAuth;
  private readonly fetcher: Fetcher;

  constructor(apiUrl: string, auth: FlockAuth, fetcher: Fetcher = flockFetch) {
    this.base = apiUrl.replace(/\/+$/, '');
    this.auth = auth;
    this.fetcher = fetcher;
  }

  private async request<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const token = await this.auth.idToken();
    const url = new URL(`${this.base}${path}`);
    let res: FlockResponse;
    try {
      res = await this.fetcher(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (e instanceof FlockNetError) throw new FlockApiError(e.message, 0);
      throw e;
    }
    if (res.status >= 400) {
      const json = res.json as { error?: unknown } | undefined;
      const text = typeof json?.error === 'string' ? json.error : `${method} ${path} failed (${res.status})`;
      throw new FlockApiError(text, res.status, res.json);
    }
    return res.json as T;
  }

  private cluster(action: string, clusterId: string, query?: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return `/cluster/${action}/${encodeURIComponent(clusterId)}${q ? `?${q}` : ''}`;
  }

  // ---- fleet ---------------------------------------------------------------

  async listClusters(): Promise<ClusterRegistryEntry[]> {
    const r = await this.request<{ clusters?: ClusterRegistryEntry[] }>('GET', '/cluster/list');
    return r.clusters ?? [];
  }

  async listModels(): Promise<ModelCatalog> {
    const r = await this.request<ModelCatalog>('GET', '/cluster/models');
    return { models: Array.isArray(r.models) ? r.models : [], default_model: r.default_model ?? null };
  }

  /** The live node cap and quota. Display only; the flock enforces it on `setConfig`. */
  async limits(): Promise<Limits> {
    const r = await this.request<{ concurrencyCap?: number; vcpuQuota?: number }>('GET', '/cluster/instance-types');
    return { concurrencyCap: typeof r.concurrencyCap === 'number' ? r.concurrencyCap : 64, vcpuQuota: r.vcpuQuota };
  }

  // ---- one cluster ---------------------------------------------------------

  async getStatus(clusterId: string): Promise<ClusterStatus> {
    const r = await this.request<ClusterStatus & { state?: ClusterState }>('GET', this.cluster('status', clusterId));
    // The handler writes `clusterState`; the MCP's type said `state`. Read
    // both so a flock that still says one or the other is understood.
    const clusterState = r.clusterState ?? r.state ?? 'stopped';
    return { ...r, clusterState, agents: Array.isArray(r.agents) ? r.agents : [] };
  }

  async getConfig(clusterId: string): Promise<ClusterConfig> {
    return this.request<ClusterConfig>('GET', this.cluster('config', clusterId));
  }

  /** Partial update; the flock merges and validates. The error is the flock's own text. */
  async setConfig(clusterId: string, patch: Partial<ClusterConfig>): Promise<ClusterConfig> {
    return this.request<ClusterConfig>('PUT', this.cluster('config', clusterId), patch);
  }

  async getDirection(clusterId: string): Promise<string> {
    const r = await this.request<{ direction?: string }>('GET', this.cluster('direction', clusterId));
    return typeof r.direction === 'string' ? r.direction : '';
  }

  async setDirection(clusterId: string, direction: string): Promise<void> {
    await this.request('PUT', this.cluster('direction', clusterId), { direction });
  }

  async start(clusterId: string): Promise<void> {
    await this.request('POST', this.cluster('start', clusterId), {});
  }

  async stop(clusterId: string): Promise<void> {
    await this.request('POST', this.cluster('stop', clusterId), {});
  }

  async pause(clusterId: string): Promise<void> {
    await this.request('POST', this.cluster('pause', clusterId), {});
  }

  async resume(clusterId: string): Promise<void> {
    await this.request('POST', this.cluster('resume', clusterId), {});
  }

  /** Unregister a stopped cluster. S3 data stays. */
  async deleteCluster(clusterId: string): Promise<void> {
    await this.request('DELETE', this.cluster('delete', clusterId));
  }

  /** Permanently delete `environment/<folder>/`. Irreversible. */
  async deleteEnvFolder(folder: string): Promise<number> {
    const r = await this.request<{ deleted?: number }>('POST', '/cluster/delete-env-folder', { folder });
    return r.deleted ?? 0;
  }

  // ---- agent output --------------------------------------------------------

  async agentStream(clusterId: string, agentIndex: number, kind: StreamKind, sessionId?: string): Promise<StreamResult> {
    if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) throw new FlockApiError('bad session id', 400);
    return this.request<StreamResult>('GET', this.cluster('agent-stream', clusterId, { agentIndex, kind, sessionId }));
  }

  async acpSessions(clusterId: string, agentIndex: number): Promise<SessionListResult> {
    return this.request<SessionListResult>('GET', this.cluster('agent-stream', clusterId, { agentIndex, kind: 'acp-list' }));
  }

  async agentCosts(clusterId: string, agentIndex: number): Promise<AgentCosts> {
    return this.request<AgentCosts>('GET', this.cluster('agent-costs', clusterId, { agentIndex }));
  }

  // ---- files ---------------------------------------------------------------

  /** Read one object. `key` is absolute (`environment/...`), as the flock wants it. */
  async readFile(key: string): Promise<string> {
    const r = await this.request<{ content?: string }>('GET', `/cluster/habitat/file?key=${encodeURIComponent(key)}`);
    return typeof r.content === 'string' ? r.content : '';
  }

  // ---- Phase 0 queue routes ------------------------------------------------

  async queueList(
    clusterId: string,
    opts: { prefix?: string; after?: string; limit?: number; inline?: boolean } = {},
  ): Promise<QueueListPage> {
    const r = await this.request<QueueListPage>(
      'GET',
      this.cluster('env-list', clusterId, {
        prefix: opts.prefix ?? '',
        after: opts.after,
        limit: opts.limit,
        inline: opts.inline ? 1 : undefined,
      }),
    );
    return { files: Array.isArray(r.files) ? r.files : [], next: r.next ?? null };
  }

  /** Every page of a listing, in key order. For catch-up and the files panel. */
  async queueListAll(clusterId: string, prefix: string, inline = false): Promise<QueueEntry[]> {
    const out: QueueEntry[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.queueList(clusterId, { prefix, after, limit: 1000, inline });
      out.push(...page.files);
      if (page.next === null) return out;
      after = page.next;
    }
  }

  async queuePut(clusterId: string, key: string, content: string, ifNoneMatch = false): Promise<void> {
    try {
      await this.request('PUT', this.cluster('env-put', clusterId), { key, content, ifNoneMatch });
    } catch (e) {
      if (e instanceof FlockApiError && e.status === 412) throw new QueueExistsError(key);
      throw e;
    }
  }

  async queueDelete(clusterId: string, keys: string[]): Promise<{ deleted: string[]; errors: { key: string; code: string; message: string }[] }> {
    if (keys.length === 0) return { deleted: [], errors: [] };
    const r = await this.request<{ deleted?: string[]; errors?: { key: string; code: string; message: string }[] }>(
      'POST',
      this.cluster('env-delete', clusterId),
      { keys },
    );
    return { deleted: r.deleted ?? [], errors: r.errors ?? [] };
  }

  /**
   * Whether this flock has the Phase 0 routes. A 404 from `env-list` on a
   * cluster that does exist means an older Lambda; a 404 on an unknown cluster
   * means nothing, so the probe lists a cluster known to be registered, or
   * falls back to a body-shape check when none is.
   */
  async hasQueueRoutes(knownClusterId?: string): Promise<boolean> {
    const id = knownClusterId ?? 'cluster_0';
    try {
      await this.queueList(id, { prefix: 'queue/', limit: 1 });
      return true;
    } catch (e) {
      if (!(e instanceof FlockApiError)) throw e;
      // The new route answers 404 {error:'cluster not found'} for an unknown id;
      // an old Lambda falls through to its generic "unknown action" answer.
      const err = (e.body as { error?: unknown } | undefined)?.error;
      if (e.status === 404 && err === 'cluster not found') return true;
      if (e.status === 404 || e.status === 400) return false;
      throw e;
    }
  }
}
