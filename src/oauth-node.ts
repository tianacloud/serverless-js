import { createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface OAuthConfig {
  managementOrigin: string | URL;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface TokenSnapshot {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
}
export class OAuthError extends Error {
  constructor(readonly status: number, readonly code: string, description?: string) {
    super(description ?? code);
    this.name = 'OAuthError';
  }
}
export function createAuthorizationURL(config: Omit<OAuthConfig, 'clientSecret'>) {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const url = new URL('/oauth/authorize', config.managementOrigin);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
    state, code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return {authorizeUrl: url.href, state, codeVerifier};
}
async function post(config: OAuthConfig, path: string, fields: Record<string, string>) {
  const digest = createHash('sha256').update(config.clientSecret, 'utf8').digest('hex');
  return fetch(new URL(path, config.managementOrigin), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: {Authorization: `Basic ${Buffer.from(`${config.clientId}:${digest}`, 'utf8').toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(fields),
  });
}
async function check(response: Response) {
  if (!response.ok) {
    const body = await response.json() as {error: string; error_description?: string};
    throw new OAuthError(response.status, body.error, body.error_description);
  }
}
async function token(config: OAuthConfig, fields: Record<string, string>): Promise<TokenSnapshot> {
  const started = Date.now();
  const response = await post(config, '/oauth/token', fields);
  await check(response);
  const body = await response.json() as {session_id: string; access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number};
  // An incomplete success cannot be persisted as a usable replacement session.
  if (!body.session_id || !body.access_token || !body.refresh_token || !(body.expires_in > 0) || !(body.refresh_expires_in > 0)) {
    throw new OAuthError(response.status, 'invalid_response');
  }
  return {sessionId: body.session_id, accessToken: body.access_token, refreshToken: body.refresh_token,
    expiresAt: started + body.expires_in * 1000, refreshExpiresAt: started + body.refresh_expires_in * 1000};
}
export function exchangeCode(config: OAuthConfig, input: {code: string; codeVerifier: string}) {
  return token(config, {grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: config.redirectUri});
}
export function refreshSession(config: OAuthConfig, refreshToken: string) {
  return token(config, {grant_type: 'refresh_token', refresh_token: refreshToken});
}
export async function revokeSession(config: OAuthConfig, refreshToken: string): Promise<void> {
  await check(await post(config, '/oauth/revoke', {token: refreshToken}));
}
