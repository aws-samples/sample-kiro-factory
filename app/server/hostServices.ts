/**
 * What kiro-cli's agent runtime asks its host for, and the factory's answers.
 *
 * `kiro-cli --v3 acp` is a thin launcher around KAS, and KAS treats the ACP
 * client that started it as the host machine: it does not keep secrets or open
 * browsers itself, it asks the client to, over two extension capabilities that
 * the client must advertise under `clientCapabilities._meta.kiro`:
 *
 *   secretStorage    -> `_kiro/secret/get`, `_kiro/secret/store`, `_kiro/secret/delete`
 *   openExternalUrl  -> `_kiro/openExternalUrl`
 *
 * They matter for one thing here: remote MCP servers behind OAuth (`"type":
 * "http"` in mcp.json). The OAuth client for those is KAS, and the token it
 * obtains lives wherever the host puts it. `kiro-cli chat` answers these
 * requests and keeps the tokens in `~/.kiro/secrets.json`, which is why a server
 * such as Super Loop works in an interactive session. A client that advertises
 * neither - which this one did not, for its first few months - leaves KAS with no
 * store to read from and no way to ask the operator to sign in, so every turn
 * connected to the server with no token, got a 401, and logged "Unauthorized"
 * while the stdio servers next to it worked fine. The loop then reported the
 * tools as missing, and the operator, who could see them in `kiro-cli chat`,
 * could not see why.
 *
 * The fix is to answer the same requests against the same file, in the same
 * shape, so one sign-in in `kiro-cli chat` serves every loop, and a refresh done
 * by a loop is seen by the next chat. The file is a flat object of key to
 * string; KAS keys are `kiro.mcp.<sha256 of url|headers>.{tokens,client,...}`
 * and the values are JSON it wrote and parses itself. This module does not look
 * inside them.
 *
 * Concurrency: kiro-cli and however many loops are running all rewrite the same
 * small file without a lock. Each write here is read-modify-write of the whole
 * file, so the worst case is one lost refresh that the next connect repeats; the
 * tokens are long-lived and the writes rare. A lock would be more than the
 * problem is worth.
 *
 * Opening a URL: KAS only asks when a token is being refreshed mid-session or
 * the operator re-authenticates explicitly - a server with no token at all is
 * connected "passively" and never opens a browser, so a loop cannot do the first
 * sign-in. That stays a one-time step in `kiro-cli chat`. What this gives a loop
 * is the ability to recover from an expired session the same way the chat does,
 * which on an unattended machine means a browser tab appears; the operator
 * finishes it and the token is saved for everyone.
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where kiro-cli keeps the secrets its host stores for KAS. */
export const SECRETS_FILE = path.join(os.homedir(), '.kiro', 'secrets.json');

type SecretMap = Record<string, string>;

async function readSecrets(): Promise<SecretMap> {
  let raw: string;
  try {
    raw = await fsp.readFile(SECRETS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${SECRETS_FILE} is not a JSON object`);
  }
  const out: SecretMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function writeSecrets(map: SecretMap): Promise<void> {
  await fsp.mkdir(path.dirname(SECRETS_FILE), { recursive: true });
  // Write beside, then rename: a reader never sees a half-written file, and a
  // crash mid-write leaves the previous contents rather than none.
  const tmp = `${SECRETS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, SECRETS_FILE);
}

/**
 * One secret-store operation at a time per process. Two MCP servers connecting
 * at once each store a token; without this the second read-modify-write would
 * start from the file as it was before the first one landed.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialised<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

export const secretStore = {
  async get(key: string): Promise<string | undefined> {
    return serialised(async () => (await readSecrets())[key]);
  },
  async store(key: string, value: string): Promise<void> {
    await serialised(async () => {
      const map = await readSecrets();
      map[key] = value;
      await writeSecrets(map);
    });
  },
  async delete(key: string): Promise<void> {
    await serialised(async () => {
      const map = await readSecrets();
      if (!(key in map)) return;
      delete map[key];
      await writeSecrets(map);
    });
  },
};

/**
 * Hand a URL to the desktop. Only http(s): KAS already refuses other schemes
 * before asking, and the check is cheap to repeat on the side that runs a
 * command. The argument is passed as its own argv entry, never through a shell.
 */
export function openExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing to open: not a URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`refusing to open ${parsed.protocol} URL`);
  }
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [parsed.href]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', parsed.href]]
        : ['xdg-open', [parsed.href]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  // A missing opener must not take the turn down with it; the URL is in the
  // KAS log for the operator to use by hand.
  child.on('error', () => undefined);
  child.unref();
}

/**
 * The capability block to send in `initialize`. Kept in one place so the two
 * ACP clients in this app (turns and the model probe) advertise the same thing.
 */
export const KIRO_CLIENT_CAPABILITIES = {
  _meta: { kiro: { secretStorage: true, openExternalUrl: true } },
} as const;

/** Params KAS sends for `_kiro/openExternalUrl`: a bare string in one code path, `{ url }` in another. */
export function urlOf(params: unknown): string {
  if (typeof params === 'string') return params;
  if (params !== null && typeof params === 'object' && typeof (params as { url?: unknown }).url === 'string') {
    return (params as { url: string }).url;
  }
  throw new Error('openExternalUrl: no url in params');
}

/** Params for `_kiro/secret/*`. */
export function secretParams(params: unknown): { key: string; value?: string } {
  if (params === null || typeof params !== 'object') throw new Error('secret: params must be an object');
  const { key, value } = params as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || key.length === 0) throw new Error('secret: key must be a non-empty string');
  if (value !== undefined && typeof value !== 'string') throw new Error('secret: value must be a string');
  return { key, value };
}

/**
 * KAS connects MCP servers in the background after `session/new` and does not
 * hold `session/prompt` for them. An interactive user types slower than a
 * stdio server starts, so nobody notices; a loop sends its prompt a few
 * milliseconds after the session opens, and the model's tool list is frozen at
 * that instant. A remote server behind OAuth needs two to three seconds of
 * discovery and token exchange, so it connected fine - and after the turn had
 * already decided it did not exist.
 *
 * KAS reports progress as `_kiro/mcp/status` notifications carrying every
 * server's status. This tracks the latest one and lets a turn wait until none is
 * still `connecting`, with a cap so a server that hangs costs seconds rather than
 * the turn.
 */
export interface McpServerStatus {
  name: string;
  status: string;
}

export class McpReadiness {
  private servers: McpServerStatus[] | undefined;
  private waiters: Array<() => void> = [];

  /** Feed one `_kiro/mcp/status` notification. */
  update(params: unknown): void {
    const list = (params as { servers?: unknown })?.servers;
    if (!Array.isArray(list)) return;
    this.servers = list.flatMap((s) => {
      const { name, status } = (s ?? {}) as { name?: unknown; status?: unknown };
      return typeof name === 'string' && typeof status === 'string' ? [{ name, status }] : [];
    });
    if (this.settled()) {
      const w = this.waiters;
      this.waiters = [];
      for (const resolve of w) resolve();
    }
  }

  /** True once a status has arrived and nothing in it is still connecting. */
  settled(): boolean {
    return this.servers !== undefined && !this.servers.some((s) => s.status === 'connecting');
  }

  /** The names still connecting, for the note when the wait gives up. */
  pending(): string[] {
    return (this.servers ?? []).filter((s) => s.status === 'connecting').map((s) => s.name);
  }

  /**
   * Resolve when settled or after `maxMs`, whichever is first. Returns whether
   * it settled. No status at all within the cap also returns false: a session
   * with no MCP servers configured sends one notification with an empty list,
   * so silence means the agent is not talking, not that there is nothing to wait for.
   */
  wait(maxMs: number): Promise<boolean> {
    if (this.settled()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, maxMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(done);
    });
  }
}

/** How long a turn holds its prompt for MCP servers still connecting. */
export const MCP_READY_MAX_MS = 30_000;
