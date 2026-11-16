/**
 * The flocks this installation knows: `~/.kirofactory/flocks.json`.
 *
 * Per user, beside the factory registry, because a connection is a credential
 * holder and a credential is the operator's, not a project's. A document only
 * ever names a connection by id. Several connections may exist at once, and one
 * factory may have loops on different ones.
 *
 * Ids are random (`fc-` plus six base36 characters), never derived from the URL:
 * the same flock added twice with two users is two connections with two
 * sessions and two secret files, and nothing here collapses them.
 *
 * No secret is in this file. Tokens and the optional password live in
 * `flock-secrets/<id>.json` under `SecretStore`, and `view()` is the only shape a
 * route hands to the browser.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CognitoAuth, SecretStore, type AuthState, type CognitoClientLike, type SignInInput } from './auth.ts';
import { assertSafeFlockUrl, flockFetch, type Fetcher } from './net.ts';

const FORMAT = 1;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const POOL_RE = /^([a-z]{2}(?:-[a-z]+)+-\d)_[A-Za-z0-9]+$/;

export interface FlockConnection {
  id: string;
  name: string;
  auth: 'cognito';
  /** The API root, no trailing slash. `/cluster/*` and `/auth-config.json` hang off it. */
  apiUrl: string;
  region: string;
  userPoolId: string;
  clientId: string;
  username: string;
  /** Whether the flock answered the Phase 0 capability probe when last checked. */
  queueRoutes?: boolean;
}

/** What a route may send to the browser. No token, no refresh token, no password. */
export interface FlockConnectionView {
  id: string;
  name: string;
  apiUrl: string;
  username: string;
  signedIn: boolean;
  expiresAt?: number;
  queueRoutes?: boolean;
}

export interface AddConnectionInput {
  apiUrl: string;
  username: string;
  password: string;
  /** Authenticator code; the flock's user pool requires one. */
  mfaCode?: string;
  name?: string;
  /** Hand-entered when `auth-config.json` is missing or incomplete. */
  userPoolId?: string;
  clientId?: string;
}

export class ConnectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
  }
}

export class ConnectionStore {
  private connections: FlockConnection[] = [];
  private readonly sessions = new Map<string, CognitoAuth>();
  private readonly secrets: SecretStore;
  private readonly file: string;
  private readonly fetcher: Fetcher;
  private readonly cognitoEndpoint: URL | undefined;
  private readonly cognitoClient: CognitoClientLike | undefined;
  private loaded = false;

  constructor(file: string, fetcher: Fetcher = flockFetch, opts: { cognitoEndpoint?: URL; cognitoClient?: CognitoClientLike } = {}) {
    this.file = file;
    this.fetcher = fetcher;
    this.cognitoEndpoint = opts.cognitoEndpoint;
    this.cognitoClient = opts.cognitoClient;
    this.secrets = new SecretStore(path.join(path.dirname(file), 'flock-secrets'));
  }

  private newAuth(id: string, c: FlockConnection): CognitoAuth {
    return new CognitoAuth(id, c, this.secrets, {
      ...(this.cognitoClient !== undefined ? { client: this.cognitoClient } : {}),
      ...(this.cognitoEndpoint !== undefined ? { endpoint: this.cognitoEndpoint } : {}),
    });
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as { connections?: unknown };
      const list = Array.isArray(raw.connections) ? raw.connections : [];
      this.connections = list.filter(isConnection);
    } catch {
      this.connections = [];
    }
  }

  private async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, `${JSON.stringify({ format: FORMAT, connections: this.connections }, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, this.file);
  }

  async list(): Promise<FlockConnectionView[]> {
    await this.load();
    const out: FlockConnectionView[] = [];
    for (const c of this.connections) out.push(await this.view(c));
    return out;
  }

  async get(id: string): Promise<FlockConnection | undefined> {
    await this.load();
    return this.connections.find((c) => c.id === id);
  }

  /**
   * The connection as already loaded, with its session's sign-in state, or
   * nothing before `load()` ran. For the synchronous status paths: a remote
   * loop that is not being driven still has a cluster id and a flock to link
   * to, and the status frame is built without awaiting anything.
   */
  peek(id: string): { connection: FlockConnection; signedIn: boolean } | undefined {
    const connection = this.connections.find((c) => c.id === id);
    if (connection === undefined) return undefined;
    return { connection, signedIn: this.sessions.get(id)?.state().signedIn ?? false };
  }

  /** The session for a connection, created on first use. */
  async session(id: string): Promise<CognitoAuth> {
    await this.load();
    const c = this.connections.find((x) => x.id === id);
    if (c === undefined) throw new ConnectionError(`connection ${id} not found`, 404);
    let s = this.sessions.get(id);
    if (s === undefined) {
      s = this.newAuth(id, c);
      this.sessions.set(id, s);
    }
    return s;
  }

  async view(c: FlockConnection): Promise<FlockConnectionView> {
    const s = await this.session(c.id);
    await s.load();
    const st: AuthState = s.state();
    return {
      id: c.id,
      name: c.name,
      apiUrl: c.apiUrl,
      username: c.username,
      signedIn: st.signedIn,
      ...(st.expiresAt !== undefined ? { expiresAt: st.expiresAt } : {}),
      ...(c.queueRoutes !== undefined ? { queueRoutes: c.queueRoutes } : {}),
    };
  }

  /**
   * Read `<apiUrl>/auth-config.json`, which the flock's `install.sh` writes with
   * `{userPoolId, clientId, cognitoDomain, apiUrl}`. The host inside must match
   * the host typed, or the file is lying about where it came from.
   */
  async discover(apiUrl: URL): Promise<{ userPoolId?: string; clientId?: string }> {
    const res = await this.fetcher(new URL(`${apiUrl.origin}${apiUrl.pathname.replace(/\/+$/, '')}/auth-config.json`));
    if (res.status !== 200 || typeof res.json !== 'object' || res.json === null) return {};
    const cfg = res.json as Record<string, unknown>;
    if (typeof cfg.apiUrl === 'string') {
      try {
        if (new URL(cfg.apiUrl).host !== apiUrl.host) return {};
      } catch {
        return {};
      }
    }
    return {
      ...(typeof cfg.userPoolId === 'string' ? { userPoolId: cfg.userPoolId } : {}),
      ...(typeof cfg.clientId === 'string' ? { clientId: cfg.clientId } : {}),
    };
  }

  /**
   * Add a connection: validate the URL, discover the pool, sign in once, and
   * only then write it. A sign-in that fails leaves nothing behind.
   */
  async add(input: AddConnectionInput): Promise<FlockConnectionView> {
    await this.load();
    let url: URL;
    try {
      url = assertSafeFlockUrl(input.apiUrl);
    } catch (e) {
      throw new ConnectionError((e as Error).message);
    }
    const username = input.username.trim();
    if (username.length === 0) throw new ConnectionError('username is required');
    if (typeof input.password !== 'string' || input.password.length === 0) throw new ConnectionError('password is required');

    const found = await this.discover(url);
    const userPoolId = (input.userPoolId ?? found.userPoolId ?? '').trim();
    const clientId = (input.clientId ?? found.clientId ?? '').trim();
    const pool = POOL_RE.exec(userPoolId);
    if (pool === null) {
      throw new ConnectionError(
        found.userPoolId === undefined
          ? 'this flock did not publish auth-config.json; enter the user pool id and client id by hand'
          : `user pool id ${JSON.stringify(userPoolId)} is not of the form <region>_<id>`,
      );
    }
    if (!/^[a-z0-9]+$/.test(clientId)) throw new ConnectionError('client id is required');
    const region = pool[1];
    if (!REGION_RE.test(region)) throw new ConnectionError(`region ${region} is not valid`);

    const id = freshId(new Set(this.connections.map((c) => c.id)));
    const connection: FlockConnection = {
      id,
      name: (input.name ?? '').trim() || url.host,
      auth: 'cognito',
      apiUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
      region,
      userPoolId,
      clientId,
      username,
    };

    const session = this.newAuth(id, connection);
    try {
      await session.signIn({ password: input.password, ...(input.mfaCode !== undefined ? { mfaCode: input.mfaCode } : {}) });
    } catch (e) {
      await session.destroy().catch(() => {});
      throw new ConnectionError(`sign-in failed: ${(e as Error).message}`, 401);
    }

    this.connections.push(connection);
    this.sessions.set(id, session);
    await this.save();
    return this.view(connection);
  }

  async signIn(id: string, input: SignInInput): Promise<FlockConnectionView> {
    const c = await this.get(id);
    if (c === undefined) throw new ConnectionError(`connection ${id} not found`, 404);
    const s = await this.session(id);
    try {
      await s.signIn(input);
    } catch (e) {
      throw new ConnectionError(`sign-in failed: ${(e as Error).message}`, 401);
    }
    return this.view(c);
  }

  async signOut(id: string): Promise<FlockConnectionView> {
    const c = await this.get(id);
    if (c === undefined) throw new ConnectionError(`connection ${id} not found`, 404);
    await (await this.session(id)).signOut();
    return this.view(c);
  }

  /** Record what the capability probe found, so the UI can say "needs flock update". */
  async setQueueRoutes(id: string, ok: boolean): Promise<void> {
    const c = await this.get(id);
    if (c === undefined || c.queueRoutes === ok) return;
    c.queueRoutes = ok;
    await this.save();
  }

  async rename(id: string, name: string): Promise<FlockConnectionView> {
    const c = await this.get(id);
    if (c === undefined) throw new ConnectionError(`connection ${id} not found`, 404);
    const trimmed = name.trim();
    if (trimmed.length > 0) c.name = trimmed;
    await this.save();
    return this.view(c);
  }

  /** Remove the connection and its secrets. The caller checks no loop uses it. */
  async remove(id: string): Promise<void> {
    await this.load();
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx === -1) throw new ConnectionError(`connection ${id} not found`, 404);
    const s = this.sessions.get(id);
    if (s !== undefined) await s.destroy();
    else await this.secrets.remove(id);
    this.sessions.delete(id);
    this.connections.splice(idx, 1);
    await this.save();
  }
}

function freshId(taken: Set<string>): string {
  for (;;) {
    const id = `fc-${randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(-6)}`;
    if (!taken.has(id)) return id;
  }
}

function isConnection(v: unknown): v is FlockConnection {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' && /^fc-[a-z0-9]+$/.test(c.id) &&
    typeof c.name === 'string' &&
    c.auth === 'cognito' &&
    typeof c.apiUrl === 'string' &&
    typeof c.region === 'string' && REGION_RE.test(c.region) &&
    typeof c.userPoolId === 'string' &&
    typeof c.clientId === 'string' &&
    typeof c.username === 'string'
  );
}
