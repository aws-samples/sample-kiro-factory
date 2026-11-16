import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CognitoAuth, MfaRequired, NotAuthorized, SecretStore, SignedOutError, decodeTokenExpiry } from './auth.ts';
import { cognitoClientOver } from './testing.ts';
import type { Fetcher, FlockResponse } from './net.ts';
import { ConnectionStore } from './connections.ts';

const SCRATCH = path.resolve(import.meta.dirname, '../../../.scratch-test');

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, sub: 'u' })).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

function reply(status: number, body: unknown): FlockResponse {
  const text = JSON.stringify(body);
  return { status, headers: { 'content-type': 'application/x-amz-json-1.1' }, text, json: body };
}

/** A fake Cognito that answers USER_PASSWORD_AUTH and refreshes. */
function fakeCognito(opts: { tokenLifeSeconds?: number; refreshDies?: boolean; password?: string; mfa?: string } = {}) {
  const calls: string[] = [];
  const life = opts.tokenLifeSeconds ?? 3600;
  const fetcher: Fetcher = async (_url, init) => {
    const target = (init?.headers?.['x-amz-target'] ?? '').split('.').pop() ?? '';
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    calls.push(`${target}:${(body.AuthFlow as string | undefined) ?? (body.ChallengeName as string | undefined) ?? ''}`);
    if (target === 'InitiateAuth' && body.AuthFlow === 'USER_PASSWORD_AUTH') {
      const p = body.AuthParameters as Record<string, string>;
      assert.ok(typeof p.USERNAME === 'string' && p.USERNAME.length > 0);
      if (opts.password !== undefined && p.PASSWORD !== opts.password) {
        return reply(400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
      }
      if (opts.mfa !== undefined) return reply(200, { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'sess-1', ChallengeParameters: {} });
      return reply(200, { AuthenticationResult: { IdToken: jwt(life), RefreshToken: 'rt-1' } });
    }
    if (target === 'RespondToAuthChallenge' && body.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      const r = body.ChallengeResponses as Record<string, string>;
      assert.equal(body.Session, 'sess-1');
      if (r.SOFTWARE_TOKEN_MFA_CODE !== opts.mfa) return reply(400, { __type: 'CodeMismatchException', message: 'Invalid code received for user' });
      return reply(200, { AuthenticationResult: { IdToken: jwt(life), RefreshToken: 'rt-1' } });
    }
    if (target === 'InitiateAuth' && body.AuthFlow === 'REFRESH_TOKEN_AUTH') {
      if (opts.refreshDies) return reply(400, { __type: 'com.amazonaws.cognito#NotAuthorizedException', message: 'Refresh Token has expired' });
      return reply(200, { AuthenticationResult: { IdToken: jwt(life) } });
    }
    return reply(400, { __type: 'InvalidParameterException', message: 'bad' });
  };
  return { fetcher, calls, client: cognitoClientOver(fetcher) };
}

const params = { region: 'eu-central-1', userPoolId: 'eu-central-1_AbCdEf', clientId: 'client1', username: 'operator' };

async function freshDir(name: string): Promise<string> {
  const dir = path.join(SCRATCH, name);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('decodeTokenExpiry reads base64url payloads', () => {
  const t = jwt(100);
  assert.ok(Math.abs(decodeTokenExpiry(t) - (Date.now() + 100_000)) < 2000);
  assert.equal(decodeTokenExpiry('garbage'), 0);
});

test('a wrong password is NotAuthorized and nothing is stored', async () => {
  const dir = await freshDir('auth-wrong');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito({ password: 'right' });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await assert.rejects(auth.signIn({ password: 'wrong' }), NotAuthorized);
  assert.equal(auth.state().signedIn, false);
  await assert.rejects(fsp.stat(secrets.file('fc-1')));
});

test('sign in stores the refresh token only, mode 0600 in a 0700 dir', async () => {
  const dir = await freshDir('auth-a');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito();
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await auth.signIn({ password: 'hunter2' });
  const file = secrets.file('fc-1');
  const raw = await fsp.readFile(file, 'utf8');
  assert.ok(raw.includes('rt-1'));
  assert.ok(!raw.includes('hunter2'));
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(auth.state().signedIn, true);
});

test('a secrets file from before passwords stopped being stored loses the password as soon as it is read', async () => {
  const dir = await freshDir('auth-b');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  await secrets.write('fc-1', { clientId: 'client1', refreshToken: 'rt-old', ...({ password: 'hunter2' } as object) });
  const fake = fakeCognito({ tokenLifeSeconds: 3600 });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await auth.load(); // no sign-in, no refresh: the read alone rewrites the file
  assert.equal(fake.calls.length, 0);
  const raw = await fsp.readFile(secrets.file('fc-1'), 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.ok(raw.includes('rt-old'));
});
test('a stale file for another client loses its password too, and keeps that client\'s refresh token', async () => {
  const dir = await freshDir('auth-c');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  await secrets.write('fc-1', { clientId: 'other-client', refreshToken: 'rt-other', ...({ password: 'hunter2' } as object) });
  const fake = fakeCognito({ tokenLifeSeconds: 3600 });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await auth.load();
  assert.equal(fake.calls.length, 0);
  assert.equal(auth.state().signedIn, false); // the other client's token is not adopted
  const raw = await fsp.readFile(secrets.file('fc-1'), 'utf8');
  assert.ok(!raw.includes('hunter2'));
  assert.ok(raw.includes('rt-other'));
  assert.ok(raw.includes('other-client'));
});
test('a pool that requires MFA: no code is MfaRequired, a wrong code is NotAuthorized, the right one signs in', async () => {
  const dir = await freshDir('auth-mfa');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito({ mfa: '123456' });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await assert.rejects(auth.signIn({ password: 'hunter2' }), MfaRequired);
  await assert.rejects(auth.signIn({ password: 'hunter2', mfaCode: '000000' }), NotAuthorized);
  assert.equal(auth.state().signedIn, false);
  await assert.rejects(fsp.stat(secrets.file('fc-1')));
  await auth.signIn({ password: 'hunter2', mfaCode: '123 456' });
  assert.equal(auth.state().signedIn, true);
  assert.deepEqual(fake.calls.slice(-2), ['InitiateAuth:USER_PASSWORD_AUTH', 'RespondToAuthChallenge:SOFTWARE_TOKEN_MFA']);
});

test('a dead refresh token means SignedOutError and state.signedIn false', async () => {
  const dir = await freshDir('auth-c');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito({ tokenLifeSeconds: 10, refreshDies: true });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await auth.signIn({ password: 'hunter2' });
  await assert.rejects(auth.idToken(), SignedOutError);
  assert.equal(auth.state().signedIn, false);
  // Secrets file is gone: nothing left worth keeping.
  await assert.rejects(fsp.stat(secrets.file('fc-1')));
});

test('concurrent callers share one refresh', async () => {
  const dir = await freshDir('auth-d');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito({ tokenLifeSeconds: 10 });
  const auth = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await auth.signIn({ password: 'hunter2' });
  const before = fake.calls.length;
  const [a, b, c] = await Promise.all([auth.idToken(), auth.idToken(), auth.idToken()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(fake.calls.length - before, 1);
});

test('a new CognitoAuth picks the refresh token up from disk', async () => {
  const dir = await freshDir('auth-e');
  const secrets = new SecretStore(path.join(dir, 'flock-secrets'));
  const fake = fakeCognito();
  const first = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await first.signIn({ password: 'hunter2' });
  const second = new CognitoAuth('fc-1', params, secrets, { client: fake.client });
  await second.load();
  assert.equal(second.state().signedIn, true);
  const t = await second.idToken();
  assert.ok(t.startsWith('eyJ'));
  assert.equal(fake.calls.filter((c) => c === 'InitiateAuth:REFRESH_TOKEN_AUTH').length, 1);
});

test('ConnectionStore adds, lists without secrets, keeps two connections apart, removes', async () => {
  const dir = await freshDir('conn-a');
  const fake = fakeCognito();
  const fetcher: Fetcher = async (url, init) => {
    if (url.pathname.endsWith('/auth-config.json')) {
      return { status: 200, headers: { 'content-type': 'application/json' }, text: '', json: { userPoolId: 'eu-central-1_AbCdEf', clientId: 'client1', apiUrl: 'https://flock.example.com/prod' } };
    }
    return fake.fetcher(url, init);
  };
  const store = new ConnectionStore(path.join(dir, 'flocks.json'), fetcher, { cognitoClient: fake.client });
  const a = await store.add({ apiUrl: 'https://flock.example.com/prod', username: 'operator', password: 'hunter2' });
  const b = await store.add({ apiUrl: 'https://flock.example.com/prod', username: 'other', password: 'x', name: 'Second' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.name, 'flock.example.com');
  assert.equal(b.name, 'Second');
  const list = await store.list();
  const text = JSON.stringify(list);
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('rt-1'));
  assert.ok(!text.includes('eyJ'));
  const onDisk = await fsp.readFile(path.join(dir, 'flocks.json'), 'utf8');
  assert.ok(!onDisk.includes('hunter2') && !onDisk.includes('rt-1'));
  assert.equal((await fsp.stat(path.join(dir, 'flocks.json'))).mode & 0o777, 0o600);
  const files = await fsp.readdir(path.join(dir, 'flock-secrets'));
  assert.equal(files.length, 2);

  await store.remove(a.id);
  assert.equal((await store.list()).length, 1);
  assert.equal((await fsp.readdir(path.join(dir, 'flock-secrets'))).length, 1);
});

test('ConnectionStore refuses bad URLs and wrong passwords without writing anything', async () => {
  const dir = await freshDir('conn-b');
  const fetcher: Fetcher = async (url) => {
    if (url.pathname.endsWith('/auth-config.json')) return { status: 404, headers: {}, text: '' };
    return reply(400, { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' });
  };
  const store = new ConnectionStore(path.join(dir, 'flocks.json'), fetcher, { cognitoClient: cognitoClientOver(fetcher) });
  await assert.rejects(store.add({ apiUrl: 'http://x', username: 'a', password: 'b' }), /https/);
  await assert.rejects(store.add({ apiUrl: 'https://flock.example.com/prod', username: 'a', password: 'b' }), /auth-config/);
  await assert.rejects(
    store.add({ apiUrl: 'https://flock.example.com/prod', username: 'a', password: 'b', userPoolId: 'eu-central-1_X', clientId: 'c1' }),
    /Incorrect username or password/,
  );
  await assert.rejects(fsp.stat(path.join(dir, 'flocks.json')));
});
