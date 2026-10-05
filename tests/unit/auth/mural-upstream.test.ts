import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMuralAuthorizeUrl,
  exchangeMuralCode,
  fetchMuralIdentity,
  generateCodeChallenge,
  generateCodeVerifier,
  isUpstreamAuthError,
  MURAL_SCOPES,
  refreshMuralTokens,
  TOKEN_REQUEST_TIMEOUT_MS,
} from '../../../src/auth/mural-upstream.js';

const UPSTREAM = { clientId: 'client-id', clientSecret: 'client-secret' };
const NOW = 1_700_000_000_000;
const TOKEN_URL = 'https://app.mural.co/api/public/v1/authorization/oauth2/token';

const jwtWithExp = (exp: unknown) =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

describe('PKCE', () => {
  it('matches the RFC 7636 example', () => {
    expect(generateCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('draws a fresh 256-bit verifier each time', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });
});

describe('buildMuralAuthorizeUrl', () => {
  it('asks for every scope the tools use, with PKCE S256 and our state', () => {
    expect(MURAL_SCOPES).toEqual([
      'workspaces:read',
      'rooms:read',
      'rooms:write',
      'murals:read',
      'murals:write',
      'templates:read',
      'templates:write',
      'identity:read',
    ]);
    const url = new URL(
      buildMuralAuthorizeUrl(UPSTREAM, {
        redirectUri: 'https://mcp.example/oauth/callback',
        state: 'uid-1',
        codeChallenge: 'challenge',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://app.mural.co/api/public/v1/authorization/oauth2',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-id',
      redirect_uri: 'https://mcp.example/oauth/callback',
      scope: MURAL_SCOPES.join(' '),
      state: 'uid-1',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
  });
});

describe('token requests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sent = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return {
      url,
      method: init.method,
      headers: init.headers,
      body: Object.fromEntries(new URLSearchParams(String(init.body))),
      signal: init.signal,
    };
  };

  it('exchanges a code with the client secret and the PKCE verifier', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 900 }),
    );
    const tokens = await exchangeMuralCode(UPSTREAM, {
      code: 'code-1',
      redirectUri: 'https://mcp.example/oauth/callback',
      codeVerifier: 'verifier-1',
    });
    expect(tokens).toEqual({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 900_000 });
    const request = sent();
    expect(request).toMatchObject({
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: {
        client_id: 'client-id',
        client_secret: 'client-secret',
        grant_type: 'authorization_code',
        code: 'code-1',
        redirect_uri: 'https://mcp.example/oauth/callback',
        code_verifier: 'verifier-1',
      },
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(TOKEN_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it('refreshes with the client secret, keeping the refresh token Mural leaves out', async () => {
    fetchMock.mockResolvedValue(Response.json({ access_token: 'a2', expires_in: '900' }));
    expect(await refreshMuralTokens(UPSTREAM, 'r1')).toEqual({
      accessToken: 'a2',
      refreshToken: 'r1',
      expiresAt: NOW + 900_000,
    });
    expect(sent().body).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'r1',
    });
  });

  it('takes the rotated refresh token when Mural sends one', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 900 }),
    );
    expect(await refreshMuralTokens(UPSTREAM, 'r1')).toMatchObject({ refreshToken: 'r2' });
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -5],
    ['not a number', 'soon'],
  ])('falls back to the exp claim when expires_in is %s', async (_label, expiresIn) => {
    fetchMock.mockResolvedValue(
      Response.json({ access_token: jwtWithExp(NOW / 1000 + 600), expires_in: expiresIn }),
    );
    const tokens = await exchangeMuralCode(UPSTREAM, {
      code: 'c',
      redirectUri: 'r',
      codeVerifier: 'v',
    });
    expect(tokens.expiresAt).toBe(NOW + 600_000);
  });

  it.each([
    ['an opaque token', 'opaque'],
    ['a JWT without exp', jwtWithExp(undefined)],
    ['a JWT with a string exp', jwtWithExp('later')],
    ['a token with no payload part', 'header-only'],
  ])('assumes five minutes for %s without expires_in', async (_label, accessToken) => {
    fetchMock.mockResolvedValue(Response.json({ access_token: accessToken }));
    const tokens = await refreshMuralTokens(UPSTREAM, 'r1');
    expect(tokens.expiresAt).toBe(NOW + 5 * 60 * 1000);
  });

  it('reports a refusal with its status, never the Mural body, and releases the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"invalid_grant","secret":"x"}'));
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 400 }));
    const failure = refreshMuralTokens(UPSTREAM, 'r1');
    await expect(failure).rejects.toThrow('Mural refused the refresh_token grant (400).');
    const err = await failure.catch((e: unknown) => e);
    expect(isUpstreamAuthError(err)).toBe(true);
    expect(err).toMatchObject({ name: 'UpstreamAuthError', status: 400 });
    expect(String((err as Error).message)).not.toContain('secret');
    expect(cancel).toHaveBeenCalled();
  });

  it('names the grant type of a refused code exchange', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      exchangeMuralCode(UPSTREAM, { code: 'c', redirectUri: 'r', codeVerifier: 'v' }),
    ).rejects.toMatchObject({
      message: 'Mural refused the authorization_code grant (401).',
      status: 401,
    });
  });

  it('reports an unreachable endpoint without a status, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(cause);
    const err = await refreshMuralTokens(UPSTREAM, 'r1').catch((e: unknown) => e);
    expect(isUpstreamAuthError(err)).toBe(true);
    expect(err).toMatchObject({ message: 'Mural token endpoint unreachable.', cause });
    expect(Object.hasOwn(err as object, 'status')).toBe(false);
  });
});

describe('isUpstreamAuthError', () => {
  it('recognises only upstream errors', () => {
    expect(isUpstreamAuthError(new Error('x'))).toBe(false);
    expect(isUpstreamAuthError({ name: 'UpstreamAuthError' })).toBe(false);
    expect(isUpstreamAuthError(undefined)).toBe(false);
  });
});

describe('fetchMuralIdentity', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const failureOf = (promise: Promise<unknown>) => promise.catch((err: unknown) => err);

  it('reads the user id from /users/me with the access token', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      Response.json({ value: { id: 'user-1234567890123456789012', email: 'x@example.com' } }),
    );
    expect(await fetchMuralIdentity('a1')).toEqual({ id: 'user-1234567890123456789012' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.mural.co/api/public/v1/users/me');
    expect(init.headers).toEqual({ Authorization: 'Bearer a1', Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it.each([
    ['an error status', () => new Response('nope', { status: 401 }), 'users/me answered 401'],
    ['a body that is not JSON', () => new Response('<html>'), undefined],
  ])('fails on %s, keeping the cause', async (_label, response, causeMessage) => {
    fetchMock.mockResolvedValue(response());
    const err = await failureOf(fetchMuralIdentity('a1'));
    expect(err).toMatchObject({
      name: 'UpstreamAuthError',
      message: 'Could not resolve the Mural account of the signed-in user.',
    });
    expect((err as Error).cause).toBeInstanceOf(Error);
    if (causeMessage) expect(((err as Error).cause as Error).message).toBe(causeMessage);
  });

  it('fails when Mural cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await failureOf(fetchMuralIdentity('a1'));
    expect(isUpstreamAuthError(err)).toBe(true);
  });

  it.each([
    ['no value', {}],
    ['no id', { value: {} }],
    ['a numeric id', { value: { id: 42 } }],
    ['an empty id', { value: { id: '' } }],
  ])('never turns an answer with %s into an account', async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    const err = await failureOf(fetchMuralIdentity('a1'));
    expect(err).toMatchObject({
      name: 'UpstreamAuthError',
      message: 'Could not resolve the Mural account of the signed-in user.',
    });
    expect(Object.hasOwn(err as object, 'cause')).toBe(false);
  });
});
