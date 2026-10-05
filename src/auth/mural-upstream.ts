// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash, randomBytes } from 'node:crypto';

/**
 * Mural as the upstream identity provider. The server is a confidential
 * client: Mural refuses a refresh without the client secret (#17), so the
 * secret stays here and never reaches an MCP client.
 */

const MURAL_API_BASE = 'https://app.mural.co/api/public/v1';
const MURAL_OAUTH_BASE = `${MURAL_API_BASE}/authorization/oauth2`;

/** What every tool needs, asked for at each sign-in. */
export const MURAL_SCOPES: readonly string[] = [
  'workspaces:read',
  'rooms:read',
  'rooms:write',
  'murals:read',
  'murals:write',
  'templates:read',
  'templates:write',
  'identity:read',
];

// A token request runs under the grant's refresh lock: bounded, so a stalled
// Mural cannot hold every /token call of that grant.
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
// Used only when Mural reports no lifetime at all; short, so it errs towards
// refreshing early.
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

export interface MuralUpstream {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MuralTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  /** Epoch ms. */
  readonly expiresAt: number;
  /** The scopes Mural granted, as it reported them; absent when it reported none. */
  readonly scopes?: readonly string[] | undefined;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: unknown;
  scope?: unknown;
}

export type UpstreamAuthError = Error & {
  readonly name: 'UpstreamAuthError';
  readonly status?: number;
};

/** ASCII-only (auth paths end up in headers); never carries the Mural body. */
const upstreamAuthError = (message: string, status?: number, cause?: unknown): UpstreamAuthError =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: 'UpstreamAuthError' as const,
    ...(status === undefined ? {} : { status }),
  });

export const isUpstreamAuthError = (err: unknown): err is UpstreamAuthError =>
  err instanceof Error && err.name === 'UpstreamAuthError';

/** A space-separated scope list, or `undefined` for anything else or an empty one. */
export const parseScopeList = (value: unknown): string[] | undefined => {
  if (typeof value !== 'string') return undefined;
  const scopes = value.split(' ').filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
};

export const generateCodeVerifier = (): string => randomBytes(32).toString('base64url');

export const generateCodeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const buildMuralAuthorizeUrl = (
  upstream: MuralUpstream,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string => {
  const url = new URL(MURAL_OAUTH_BASE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', upstream.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', MURAL_SCOPES.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
};

const expClaimMs = (token: string): number | undefined => {
  let exp: unknown;
  try {
    // Stryker disable next-line StringLiteral: any stand-in for a missing payload fails to parse alike.
    exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp;
  } catch {
    // Not a JWT.
  }
  return typeof exp === 'number' ? exp * 1000 : undefined;
};

// Mural answers expires_in (900 s). Without it, the token's own exp claim,
// then a short default (#14).
const expiresAtOf = (result: TokenResponse): number => {
  const expiresIn = Number(result.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000;
  return expClaimMs(result.access_token) ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
};

// Never replayed: a Mural code is single-use, and so may a refresh token be.
const requestTokens = async (
  upstream: MuralUpstream,
  grant: Record<string, string>,
  previousRefreshToken?: string,
): Promise<MuralTokenSet> => {
  let response: Response;
  try {
    response = await fetch(`${MURAL_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: upstream.clientId,
        client_secret: upstream.clientSecret,
        ...grant,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw upstreamAuthError('Mural token endpoint unreachable.', undefined, err);
  }
  if (!response.ok) {
    // Read to the end, not cancelled: that frees the connection too, and a
    // cancel never settles on a body MSW mocks.
    await response.text().catch(() => undefined);
    throw upstreamAuthError(
      `Mural refused the ${grant['grant_type']} grant (${response.status}).`,
      response.status,
    );
  }
  const result = (await response.json()) as TokenResponse;
  return {
    accessToken: result.access_token,
    // Mural may leave the refresh token out of a refresh answer: the previous
    // one then stays valid.
    refreshToken: result.refresh_token ?? previousRefreshToken,
    expiresAt: expiresAtOf(result),
    scopes: parseScopeList(result.scope),
  };
};

export const exchangeMuralCode = (
  upstream: MuralUpstream,
  params: { code: string; redirectUri: string; codeVerifier: string },
): Promise<MuralTokenSet> =>
  requestTokens(upstream, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

/** The caller must persist the returned set: Mural may rotate the refresh token. */
export const refreshMuralTokens = (
  upstream: MuralUpstream,
  refreshToken: string,
): Promise<MuralTokenSet> =>
  requestTokens(
    upstream,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    refreshToken,
  );

/** Mural is not OIDC: the account is whoever `/users/me` says the token belongs to. */
export const fetchMuralIdentity = async (accessToken: string): Promise<{ id: string }> => {
  const failure = (cause?: unknown) =>
    upstreamAuthError(
      'Could not resolve the Mural account of the signed-in user.',
      undefined,
      cause,
    );
  let body: { value?: { id?: unknown } };
  try {
    const response = await fetch(`${MURAL_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`users/me answered ${response.status}`);
    body = (await response.json()) as typeof body;
  } catch (err) {
    throw failure(err);
  }
  const id = body.value?.id;
  // An anonymous or malformed answer must never become an account id.
  if (typeof id !== 'string' || id.length === 0) throw failure();
  return { id };
};
