/**
 * A flock sign-in: Cognito tokens for one connection, and the file they rest in.
 *
 * Ported from the flock's own `kiro-flock-mcp/src/authManager.ts` with two
 * changes. The silent refresh calls Cognito's public `InitiateAuth` through the
 * AWS SDK rather than through `aws cognito-idp admin-initiate-auth`, so no AWS
 * profile is needed and no token is interpolated into a shell. And the cache is
 * keyed by connection and lives under `~/.kirofactory/flock-secrets/`.
 *
 * Sign-in is Cognito's `USER_PASSWORD_AUTH` flow followed by the
 * `SOFTWARE_TOKEN_MFA` challenge: `InitiateAuth` carries the password, and
 * `RespondToAuthChallenge` carries the authenticator code, both through
 * `@aws-sdk/client-cognito-identity-provider`. Nothing here speaks the Cognito
 * wire protocol itself. The flock's user pool requires TOTP for every user and
 * its app client enables the flow (`mfa: REQUIRED`, `authFlows.userPassword`
 * in its CDK stack); the authenticator is enrolled in the flock's own UI, which
 * is why an `MFA_SETUP` challenge is answered with "sign in there first".
 *
 * ## What the tokens are worth
 *
 * The id token is what API Gateway checks; it lasts 24 hours. The refresh token
 * lasts 7 days from sign-in, not from last use, so a factory that stays up for a
 * week will hit a dead refresh token on day eight. The session is then
 * `signedIn: false` and the loop's sync goes `signed-out` until the operator
 * signs in again. The cluster is never touched either way.
 *
 * The password is used once and dropped. It used to be possible to keep it on
 * disk so the factory could sign in again by itself after day seven; that was
 * removed because the local loops run with shell access as this user and could
 * read it, which made "remember password" a way for any loop to become the
 * operator on the flock.
 *
 * ## What never leaves this module
 *
 * Tokens stay in memory and in the 0600 secrets file. Nothing here returns a
 * token to a route that would send it to a browser; `state()` is the only shape
 * a route reads and it carries a boolean and an expiry.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
  type InitiateAuthCommandOutput,
  type RespondToAuthChallengeCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { INSECURE_FLOCK, FlockNetError } from './net.ts';

/** How much of the id token's life must remain for it to be handed out. */
const TOKEN_BUFFER_MS = 60_000;

export interface AuthState {
  signedIn: boolean;
  /** Epoch ms the current id token expires, when there is one. */
  expiresAt?: number;
}

export interface SignInInput {
  password: string;
  /** The six digits from the operator's authenticator app. Required by the flock's pool; ignored when no challenge comes. */
  mfaCode?: string;
}
export interface FlockAuth {
  /** A valid id token, refreshing or re-authenticating as the stored secrets allow. */
  idToken(): Promise<string>;
  signIn(input: SignInInput): Promise<void>;
  signOut(): Promise<void>;
  state(): AuthState;
}

/** Thrown when there is no way to get a token without the operator. */
export class SignedOutError extends Error {
  constructor(message = 'signed out') {
    super(message);
    this.name = 'SignedOutError';
  }
}

export interface CognitoParams {
  region: string;
  userPoolId: string;
  clientId: string;
  username: string;
}

interface SecretFile {
  refreshToken?: string;
  clientId?: string;
  savedAt?: string;
  /** Written by versions that offered "remember password". Never read; its presence triggers a rewrite. */
  password?: string;
}

/**
 * The secrets file for one connection: `<dir>/<connectionId>.json`, directory
 * 0700 and file 0600, written atomically and re-chmodded after every write so a
 * permissive umask cannot widen it.
 */
export class SecretStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  file(connectionId: string): string {
    return path.join(this.dir, `${connectionId}.json`);
  }

  async read(connectionId: string): Promise<SecretFile> {
    try {
      const raw = await fsp.readFile(this.file(connectionId), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as SecretFile) : {};
    } catch {
      return {};
    }
  }

  async write(connectionId: string, data: SecretFile): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700).catch(() => {});
    const file = this.file(connectionId);
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify({ ...data, savedAt: new Date().toISOString() }), { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, file);
  }

  async remove(connectionId: string): Promise<void> {
    await fsp.rm(this.file(connectionId), { force: true });
  }
}

/** Epoch ms a JWT expires, or 0 if it cannot be read. `base64url`, not `base64`. */
export function decodeTokenExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** The SDK client shape this class needs; tests hand in a stub. */
export type CognitoClientLike = Pick<CognitoIdentityProviderClient, 'send'>;
export class CognitoAuth implements FlockAuth {
  private idTokenValue: string | null = null;
  private expiresAt = 0;
  private refreshToken: string | null = null;
  private loaded = false;
  private inFlight: Promise<string> | null = null;
  private readonly client: CognitoClientLike;
  private readonly connectionId: string;
  private readonly params: CognitoParams;
  private readonly secrets: SecretStore;

  constructor(
    connectionId: string,
    params: CognitoParams,
    secrets: SecretStore,
    opts: { client?: CognitoClientLike; endpoint?: URL } = {},
  ) {
    this.connectionId = connectionId;
    this.params = params;
    this.secrets = secrets;
    // The SDK derives the endpoint from the validated region; nothing the flock
    // served is used. The one override is the environment variable the mock
    // flock asks for, and only while KIROFACTORY_INSECURE_FLOCK is on (see net.ts).
    const override = INSECURE_FLOCK ? process.env.KIROFACTORY_COGNITO_ENDPOINT : undefined;
    const endpoint = opts.endpoint ?? (override ? new URL(override) : undefined);
    this.client = opts.client ?? new CognitoIdentityProviderClient({
      region: params.region,
      ...(endpoint !== undefined ? { endpoint: endpoint.toString() } : {}),
    });
  }

  state(): AuthState {
    const signedIn = (this.idTokenValue !== null && this.expiresAt > Date.now()) || this.refreshToken !== null;
    return {
      signedIn,
      ...(this.idTokenValue !== null && this.expiresAt > 0 ? { expiresAt: this.expiresAt } : {}),
    };
  }

  /** Read the secrets file once. Called lazily so construction is synchronous. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const data = await this.secrets.read(this.connectionId);
    // Same guard as the original: a cache written for another client is noise.
    if (data.clientId !== undefined && data.clientId !== this.params.clientId) {
      // Noise, but a file from before passwords stopped being stored still
      // holds one; drop it now rather than keep it for a client nobody uses.
      if (data.password !== undefined) await this.purge(data);
      return;
    }
    if (typeof data.refreshToken === 'string' && data.refreshToken.length > 0) this.refreshToken = data.refreshToken;
    // A file from before passwords stopped being stored: rewrite it now with
    // only what this class knows about, rather than waiting for a write that a
    // connection nobody uses again would never make.
    if (data.password !== undefined) await this.persist();
  }

  /** Rewrite another client's stale file without its password field, or remove it when nothing else is in it. */
  private async purge(data: SecretFile): Promise<void> {
    if (typeof data.refreshToken === 'string' && data.refreshToken.length > 0 && data.clientId !== undefined) {
      await this.secrets.write(this.connectionId, { clientId: data.clientId, refreshToken: data.refreshToken });
      return;
    }
    await this.secrets.remove(this.connectionId);
  }

  async idToken(): Promise<string> {
    await this.load();
    if (this.idTokenValue !== null && this.expiresAt > Date.now() + TOKEN_BUFFER_MS) return this.idTokenValue;
    // Concurrent callers share one refresh: a status poll, a pump tick and a
    // stream fetch landing together should cost one round trip, not three.
    if (this.inFlight === null) {
      this.inFlight = this.renew().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async renew(): Promise<string> {
    if (this.refreshToken !== null) {
      try {
        await this.refresh(this.refreshToken);
        return this.idTokenValue as string;
      } catch (e) {
        if (!(e instanceof NotAuthorized)) throw e;
        this.refreshToken = null;
      }
    }
    // Nothing left to renew with. The id token, if any, is inside its last
    // minute; dropping it now makes `state()` tell the truth at once rather than
    // sixty seconds from now.
    this.idTokenValue = null;
    this.expiresAt = 0;
    await this.persist();
    throw new SignedOutError();
  }

  async signIn({ password, mfaCode }: SignInInput): Promise<void> {
    await this.load();
    await this.authenticate(password, mfaCode);
    await this.persist();
  }

  async signOut(): Promise<void> {
    this.idTokenValue = null;
    this.expiresAt = 0;
    this.refreshToken = null;
    this.loaded = true;
    await this.secrets.remove(this.connectionId);
  }

  /** Drop every stored secret, for when the connection itself goes. */
  async destroy(): Promise<void> {
    await this.signOut();
  }

  private async persist(): Promise<void> {
    if (this.refreshToken === null) {
      await this.secrets.remove(this.connectionId);
      return;
    }
    await this.secrets.write(this.connectionId, {
      clientId: this.params.clientId,
      refreshToken: this.refreshToken,
    });
  }

  private async send<T>(command: InitiateAuthCommand | RespondToAuthChallengeCommand): Promise<T> {
    try {
      return (await this.client.send(command as InitiateAuthCommand)) as T;
    } catch (e) {
      throw translate(e);
    }
  }
  private adopt(result: AuthenticationResultType | undefined): void {
    if (result?.IdToken === undefined) throw new FlockNetError('Cognito returned no id token', 0);
    this.idTokenValue = result.IdToken;
    this.expiresAt = decodeTokenExpiry(result.IdToken);
    if (typeof result.RefreshToken === 'string' && result.RefreshToken.length > 0) this.refreshToken = result.RefreshToken;
  }
  private async refresh(refreshToken: string): Promise<void> {
    const out = await this.send<InitiateAuthCommandOutput>(new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: this.params.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }));
    this.adopt(out.AuthenticationResult);
    await this.persist();
  }
  private async authenticate(password: string, mfaCode: string | undefined): Promise<void> {
    const first = await this.send<InitiateAuthCommandOutput>(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: this.params.clientId,
      AuthParameters: { USERNAME: this.params.username, PASSWORD: password },
    }));
    if (first.ChallengeName === undefined) {
      // A pool without MFA (an older flock). The code, if typed, is unused.
      this.adopt(first.AuthenticationResult);
      return;
    }
    if (first.ChallengeName !== 'SOFTWARE_TOKEN_MFA') {
      // NEW_PASSWORD_REQUIRED, MFA_SETUP, SMS_MFA and friends: the flock's own
      // UI handles those once, and the factory never asks for more than a
      // password and a code.
      const what = first.ChallengeName === 'NEW_PASSWORD_REQUIRED' ? 'a password change'
        : first.ChallengeName === 'MFA_SETUP' ? 'an authenticator app enrolled'
        : `the ${first.ChallengeName} challenge`;
      throw new FlockNetError(`this user needs ${what}; sign in to the flock dashboard once first`, 0);
    }
    const code = (mfaCode ?? '').replace(/\s+/g, '');
    if (!/^[0-9]{6,8}$/.test(code)) throw new MfaRequired();
    const second = await this.send<RespondToAuthChallengeCommandOutput>(new RespondToAuthChallengeCommand({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      ClientId: this.params.clientId,
      Session: first.Session,
      ChallengeResponses: { USERNAME: this.params.username, SOFTWARE_TOKEN_MFA_CODE: code },
    }));
    if (second.ChallengeName !== undefined) {
      throw new FlockNetError(`Cognito asked for ${second.ChallengeName} after the authenticator code; sign in to the flock dashboard once first`, 0);
    }
    this.adopt(second.AuthenticationResult);
  }
}
/** The SDK's typed errors, folded into the two shapes callers distinguish. */
function translate(e: unknown): Error {
  const name = (e as { name?: string }).name ?? '';
  const message = (e as { message?: string }).message ?? 'Cognito request failed';
  const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
  if (name === 'NotAuthorizedException' || name === 'UserNotFoundException') return new NotAuthorized(message);
  if (name === 'CodeMismatchException' || name === 'ExpiredCodeException') return new NotAuthorized('the authenticator code was wrong or has expired');
  if (name === 'PasswordResetRequiredException') return new NotAuthorized('this user must reset the password in the flock UI first');
  if (name === 'InvalidParameterException' && /USER_PASSWORD_AUTH/.test(message)) {
    return new FlockNetError(
      'this flock\'s app client does not allow USER_PASSWORD_AUTH; re-run the flock\'s install.sh (it enables the flow), then sign in again',
      status,
    );
  }
  if (e instanceof Error && !(e as { $metadata?: unknown }).$metadata) return e;
  return new FlockNetError(`${name || 'Cognito'}: ${message}`, status);
}
/** The pool wants an authenticator code and none (or no usable one) was given. */
export class MfaRequired extends Error {
  constructor() {
    super('this flock requires the six-digit code from your authenticator app');
    this.name = 'MfaRequired';
  }
}
/** Cognito said no: bad password, expired or revoked refresh token. */
export class NotAuthorized extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAuthorized';
  }
}
