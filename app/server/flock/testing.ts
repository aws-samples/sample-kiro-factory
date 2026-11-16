/**
 * Shared test scaffolding: a mock flock on an ephemeral port, a plain-http
 * fetcher for it, and a signed-in session. Not imported by the server.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fetcher, FlockResponse } from './net.ts';
import { Readable } from 'node:stream';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoAuth, SecretStore, type CognitoClientLike } from './auth.ts';
import { FlockClient } from './client.ts';

process.env.MOCK_FLOCK_NO_LISTEN = '1';
const mock = await import('./mock.ts');

export interface MockFlock {
  base: string;
  fetcher: Fetcher;
  client: FlockClient;
  auth: CognitoAuth;
  /** Flip a switch or poke the mock. */
  control(name: string, body?: unknown): Promise<unknown>;
  counters(): Promise<{ calls: Record<string, number>; clusters: Record<string, { state: string; stopCalls: number; startCalls: number; resumeCalls: number }>; objects: number }>;
  close(): Promise<void>;
  switches: typeof mock.mockSwitches;
  objects: typeof mock.mockObjects;
  clusters: typeof mock.mockClusters;
  tick(clusterId: string): void;
}

/**
 * A Cognito SDK client whose HTTP goes through a `Fetcher`, so the fakes the
 * tests already have for Cognito's wire protocol keep working. `endpoint` is
 * what the SDK will address; the fetcher decides what answers.
 */
export function cognitoClientOver(fetcher: Fetcher, endpoint = 'https://cognito.test/'): CognitoClientLike {
  const handler = {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(req: { protocol: string; hostname: string; port?: number; path: string; query?: Record<string, unknown>; method: string; headers: Record<string, string>; body?: unknown }) {
      const url = new URL(`${req.protocol}//${req.hostname}${req.port ? `:${req.port}` : ''}${req.path}`);
      const body = typeof req.body === 'string' ? req.body : req.body === undefined ? undefined : Buffer.from(req.body as Uint8Array).toString('utf8');
      const res: FlockResponse = await fetcher(url, { method: req.method as 'POST', headers: req.headers, body });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
      if (headers['content-type'] === undefined) headers['content-type'] = 'application/x-amz-json-1.1';
      return { response: { statusCode: res.status, reason: '', headers, body: Readable.from([Buffer.from(res.text || JSON.stringify(res.json ?? {}))]) } };
    },
    updateHttpClientConfig(): void {},
    httpHandlerConfigs(): Record<string, never> { return {}; },
    destroy(): void {},
  };
  return new CognitoIdentityProviderClient({ region: 'eu-central-1', endpoint, requestHandler: handler as never });
}
/** A fetcher that speaks plain http to anything. Tests only. */
export const plainFetch: Fetcher = (url, init = {}) =>
  new Promise<FlockResponse>((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        if (/json/i.test(String(res.headers['content-type'] ?? '')) && text) {
          try { json = JSON.parse(text); } catch { /* leave undefined */ }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });

export async function startMockFlock(secretsDir: string): Promise<MockFlock> {
  mock.mockClusters.clear();
  mock.mockObjects.clear();
  mock.mockCounters.clear();
  mock.mockSwitches.offline = false;
  mock.mockSwitches.refreshDies = false;
  mock.mockSwitches.noQueueRoutes = false;
  mock.mockSwitches.tokenLifeSeconds = 3600;
  mock.mockSwitches.concurrencyCap = 64;
  mock.mockSwitches.startDelayMs = 50;

  const server = mock.server;
  if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/prod`;
  const auth = new CognitoAuth(
    'fc-test',
    { region: 'eu-central-1', userPoolId: 'eu-central-1_MockPool', clientId: 'mockclientid', username: 'tester' },
    new SecretStore(secretsDir),
    { endpoint: new URL(`http://127.0.0.1:${port}/cognito`) },
  );
  await auth.signIn({ password: 'flock' });
  const client = new FlockClient(base, auth, plainFetch);
  const control = async (name: string, body?: unknown) => {
    const r = await plainFetch(new URL(`http://127.0.0.1:${port}/mock/${name}`), { method: 'POST', body: JSON.stringify(body ?? {}) });
    return r.json;
  };
  return {
    base, fetcher: plainFetch, client, auth, control,
    counters: async () => (await plainFetch(new URL(`http://127.0.0.1:${port}/mock/counters`))).json as never,
    // Keep-alive sockets from a poll still in flight would hold `close` open
    // for as long as the poller kept polling; cut them.
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
    switches: mock.mockSwitches,
    objects: mock.mockObjects,
    clusters: mock.mockClusters,
    tick: (id: string) => {
      const c = mock.mockClusters.get(id);
      if (c) mock.agentTick(c);
    },
  };
}

/** Wait until `pred()` is true or `ms` passed. Tests only. */
export async function until(pred: () => boolean | Promise<boolean>, ms = 8000, step = 20): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}
