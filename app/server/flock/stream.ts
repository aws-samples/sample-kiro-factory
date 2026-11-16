/**
 * The ACP and console tail, shared.
 *
 * Every `agent-stream` call on the flock is one SSM or ECS Exec command on the
 * node, so two tabs polling the same pane should cost one. A five second cache
 * keyed by connection, cluster, agent, kind and session does that; the flock's
 * own UI polls every ten, so five is well inside what anyone would notice.
 * In-flight requests are shared too, so a burst collapses to one upstream call.
 */
import type { FlockClient, SessionListResult, StreamKind, StreamResult } from './client.ts';

const TTL_MS = 5000;

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

export class StreamProxy {
  private readonly streams = new Map<string, Entry<StreamResult>>();
  private readonly sessions = new Map<string, Entry<SessionListResult>>();
  /** Upstream calls made, for tests. */
  upstream = 0;

  stream(connectionId: string, client: FlockClient, clusterId: string, agentIndex: number, kind: StreamKind, sessionId?: string): Promise<StreamResult> {
    const key = `${connectionId}/${clusterId}/${agentIndex}/${kind}/${sessionId ?? ''}`;
    return this.cached(this.streams, key, () => client.agentStream(clusterId, agentIndex, kind, sessionId));
  }

  list(connectionId: string, client: FlockClient, clusterId: string, agentIndex: number): Promise<SessionListResult> {
    const key = `${connectionId}/${clusterId}/${agentIndex}`;
    return this.cached(this.sessions, key, () => client.acpSessions(clusterId, agentIndex));
  }

  private cached<T>(map: Map<string, Entry<T>>, key: string, fetch: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = map.get(key);
    if (hit !== undefined && now - hit.at < TTL_MS) return hit.value;
    this.upstream += 1;
    const value = fetch();
    map.set(key, { at: now, value });
    // A failed fetch is not worth caching: the next poll should try again.
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key);
    });
    if (map.size > 500) {
      for (const [k, e] of map) if (now - e.at >= TTL_MS) map.delete(k);
    }
    return value;
  }
}
