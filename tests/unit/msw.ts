// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash } from 'node:crypto';
import { HttpResponse, http, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * MSW for the tests that drive real HTTP: a file that needs it calls
 * `useMsw()` at its top level. Any request no handler answers fails the test,
 * so nothing ever reaches the real Mural.
 */
export const mswServer = setupServer();

export const useMsw = (): void => {
  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());
};

/** Lets requests to a local test server through. */
export const localServerPassthrough = http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough());

export const MURAL_CLIENT = { clientId: 'mural-client-id', clientSecret: 'mural-client-secret' };
export const MURAL_USER_ID = 'user-1234567890abcdefghijk';
const API = 'https://app.mural.co/api/public/v1';
const AUTHORIZE = `${API}/authorization/oauth2`;

export interface MuralOAuthMockOptions {
  accessTtlSeconds?: number;
  /** The `scopes` of the callback: by default the scopes asked for, as Mural does; `null` leaves it out. */
  grantedScopes?: string | null;
  /** A standard `scope` in the token answer, which Mural does not send. */
  tokenScope?: string;
}

/**
 * A stateful Mural OAuth upstream: codes and refresh tokens are single-use and
 * a refresh rotates, the client secret is required, and `/users/me` and
 * `/workspaces` answer only for a live access token. Opt in with
 * `mswServer.use(...mock.handlers)`.
 */
export const createMuralOAuthMock = (options: MuralOAuthMockOptions = {}) => {
  const accessTtl = options.accessTtlSeconds ?? 900;
  let serial = 0;
  const codes = new Map<string, { redirectUri: string; challenge: string }>();
  const access = new Map<string, number>();
  const refresh = new Set<string>();
  const state = {
    codeExchanges: 0,
    refreshes: 0,
    refreshFailures: 0,
    tokenRequests: [] as URLSearchParams[],
    apiCalls: [] as string[],
  };
  const issue = () => {
    serial += 1;
    const accessToken = `mural-access-${serial}`;
    const refreshToken = `mural-refresh-${serial}`;
    access.set(accessToken, Date.now() + accessTtl * 1000);
    refresh.add(refreshToken);
    return HttpResponse.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      expires_in: accessTtl,
      ...(options.tokenScope === undefined ? {} : { scope: options.tokenScope }),
    });
  };
  const live = (request: Request): boolean => {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    const expiresAt = access.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  };
  const handlers = [
    http.get(AUTHORIZE, ({ request }) => {
      const url = new URL(request.url);
      serial += 1;
      const code = `mural-code-${serial}`;
      codes.set(code, {
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      const granted =
        options.grantedScopes === undefined ? url.searchParams.get('scope') : options.grantedScopes;
      if (granted !== null) back.searchParams.set('scopes', granted);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return new HttpResponse(null, { status: 302, headers: { location: back.toString() } });
    }),
    http.post(`${AUTHORIZE}/token`, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      state.tokenRequests.push(body);
      if (
        body.get('client_id') !== MURAL_CLIENT.clientId ||
        body.get('client_secret') !== MURAL_CLIENT.clientSecret
      ) {
        return HttpResponse.json({ error: 'invalid_client' }, { status: 401 });
      }
      if (body.get('grant_type') === 'authorization_code') {
        const pending = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !pending ||
          pending.redirectUri !== body.get('redirect_uri') ||
          pending.challenge !== challenge
        ) {
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
        }
        state.codeExchanges += 1;
        return issue();
      }
      if (body.get('grant_type') === 'refresh_token') {
        if (!refresh.delete(body.get('refresh_token') ?? '')) {
          state.refreshFailures += 1;
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
        }
        state.refreshes += 1;
        return issue();
      }
      return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }),
    http.get(`${API}/users/me`, ({ request }) =>
      live(request)
        ? HttpResponse.json({ value: { id: MURAL_USER_ID, email: 'user@example.com' } })
        : new HttpResponse(null, { status: 401 }),
    ),
    http.get(`${API}/workspaces`, ({ request }) => {
      state.apiCalls.push(request.headers.get('authorization') ?? '');
      return live(request)
        ? HttpResponse.json({ value: [{ id: 'ws-1', name: 'Synthetic workspace' }] })
        : HttpResponse.json({ code: 'TOKEN_INVALID', message: 'expired' }, { status: 401 });
    }),
  ];
  /** Invalidate an access token at Mural, as a revocation would. */
  const revokeAccess = (token: string) => access.delete(token);
  const revokeAllAccess = () => access.clear();
  return { handlers, state, revokeAccess, revokeAllAccess };
};
