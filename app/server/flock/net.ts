/**
 * The one way this program talks to a flock.
 *
 * A remote loop means the server fetches URLs the operator typed. That is the
 * classic server-side request forgery shape, and the controls against it live
 * here and nowhere else: `https:` only, no credentials in the URL, every address
 * the hostname resolves to checked against the private, loopback, link-local and
 * metadata ranges *inside the lookup the socket uses* (so a DNS answer that
 * changes between a check and a connect changes nothing), no redirects followed,
 * a timeout, a response cap, and JSON or text only.
 *
 * Nothing in here logs a header or a body. An error carries the method, the
 * path and the status, which is enough to debug and too little to leak a token.
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';

export const FLOCK_TIMEOUT_MS = 15_000;
export const FLOCK_MAX_BODY = 5 * 1024 * 1024;

/**
 * Development only: `KIROFACTORY_INSECURE_FLOCK=1` lets the guard accept plain
 * `http://` to a loopback address, so the mock flock (`npm run mock-flock`) can
 * stand in for a real one. Nothing else is relaxed - a private address that is
 * not loopback is still refused - and the server prints a warning at start.
 * Never set this on a machine whose factory you care about.
 */
export const INSECURE_FLOCK = process.env.KIROFACTORY_INSECURE_FLOCK === '1';

export class FlockNetError extends Error {
  /** HTTP status when the server answered, 0 for a transport failure. */
  readonly status: number;
  /** Parsed JSON body when there was one, for callers that read `error`. */
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'FlockNetError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Validate a flock API URL as typed. Returns the parsed URL or throws with a
 * message fit to show the operator.
 */
export function assertSafeFlockUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('not a URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (INSECURE_FLOCK && url.protocol === 'http:' && isLoopback(host)) {
    if (url.username !== '' || url.password !== '') throw new Error('the flock URL must not carry credentials');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('the flock URL must use https');
  if (url.username !== '' || url.password !== '') throw new Error('the flock URL must not carry credentials');
  if (url.hash !== '') throw new Error('the flock URL must not have a fragment');
  if (url.port !== '' && url.port !== '443') throw new Error('the flock URL must use port 443');
  if (url.search !== '') throw new Error('the flock URL must not have a query string');
  if (net.isIP(host) !== 0 && isForbiddenAddress(host)) throw new Error('the flock URL points at a private address');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('the flock URL points at a local name');
  }
  return url;
}

/**
 * Whether an address must never be connected to from here. Loopback, RFC 1918,
 * link-local (which is where the EC2 metadata service lives), CGNAT, the
 * unspecified and broadcast addresses, multicast, and their IPv6 equivalents
 * including IPv4-mapped forms.
 */
export function isForbiddenAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) return forbiddenV4(address);
  if (kind === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms.
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return forbiddenV4(mapped[1]);
    const mappedHex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return forbiddenV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (lower.startsWith('2001:db8:')) return true; // documentation
    if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known
    return false;
  }
  return true;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function forbiddenV4(address: string): boolean {
  const parts = address.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link local, metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * A `lookup` for `https.request` that refuses forbidden answers.
 *
 * Checked here rather than before the request so the address the socket opens
 * is the address that was checked. `all: true` is honoured so happy-eyeballs
 * code paths see the same filter.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  const opts = { ...options, all: true };
  dns.lookup(hostname, opts, (err, addresses) => {
    if (err) return callback(err, []);
    const list = Array.isArray(addresses) ? addresses : [];
    const allowed = list.filter((a) => !isForbiddenAddress(a.address));
    if (allowed.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`${hostname} resolves only to private addresses`);
      e.code = 'EFORBIDDEN';
      return callback(e, []);
    }
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

export interface FlockRequestInit {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FlockResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed when the content type says JSON; undefined otherwise. */
  json?: unknown;
}

/** The function shape `FlockClient` and `CognitoAuth` are given, so tests can swap it. */
export type Fetcher = (url: URL, init?: FlockRequestInit) => Promise<FlockResponse>;

/**
 * One guarded HTTPS request. Resolves on any HTTP status; rejects with
 * `FlockNetError(status: 0)` on a transport problem, timeout, redirect, oversize
 * body or an unexpected content type.
 */
export const flockFetch: Fetcher = (url, init = {}) =>
  new Promise<FlockResponse>((resolve, reject) => {
    const insecureLoopback = INSECURE_FLOCK && url.protocol === 'http:' && isLoopback(url.hostname.replace(/^\[|\]$/g, ''));
    if (url.protocol !== 'https:' && !insecureLoopback) return reject(new FlockNetError('only https is allowed', 0));
    const method = init.method ?? 'GET';
    const body = init.body;
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain;q=0.9',
      ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      ...(init.headers ?? {}),
    };
    const transport = insecureLoopback ? http : https;
    const req = transport.request(
      url,
      {
        method,
        headers,
        ...(insecureLoopback ? {} : { lookup: guardedLookup as unknown as net.LookupFunction }),
        timeout: init.timeoutMs ?? FLOCK_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(new FlockNetError(`${method} ${url.pathname}: redirect refused`, 0));
        }
        const type = String(res.headers['content-type'] ?? '');
        const isJson = /\bjson\b/i.test(type);
        const isText = /^text\//i.test(type);
        if (type !== '' && !isJson && !isText) {
          res.resume();
          return reject(new FlockNetError(`${method} ${url.pathname}: unexpected content type`, 0));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > FLOCK_MAX_BODY) {
            req.destroy();
            reject(new FlockNetError(`${method} ${url.pathname}: response too large`, 0));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          if (isJson && text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              return reject(new FlockNetError(`${method} ${url.pathname}: malformed JSON`, 0));
            }
          }
          resolve({ status, headers: res.headers, text, json });
        });
        res.on('error', (e) => reject(new FlockNetError(`${method} ${url.pathname}: ${e.message}`, 0)));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => reject(new FlockNetError(`${method} ${url.pathname}: ${e.message}`, 0)));
    if (body !== undefined) req.write(body);
    req.end();
  });
