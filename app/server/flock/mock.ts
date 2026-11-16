/**
 * A flock that fits in one process, for developing and testing remote loops.
 *
 *   npm run mock-flock                       # listens on MOCK_FLOCK_PORT, default 19840
 *   KIROFACTORY_INSECURE_FLOCK=1 \
 *   KIROFACTORY_COGNITO_ENDPOINT=http://127.0.0.1:19840/cognito \
 *   npm run dev                              # the factory, pointed at it
 *
 * Then add a connection with API URL `http://127.0.0.1:19840/prod`, any
 * username, password `flock`. Everything below mirrors the real handler's
 * routes and answers closely enough for the client, the bridge, the lifecycle
 * and the UI to be exercised without AWS: `auth-config.json`, Cognito's
 * `InitiateAuth` (USER_PASSWORD_AUTH with password `flock`, and the
 * refresh flow), list, models, instance-types,
 * status, config, direction, start, stop, pause, resume, delete,
 * agent-stream, agent-costs, habitat/file, delete-env-folder, and the three
 * Phase 0 queue routes over a `Map`.
 *
 * Behaviour that matters to the factory is simulated: a started cluster goes
 * `starting` then `running` after `startDelayMs`; each fake agent, every
 * `agentTickMs`, takes one item from `queue/in/`, moves it to `queue/claimed/in/`
 * and writes a result to `queue/out/`; with `autopause` on, a cluster with
 * nothing to do for three ticks pauses itself with reason `autopause`.
 *
 * Switches, over `POST /mock/<name>` with a JSON body, for the recovery tests:
 *
 *   offline        {on: true|false}          every /cluster/* answers 503 while on
 *   token-life     {seconds: N}              id tokens issued from now on live N seconds
 *   refresh-dies   {on: true|false}          REFRESH_TOKEN_AUTH answers NotAuthorized
 *   cap            {concurrencyCap: N}
 *   no-queue-routes {on: true|false}         env-* answer 404 {error:'not found'} like an old Lambda
 *   agent-tick     {cluster: id}             run one agent pass now, regardless of timers
 *   produce        {cluster: id, count: N}   write N result items to queue/out/ directly
 *   counters                                 GET: per-route call counts and stop/start tallies
 *   reset                                    forget everything
 *
 * No real auth: the password is compared to a constant. The bearer tokens it
 * issues are JWT-shaped with a real `exp` so the factory's expiry logic runs
 * against them.
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number.parseInt(process.env.MOCK_FLOCK_PORT ?? '19840', 10);
/** Tests import this file and listen themselves; only the CLI run listens on PORT. */
const AUTO_LISTEN = process.env.MOCK_FLOCK_NO_LISTEN !== '1';
const PASSWORD = process.env.MOCK_FLOCK_PASSWORD ?? 'flock';
/** The authenticator code the mock accepts while the `mfa` switch is on. */
const MFA_CODE = '123456';
const CLUSTER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'paused';

interface Cluster {
  id: string;
  name: string;
  createdAt: string;
  state: State;
  stateReason: string | null;
  lastError: { code: string; message: string; at: string } | null;
  config: Record<string, unknown>;
  direction: string;
  iterations: number[];
  idleTicks: number;
  startedAt: number | null;
  stopCalls: number;
  startCalls: number;
  resumeCalls: number;
}

const clusters = new Map<string, Cluster>();
/** Absolute S3 keys to bodies. */
const objects = new Map<string, { body: string; lastModified: Date }>();
const counters = new Map<string, number>();
const switches = {
  offline: false,
  tokenLifeSeconds: 3600,
  refreshDies: false,
  /** When on, sign-in needs the authenticator code 123456, as the real pool needs a TOTP code. */
  mfa: false,
  concurrencyCap: 64,
  noQueueRoutes: false,
  startDelayMs: 1500,
  agentTickMs: 3000,
};

const MODELS = [
  { model_id: 'claude-sonnet-4.5', model_name: 'Claude Sonnet 4.5' },
  { model_id: 'claude-haiku-4.5', model_name: 'Claude Haiku 4.5' },
];

function count(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

function defaultConfig(): Record<string, unknown> {
  return {
    concurrency: 3,
    neighbourRadius: 1,
    computeType: 'ecs',
    instanceType: 't4g.medium',
    taskSize: 'medium',
    loopIntervalSeconds: 30,
    model: null,
    algorithm: 'amorphous',
    swarmK: 4,
    autopause: true,
    selfOptimizing: false,
    browserAutomation: false,
    trustDeploy: false,
  };
}

function ensure(id: string): Cluster {
  let c = clusters.get(id);
  if (c === undefined) {
    c = {
      id, name: id, createdAt: new Date().toISOString(), state: 'stopped', stateReason: null, lastError: null,
      config: defaultConfig(), direction: '', iterations: [], idleTicks: 0, startedAt: null,
      stopCalls: 0, startCalls: 0, resumeCalls: 0,
    };
    clusters.set(id, c);
  }
  return c;
}

function jwt(seconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, sub: 'mock' })).toString('base64url');
  return `${header}.${payload}.${randomBytes(8).toString('base64url')}`;
}

function validToken(auth: string | undefined): boolean {
  const m = /^Bearer (.+)$/.exec(auth ?? '');
  if (!m) return false;
  try {
    const payload = JSON.parse(Buffer.from(m[1].split('.')[1] ?? '', 'base64url').toString()) as { exp?: number };
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function validateConfig(cfg: Record<string, unknown>): string | null {
  const n = cfg.concurrency as number;
  if (!Number.isInteger(n) || n < 1) return 'concurrency must be a positive integer';
  if (n > switches.concurrencyCap) return `concurrency ${n} exceeds the configured cap of ${switches.concurrencyCap}`;
  if (!['amorphous', 'mesh', 'swarm', 'single'].includes(cfg.algorithm as string)) {
    return 'algorithm must be one of "amorphous", "mesh", "swarm", "single"';
  }
  const r = cfg.neighbourRadius as number;
  if (cfg.algorithm === 'amorphous' && (!Number.isInteger(r) || r < 0 || r > Math.floor(n / 2))) {
    return `neighbourRadius must be an integer between 0 and ${Math.floor(n / 2)} (concurrency / 2)`;
  }
  const k = cfg.swarmK as number;
  if (cfg.algorithm === 'swarm' && (!Number.isInteger(k) || k < 1 || k > n - 1)) {
    return `swarmK must be an integer between 1 and ${n - 1} (concurrency - 1)`;
  }
  const li = cfg.loopIntervalSeconds as number;
  if (!Number.isInteger(li) || li < 0 || li > 3600) return 'loopIntervalSeconds must be an integer between 0 and 3600';
  if (cfg.model !== null && cfg.model !== undefined && !MODELS.some((m) => m.model_id === cfg.model)) {
    return `model "${String(cfg.model)}" is not in the deployment model catalog`;
  }
  if (typeof cfg.autopause !== 'boolean') return 'autopause must be a boolean';
  return null;
}

function listKeys(prefix: string): string[] {
  return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
}

/** One agent pass for a cluster: each agent takes at most one item from in/. */
/** Where a cluster's folder is: nested under its deployment group when it has one, as the real flock does. */
function envOf(c: Cluster): string {
  const g = c.config.everforgeGroup;
  return typeof g === 'string' && g.length > 0 ? `environment/${g}/${c.id}/` : `environment/${c.id}/`;
}
function agentTick(c: Cluster): void {
  if (c.state !== 'running') return;
  const env = envOf(c);
  const inbox = listKeys(`${env}queue/in/`);
  const n = c.config.concurrency as number;
  while (c.iterations.length < n) c.iterations.push(0);
  let took = 0;
  for (let k = 0; k < n && took < inbox.length; k++) {
    const key = inbox[took++];
    const item = objects.get(key);
    if (item === undefined) continue;
    const name = key.slice(`${env}queue/in/`.length);
    objects.set(`${env}queue/claimed/in/${name}`, { body: item.body, lastModified: new Date() });
    objects.delete(key);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(item.body) as Record<string, unknown>;
    } catch {
      /* fine */
    }
    const stem = name.replace(/\.json$/, '');
    const result = {
      payload: { echoedFrom: parsed.id ?? stem, byAgent: `agent-${k}`, iteration: c.iterations[k] + 1, note: `mock result for ${stem}` },
    };
    objects.set(`${env}queue/out/${stem}--${k}.json`, { body: JSON.stringify(result), lastModified: new Date() });
    c.iterations[k] += 1;
    objects.set(`${c.id}/store/agent-${k}.ndjson`, {
      body: JSON.stringify({ ts: new Date().toISOString(), iteration: c.iterations[k], action: `processed ${stem}`, result: 'ok', next_intent: 'poll inbox' }),
      lastModified: new Date(),
    });
  }
  if (took === 0) {
    for (let k = 0; k < n; k++) c.iterations[k] += 1;
    c.idleTicks += 1;
    if (c.config.autopause === true && c.idleTicks >= 3) {
      c.state = 'paused';
      c.stateReason = 'autopause';
    }
  } else {
    c.idleTicks = 0;
  }
}

setInterval(() => {
  for (const c of clusters.values()) agentTick(c);
}, switches.agentTickMs).unref();

function status(c: Cluster): unknown {
  const n = c.config.concurrency as number;
  const agents = Array.from({ length: c.state === 'stopped' ? 0 : n }, (_, i) => ({
    agentId: `agent-${i}`,
    instanceId: c.state === 'stopped' ? null : `arn:aws:ecs:mock:task/${c.id}-${i}`,
    instanceState: c.state === 'stopped' ? 'terminated' : 'running',
    status: c.state === 'starting' ? 'starting' : c.state === 'paused' ? 'paused' : 'running',
    lastEntry: c.iterations[i] ? { ts: new Date().toISOString(), iteration: c.iterations[i], action: 'poll inbox', result: 'ok', next_intent: 'poll inbox' } : null,
    prevEntry: null,
    lastUpdatedTs: new Date().toISOString(),
    totalCredits: (c.iterations[i] ?? 0) * 0.37,
    infraCostUsd: c.startedAt ? ((Date.now() - c.startedAt) / 3_600_000) * 0.2 : null,
  }));
  return {
    lastBuilt: new Date().toISOString(),
    clusterState: c.state,
    paused: c.state === 'paused',
    lastError: c.lastError,
    stateReason: c.stateReason,
    clusterStartTime: c.startedAt ? new Date(c.startedAt).toISOString() : null,
    agents,
    config: c.config,
    totalCredits: agents.reduce((s, a) => s + a.totalCredits, 0),
    infraCostUsd: c.startedAt ? ((Date.now() - c.startedAt) / 3_600_000) * 0.2 * n : null,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function scopedRel(rel: string, requireQueue: boolean): string | null {
  if (rel.length > 512 || rel.startsWith('/') || rel.includes('//') || rel.includes('\\') || /[\u0000-\u001f\u007f]/.test(rel)) return null;
  if (rel.split('/').some((s) => s === '..')) return null;
  if (requireQueue && !rel.startsWith('queue/')) return null;
  return rel;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const method = req.method ?? 'GET';
  const body = method === 'GET' ? '' : await readBody(req);
  const path = url.pathname.replace(/^\/prod(?=\/|$)/, '');

  // ---- control --------------------------------------------------------------
  if (path.startsWith('/mock/')) {
    const name = path.slice('/mock/'.length);
    const arg = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    switch (name) {
      case 'offline': switches.offline = arg.on === true; return send(res, 200, { offline: switches.offline });
      case 'token-life': switches.tokenLifeSeconds = Number(arg.seconds) || 3600; return send(res, 200, switches);
      case 'refresh-dies': switches.refreshDies = arg.on === true; return send(res, 200, switches);
      case 'mfa': switches.mfa = arg.on === true; return send(res, 200, switches);
      case 'cap': switches.concurrencyCap = Number(arg.concurrencyCap) || 64; return send(res, 200, switches);
      case 'no-queue-routes': switches.noQueueRoutes = arg.on === true; return send(res, 200, switches);
      case 'agent-tick': {
        const c = clusters.get(String(arg.cluster));
        if (c) agentTick(c);
        return send(res, 200, { ok: !!c });
      }
      case 'produce': {
        const c = ensure(String(arg.cluster));
        const n = Number(arg.count) || 1;
        for (let i = 0; i < n; i++) {
          const id = `produced-${Date.now()}-${i}`;
          objects.set(`${envOf(c)}queue/out/${id}.json`, { body: JSON.stringify({ payload: { i } }), lastModified: new Date() });
        }
        return send(res, 200, { produced: n });
      }
      case 'counters':
        return send(res, 200, {
          calls: Object.fromEntries(counters),
          clusters: Object.fromEntries([...clusters.values()].map((c) => [c.id, { state: c.state, stopCalls: c.stopCalls, startCalls: c.startCalls, resumeCalls: c.resumeCalls }])),
          objects: objects.size,
        });
      case 'reset': clusters.clear(); objects.clear(); counters.clear(); return send(res, 200, { ok: true });
      default: return send(res, 404, { error: 'unknown switch' });
    }
  }

  // ---- discovery and Cognito ------------------------------------------------
  if (path === '/auth-config.json') {
    count('auth-config');
    return send(res, 200, {
      userPoolId: 'eu-central-1_MockPool',
      clientId: 'mockclientid',
      cognitoDomain: 'mock.auth.eu-central-1.amazoncognito.com',
      // Whatever address this was reached on, so a test on an ephemeral port
      // passes the factory's host check the same as the CLI run does.
      apiUrl: `http://${req.headers.host ?? `127.0.0.1:${PORT}`}/prod`,
    });
  }
  if ((path === '/cognito' || path === '/cognito/') && method === 'POST') {
    const target = String(req.headers['x-amz-target'] ?? '').split('.').pop();
    const payload = JSON.parse(body || '{}') as Record<string, unknown>;
    count(`cognito:${target}:${String(payload.AuthFlow ?? payload.ChallengeName ?? '')}`);
    if (target === 'InitiateAuth' && payload.AuthFlow === 'USER_PASSWORD_AUTH') {
      const p = payload.AuthParameters as Record<string, string>;
      if (p.PASSWORD !== PASSWORD) return send(res, 400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
      if (switches.mfa) return send(res, 200, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'mock-session', ChallengeParameters: {} });
      return send(res, 200, { AuthenticationResult: { IdToken: jwt(switches.tokenLifeSeconds), RefreshToken: `rt-${randomBytes(6).toString('hex')}`, TokenType: 'Bearer' } });
    }
    if (target === 'RespondToAuthChallenge' && payload.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      const r = payload.ChallengeResponses as Record<string, string>;
      if (payload.Session !== 'mock-session' || r.SOFTWARE_TOKEN_MFA_CODE !== MFA_CODE) {
        return send(res, 400, { __type: 'CodeMismatchException', message: 'Invalid code received for user' });
      }
      return send(res, 200, { AuthenticationResult: { IdToken: jwt(switches.tokenLifeSeconds), RefreshToken: `rt-${randomBytes(6).toString('hex')}`, TokenType: 'Bearer' } });
    }
    if (target === 'InitiateAuth' && payload.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      if (switches.refreshDies) return send(res, 400, { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' });
      return send(res, 200, { AuthenticationResult: { IdToken: jwt(switches.tokenLifeSeconds), TokenType: 'Bearer' } });
    }
    return send(res, 400, { __type: 'InvalidParameterException', message: 'unsupported' });
  }

  // ---- /cluster/* -----------------------------------------------------------
  const m = /^\/cluster\/(.+)$/.exec(path);
  if (!m) return send(res, 404, { error: 'not found' });
  if (!validToken(req.headers.authorization)) return send(res, 401, { message: 'Unauthorized' });
  if (switches.offline) return send(res, 503, { error: 'mock offline' });

  const segments = m[1].split('/').filter(Boolean);
  let action = segments[0] ?? '';
  let clusterId = segments[1] ?? 'cluster_0';
  if (segments[0] === 'habitat' && segments[1] === 'file') {
    action = 'habitat/file';
    clusterId = segments[2] ?? 'cluster_0';
  }
  count(`${method} ${action}`);
  const q = url.searchParams;

  if (method === 'GET' && action === 'list') {
    return send(res, 200, {
      clusters: [...clusters.values()].map((c) => ({
        id: c.id, name: c.name, algorithm: c.config.algorithm, createdAt: c.createdAt, state: c.state,
        totalCredits: c.iterations.reduce((s, i) => s + i, 0) * 0.37, infraCostUsd: c.startedAt ? 0.1 : null, lastError: c.lastError,
      })),
    });
  }
  if (method === 'GET' && action === 'models') return send(res, 200, { models: MODELS, default_model: 'claude-sonnet-4.5' });
  if (method === 'GET' && action === 'instance-types') return send(res, 200, { instanceTypes: [], vcpuQuota: 64, concurrencyCap: switches.concurrencyCap });
  if (method === 'POST' && action === 'delete-env-folder') {
    const folder = String((JSON.parse(body || '{}') as { folder?: unknown }).folder ?? '');
    if (!folder.startsWith('environment/') || !folder.endsWith('/')) return send(res, 400, { error: 'folder must be a path like environment/<name>/' });
    let deleted = 0;
    for (const k of listKeys(folder)) { objects.delete(k); deleted++; }
    return send(res, 200, { deleted, folder });
  }
  if (method === 'GET' && action === 'habitat/file') {
    const key = q.get('key') ?? '';
    if (!key.startsWith('environment/') || key.includes('..')) return send(res, 403, { error: 'forbidden' });
    const o = objects.get(key);
    if (!o) return send(res, 404, { error: 'not found' });
    return send(res, 200, { key, content: o.body });
  }

  if (!CLUSTER_ID_RE.test(clusterId)) return send(res, 400, { error: `cluster id "${clusterId}" is invalid` });

  // Phase 0 routes.
  if (action === 'env-list' || action === 'env-put' || action === 'env-delete') {
    if (switches.noQueueRoutes) return send(res, 404, { error: 'not found' });
    if (!clusters.has(clusterId)) return send(res, 404, { error: 'cluster not found' });
    const env = envOf(clusters.get(clusterId)!);
    if (method === 'GET' && action === 'env-list') {
      const rel = scopedRel(q.get('prefix') ?? '', false);
      if (rel === null) return send(res, 403, { error: 'bad prefix' });
      const limit = Math.min(1000, Math.max(1, Number.parseInt(q.get('limit') ?? '200', 10) || 200));
      const after = q.get('after');
      const inline = q.get('inline') === '1';
      const all = listKeys(env + rel).filter((k) => after === null || k > env + after);
      const page = all.slice(0, limit);
      let budget = 2 * 1024 * 1024;
      const files = page.map((k) => {
        const o = objects.get(k)!;
        const size = Buffer.byteLength(o.body);
        const entry: Record<string, unknown> = { key: k.slice(env.length), size, lastModified: o.lastModified.toISOString() };
        if (inline && size <= 16384 && size <= budget) { entry.content = o.body; budget -= size; }
        return entry;
      });
      return send(res, 200, { files, next: all.length > limit && files.length > 0 ? files[files.length - 1].key : null });
    }
    if (method === 'PUT' && action === 'env-put') {
      let p: { key?: unknown; content?: unknown; ifNoneMatch?: unknown };
      try { p = JSON.parse(body) as typeof p; } catch { return send(res, 400, { error: 'body must be JSON' }); }
      if (typeof p.key !== 'string' || typeof p.content !== 'string') return send(res, 400, { error: 'key and content must be strings' });
      if (Buffer.byteLength(p.content) > 262144) return send(res, 413, { error: 'content too large' });
      const rel = scopedRel(p.key, true);
      if (rel === null) return send(res, 403, { error: 'key must start with queue/' });
      if (p.ifNoneMatch === true && objects.has(env + rel)) return send(res, 412, { error: 'exists' });
      objects.set(env + rel, { body: p.content, lastModified: new Date() });
      return send(res, 200, { key: rel, etag: `"${randomBytes(8).toString('hex')}"` });
    }
    if (method === 'POST' && action === 'env-delete') {
      let p: { keys?: unknown };
      try { p = JSON.parse(body) as typeof p; } catch { return send(res, 400, { error: 'body must be JSON' }); }
      if (!Array.isArray(p.keys) || p.keys.length === 0 || p.keys.length > 100 || !p.keys.every((k) => typeof k === 'string')) {
        return send(res, 400, { error: 'keys must be 1..100 strings' });
      }
      const rels: string[] = [];
      for (const k of p.keys as string[]) {
        const rel = scopedRel(k, true);
        if (rel === null) return send(res, 403, { error: `${k}: key must start with queue/` });
        rels.push(rel);
      }
      for (const rel of rels) objects.delete(env + rel);
      return send(res, 200, { deleted: rels, errors: [] });
    }
  }

  // Reads on an unknown cluster answer defaults without registering it, as the
  // real handler does (state.json absent reads as stopped). Only writes register.
  const existing = clusters.get(clusterId);
  if (existing === undefined && (action === 'status' || action === 'config' || action === 'direction') && method === 'GET') {
    if (action === 'status') {
      return send(res, 200, { lastBuilt: null, agents: [], clusterState: 'stopped', clusterStartTime: null, paused: false, lastError: null, stateReason: null });
    }
    if (action === 'config') return send(res, 200, defaultConfig());
    return send(res, 200, { direction: '' });
  }
  const c = ensure(clusterId);
  switch (`${method} ${action}`) {
    case 'GET status': return send(res, 200, status(c));
    case 'GET config': return send(res, 200, c.config);
    case 'PUT config': {
      const patch = JSON.parse(body || '{}') as Record<string, unknown>;
      const merged = { ...c.config, ...patch };
      const err = validateConfig(merged);
      if (err) return send(res, 400, { error: err, ...(err.includes('catalog') ? { validModels: MODELS.map((x) => x.model_id) } : {}) });
      c.config = merged;
      return send(res, 200, merged);
    }
    case 'GET direction': return send(res, 200, { direction: c.direction });
    case 'PUT direction': {
      const { direction } = JSON.parse(body || '{}') as { direction?: unknown };
      if (typeof direction !== 'string') return send(res, 400, { error: 'direction must be a string' });
      c.direction = direction;
      return send(res, 200, { ok: true });
    }
    case 'POST start': {
      if (!c.direction.trim()) return send(res, 400, { error: `No direction set for cluster "${c.id}".` });
      if (c.state !== 'stopped') return send(res, 409, { error: `cluster is ${c.state}, stop it before starting again` });
      const err = validateConfig(c.config);
      if (err) return send(res, 400, { error: err });
      c.startCalls += 1;
      c.state = 'starting';
      c.stateReason = 'manual';
      c.lastError = null;
      c.idleTicks = 0;
      c.iterations = Array.from({ length: c.config.concurrency as number }, () => 0);
      c.startedAt = Date.now();
      setTimeout(() => { if (c.state === 'starting') { c.state = 'running'; c.stateReason = 'first-iteration'; } }, switches.startDelayMs).unref();
      return send(res, 200, { ok: true, state: 'starting' });
    }
    case 'POST stop': {
      c.stopCalls += 1;
      if (c.state === 'stopped') return send(res, 200, { ok: true, state: 'stopped' });
      c.state = 'stopping';
      setTimeout(() => { c.state = 'stopped'; c.stateReason = 'manual'; c.startedAt = null; }, 500).unref();
      return send(res, 200, { ok: true, state: 'stopping' });
    }
    case 'POST pause': {
      if (c.state !== 'running' && c.state !== 'starting') return send(res, 409, { error: `cluster is ${c.state}` });
      c.state = 'paused'; c.stateReason = 'manual';
      return send(res, 200, { ok: true });
    }
    case 'POST resume': {
      c.resumeCalls += 1;
      if (c.state !== 'paused') return send(res, 409, { error: 'cluster is not paused' });
      c.state = 'running'; c.stateReason = 'manual'; c.idleTicks = 0;
      return send(res, 200, { ok: true });
    }
    case 'DELETE delete': {
      if (c.state !== 'stopped') return send(res, 409, { error: `cluster is ${c.state}, stop it before deleting` });
      clusters.delete(c.id);
      return send(res, 200, { ok: true });
    }
    case 'GET agent-costs': {
      const i = Number(q.get('agentIndex') ?? '0');
      const n = c.iterations[i] ?? 0;
      return send(res, 200, {
        agentIndex: i,
        entries: Array.from({ length: n }, (_, k) => ({ ts: new Date().toISOString(), iteration: k + 1, sessionId: `sess-${k + 1}`, credits: 0.37, unmetered: false, totalCredits: (k + 1) * 0.37 })),
        totalCredits: n ? n * 0.37 : null,
      });
    }
    case 'GET agent-stream': {
      const i = Number(q.get('agentIndex') ?? '0');
      const kind = q.get('kind');
      if (c.state === 'stopped') return send(res, 200, { agentIndex: i, kind, content: null, unavailable: 'cluster is stopped', fetchedAt: new Date().toISOString() });
      const iter = c.iterations[i] ?? 0;
      if (kind === 'acp-list') {
        return send(res, 200, {
          agentIndex: i,
          sessions: Array.from({ length: iter }, (_, k) => ({ sessionId: `sess-${k + 1}`, iteration: k, exact: true, mtime: Math.floor(Date.now() / 1000) - (iter - k) * 60, sizeBytes: 2000 + k * 100, active: k === iter - 1 })),
          fetchedAt: new Date().toISOString(),
        });
      }
      if (kind === 'console') {
        return send(res, 200, { agentIndex: i, kind, content: `[mock console] agent-${i} iteration ${iter}\nkiro-cli acp running\n`, fetchedAt: new Date().toISOString() });
      }
      const sid = q.get('sessionId') ?? `sess-${iter}`;
      const md = `## Iteration ${sid === `sess-${iter}` ? iter : sid.replace('sess-', '')} (agent-${i})\n\n**User**\n\nYou are agent-${i} of cluster \`${c.id}\`. Read the direction and your inbox.\n\n**Assistant**\n\nListing \`/environment/${c.id}/queue/in/\`...\n\n\`\`\`json\n{"files": ${listKeys(`environment/${c.id}/queue/in/`).length}}\n\`\`\`\n\n- Took one item, moved it to \`claimed/in/\`.\n- Wrote the result to \`queue/out/\`.\n\n_Mock transcript. ${new Date().toISOString()}_\n`;
      return send(res, 200, { agentIndex: i, kind: 'acp', content: md, sessionId: sid, sessionStatus: 'active', sessionSizeBytes: md.length, fetchedAt: new Date().toISOString() });
    }
    default:
      return send(res, 404, { error: 'not found' });
  }
});

if (AUTO_LISTEN) server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `mock flock on http://127.0.0.1:${PORT}/prod\n` +
    `  run the factory with:\n` +
    `    KIROFACTORY_INSECURE_FLOCK=1 KIROFACTORY_COGNITO_ENDPOINT=http://127.0.0.1:${PORT}/cognito npm run dev\n` +
    `  add a connection: API URL http://127.0.0.1:${PORT}/prod, any username, password "${PASSWORD}"\n` +
    `  switches: POST /mock/{offline,token-life,refresh-dies,cap,no-queue-routes,agent-tick,produce,reset}; GET /mock/counters\n`,
  );
});

/** For tests: the switches and a fetcher that talks plain http to a listening mock. */
export const mockSwitches = switches;
export const mockClusters = clusters;
export const mockObjects = objects;
export const mockCounters = counters;
export { server, agentTick };
