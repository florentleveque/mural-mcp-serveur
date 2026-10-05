import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuralOAuth } from '../../src/oauth.js';
import { mockFetchResponse, mockOAuthTokens } from './helpers.js';

// Token persistence goes through fs/promises (~/.mural-mcp-tokens.json).
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
  },
}));

// The browser is never opened: spawn is stubbed. The callback server itself is
// covered in oauth-callback.test.ts, which mocks node:http.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function createOAuth(clientSecret?: string): MuralOAuth {
  return new MuralOAuth('client-id', clientSecret);
}

/** Access a private method without changing its visibility in source. */
function asAny(oauth: MuralOAuth): any {
  return oauth as any;
}

/** An unsigned JWT whose payload is `payload`, as Mural issues access tokens. */
function jwtWith(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

describe('MuralOAuth', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('generatePKCEChallenge', () => {
    it('produces base64url verifier and challenge with S256 method', () => {
      const pkce = asAny(createOAuth()).generatePKCEChallenge();

      expect(pkce.codeVerifier).toMatch(BASE64URL_PATTERN);
      expect(pkce.codeChallenge).toMatch(BASE64URL_PATTERN);
      expect(pkce.codeChallengeMethod).toBe('S256');
    });

    it('derives the challenge as sha256(verifier) in base64url', () => {
      const pkce = asAny(createOAuth()).generatePKCEChallenge();

      const expected = createHash('sha256').update(pkce.codeVerifier).digest('base64url');
      expect(pkce.codeChallenge).toBe(expected);
    });
  });

  describe('generateAuthorizationUrl', () => {
    it('includes the PKCE challenge, client id, redirect uri, scopes and state', () => {
      const oauth = createOAuth();
      const pkce = asAny(oauth).generatePKCEChallenge();

      const url = new URL(asAny(oauth).generateAuthorizationUrl(pkce, 'my-state'));

      expect(url.searchParams.get('client_id')).toBe('client-id');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe('my-state');
      expect(url.searchParams.get('scope')).toContain('murals:write');
    });

    it('requests the default scope set when none is given', () => {
      const oauth = createOAuth();
      const pkce = asAny(oauth).generatePKCEChallenge();

      const url = new URL(asAny(oauth).generateAuthorizationUrl(pkce));

      expect(url.searchParams.get('scope')).toBe(
        'workspaces:read rooms:read rooms:write murals:read murals:write templates:read templates:write identity:read',
      );
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('returns tokens with a computed expires_at on success', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'at',
          refresh_token: 'rt',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      const before = Date.now();

      const tokens = await asAny(createOAuth('secret')).exchangeCodeForTokens(
        'auth-code',
        'verifier',
      );

      expect(tokens.access_token).toBe('at');
      expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    });

    it('sends client_secret in the body when configured', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'at', expires_in: 3600 }));

      await asAny(createOAuth('secret')).exchangeCodeForTokens('auth-code', 'verifier');

      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('client_secret')).toBe('secret');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('code_verifier')).toBe('verifier');
      expect(body.get('grant_type')).toBe('authorization_code');
    });

    it('omits client_secret from the body when not configured', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'at', expires_in: 3600 }));

      await asAny(createOAuth()).exchangeCodeForTokens('auth-code', 'verifier');

      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.has('client_secret')).toBe(false);
    });

    it('throws with the OAuth error description on failure', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(400, {
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        }),
      );

      await expect(
        asAny(createOAuth()).exchangeCodeForTokens('auth-code', 'verifier'),
      ).rejects.toThrow(
        'OAuth token exchange failed: invalid_client - Client authentication failed',
      );
    });

    it('falls back to "Unknown error" when the failure has no description', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(400, { error: 'invalid_client' }));

      await expect(
        asAny(createOAuth()).exchangeCodeForTokens('auth-code', 'verifier'),
      ).rejects.toThrow('OAuth token exchange failed: invalid_client - Unknown error');
    });
  });

  describe('refreshAccessToken', () => {
    it('returns refreshed tokens on success', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      );

      const tokens = await asAny(createOAuth('secret')).refreshAccessToken('old-rt');

      expect(tokens.access_token).toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-rt');
    });

    it('throws on invalid_grant', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(400, {
          error: 'invalid_grant',
          error_description: 'Refresh token expired',
        }),
      );

      await expect(asAny(createOAuth()).refreshAccessToken('old-rt')).rejects.toThrow(
        'OAuth token refresh failed: invalid_grant - Refresh token expired',
      );
    });

    it('falls back to "Unknown error" when the refresh failure has no description', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(400, { error: 'invalid_grant' }));

      await expect(asAny(createOAuth()).refreshAccessToken('old-rt')).rejects.toThrow(
        'OAuth token refresh failed: invalid_grant - Unknown error',
      );
    });

    it('keeps the previous refresh_token when the response omits it', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { access_token: 'new-at', expires_in: 3600 }),
      );

      const tokens = await asAny(createOAuth('secret')).refreshAccessToken('old-rt');

      expect(tokens.access_token).toBe('new-at');
      expect(tokens.refresh_token).toBe('old-rt');
    });
  });

  describe('token lifetime', () => {
    const NOW = 1_000_000_000_000;

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function exchange(body: Record<string, unknown>) {
      fetchMock.mockResolvedValue(mockFetchResponse(200, body));
      return asAny(createOAuth()).exchangeCodeForTokens('auth-code', 'verifier');
    }

    it('accepts an expires_in sent as a numeric string', async () => {
      const tokens = await exchange({ access_token: 'at', expires_in: '3600' });

      expect(tokens.expires_at).toBe(NOW + 3_600_000);
    });

    it('falls back to the exp claim of the access token without expires_in', async () => {
      const tokens = await exchange({ access_token: jwtWith({ exp: NOW / 1000 + 900 }) });

      expect(tokens.expires_at).toBe(NOW + 900_000);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>]>([
      ['no expires_in and an opaque token', { access_token: 'opaque' }],
      ['a zero expires_in', { access_token: 'opaque', expires_in: 0 }],
      ['a negative expires_in', { access_token: 'opaque', expires_in: -60 }],
      ['an infinite expires_in', { access_token: 'opaque', expires_in: 'Infinity' }],
      ['a null expires_in', { access_token: 'opaque', expires_in: null }],
      ['an exp claim that is not a number', { access_token: jwtWith({ exp: '900' }) }],
      ['a token payload that is not JSON', { access_token: 'header.not-json.signature' }],
    ])('assumes a five-minute lifetime and warns for %s', async (_label, body) => {
      const tokens = await exchange(body);

      expect(tokens.expires_at).toBe(NOW + 300_000);
      expect(console.warn).toHaveBeenCalledWith(
        'Token response has no usable expires_in; assuming the token expires in 5 minutes.',
      );
    });

    it('applies the same rule to a refresh response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'opaque' }));

      const tokens = await asAny(createOAuth()).refreshAccessToken('old-rt');

      expect(tokens.expires_at).toBe(NOW + 300_000);
    });
  });

  describe('token persistence', () => {
    it('getStoredTokens parses the token file', async () => {
      const stored = mockOAuthTokens();
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));

      await expect(createOAuth().getStoredTokens()).resolves.toEqual(stored);
      expect(fs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('.mural-mcp-tokens.json'),
        'utf-8',
      );
    });

    it('getStoredTokens returns null when the file is missing', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      await expect(createOAuth().getStoredTokens()).resolves.toBeNull();
    });

    it('clearTokens deletes the token file', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await createOAuth().clearTokens();

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.mural-mcp-tokens.json'));
    });

    it('clearTokens resolves silently when the file does not exist', async () => {
      vi.mocked(fs.unlink).mockRejectedValue(new Error('ENOENT'));

      await expect(createOAuth().clearTokens()).resolves.toBeUndefined();
    });
  });

  describe('getScopes', () => {
    function storeTokens(overrides: Record<string, unknown>) {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockOAuthTokens(overrides)));
    }

    it('returns no scope when no token is stored, without starting a flow', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      await expect(createOAuth().getScopes()).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('splits the scope field and drops blank entries', async () => {
      storeTokens({ scope: 'murals:read  rooms:read \t ' });

      await expect(createOAuth().getScopes()).resolves.toEqual(['murals:read', 'rooms:read']);
    });

    it('falls back to the scopes claim of the access token', async () => {
      storeTokens({ scope: undefined, access_token: jwtWith({ scopes: ['murals:read'] }) });

      await expect(createOAuth().getScopes()).resolves.toEqual(['murals:read']);
    });

    it('ignores a scopes claim that is not an array', async () => {
      storeTokens({ scope: undefined, access_token: jwtWith({ scopes: 'murals:read' }) });

      await expect(createOAuth().getScopes()).resolves.toEqual([]);
    });

    it('returns no scope for an access token without a payload part', async () => {
      storeTokens({ scope: undefined, access_token: 'opaque-token' });

      await expect(createOAuth().getScopes()).resolves.toEqual([]);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('returns no scope and warns when the payload is not JSON', async () => {
      storeTokens({ scope: undefined, access_token: 'header.not-json.signature' });

      await expect(createOAuth().getScopes()).resolves.toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        'Failed to decode JWT for scope extraction:',
        expect.any(SyntaxError),
      );
    });

    it('returns no scope when the stored token has neither scope nor access token', async () => {
      storeTokens({ scope: undefined, access_token: undefined });

      await expect(createOAuth().getScopes()).resolves.toEqual([]);
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('authenticate', () => {
    it('returns stored tokens when they are still valid, without any network call', async () => {
      const stored = mockOAuthTokens({ expires_at: Date.now() + 60_000 });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));

      await expect(createOAuth().authenticate()).resolves.toEqual(stored);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes expired tokens and persists the new ones', async () => {
      const stored = mockOAuthTokens({ expires_at: Date.now() - 1000, refresh_token: 'old-rt' });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      );

      const tokens = await createOAuth('secret').authenticate();

      expect(tokens.access_token).toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      // The token file holds plaintext credentials: it must be written and kept at 0o600.
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.mural-mcp-tokens.json'),
        expect.stringContaining('new-at'),
        { mode: 0o600 },
      );
      expect(fs.chmod).toHaveBeenCalledWith(
        expect.stringContaining('.mural-mcp-tokens.json'),
        0o600,
      );
      // Diagnostics must go to stderr, never stdout, to keep the MCP stdio stream clean.
      // biome-ignore lint/suspicious/noConsole: asserting on the console.log spy, not logging
      expect(console.log).not.toHaveBeenCalled();
    });

    it('refreshes a token that expires within the safety margin', async () => {
      // Still valid by raw expiry (+10 s) but inside the 30 s margin → refresh proactively.
      const stored = mockOAuthTokens({ expires_at: Date.now() + 10_000, refresh_token: 'old-rt' });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      );

      const tokens = await createOAuth('secret').authenticate();

      expect(tokens.access_token).toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
    });

    it('falls back to the still-valid stored token when a refresh inside the margin fails', async () => {
      // +10 s: inside the 30 s margin, so a refresh is attempted, but the token still works.
      const stored = mockOAuthTokens({ expires_at: Date.now() + 10_000, refresh_token: 'old-rt' });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      fetchMock.mockResolvedValue(mockFetchResponse(503, { error: 'server_error' }));
      const startCallbackServer = vi.spyOn(asAny(MuralOAuth.prototype), 'startCallbackServer');

      await expect(createOAuth('secret').authenticate()).resolves.toEqual(stored);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No interactive browser flow for a transient refresh failure.
      expect(startCallbackServer).not.toHaveBeenCalled();
    });

    it('keeps refreshed tokens when tightening the file permissions fails', async () => {
      const stored = mockOAuthTokens({ expires_at: Date.now() - 1000, refresh_token: 'old-rt' });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 3600,
        }),
      );

      const tokens = await createOAuth('secret').authenticate();

      expect(tokens.access_token).toBe('new-at');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('permissions'),
        expect.any(Error),
      );
    });

    it('refreshes a token expiring exactly at the safety margin', async () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
      try {
        const stored = mockOAuthTokens({
          expires_at: Date.now() + 30_000,
          refresh_token: 'old-rt',
        });
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.chmod).mockResolvedValue(undefined);
        fetchMock.mockResolvedValue(
          mockFetchResponse(200, {
            access_token: 'new-at',
            refresh_token: 'new-rt',
            expires_in: 3600,
          }),
        );

        const tokens = await createOAuth('secret').authenticate();

        expect(tokens.access_token).toBe('new-at');
      } finally {
        vi.useRealTimers();
      }
    });

    it('refreshes a stored token Mural rejected, even before its expiry', async () => {
      const stored = mockOAuthTokens({
        access_token: 'revoked',
        expires_at: Date.now() + 60_000,
        refresh_token: 'old-rt',
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { access_token: 'new-at', expires_in: 3600 }),
      );
      const oauth = createOAuth('secret');

      await oauth.invalidateAccessToken('revoked');

      await expect(oauth.getValidAccessToken()).resolves.toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
    });

    it('uses a stored token other than the rejected one without any network call', async () => {
      // Another server process refreshed the shared token file in the meantime.
      const stored = mockOAuthTokens({ access_token: 'replaced', expires_at: Date.now() + 60_000 });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      const oauth = createOAuth('secret');

      await oauth.invalidateAccessToken('revoked');

      await expect(oauth.getValidAccessToken()).resolves.toBe('replaced');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never falls back to a rejected token when its refresh fails', async () => {
      const stored = mockOAuthTokens({
        access_token: 'revoked',
        expires_at: Date.now() + 60_000,
        refresh_token: 'old-rt',
      });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);
      const startCallbackServer = vi
        .spyOn(asAny(MuralOAuth.prototype), 'startCallbackServer')
        .mockResolvedValue({ code: 'auth-code' });
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(400, { error: 'invalid_grant' }))
        .mockResolvedValueOnce(
          mockFetchResponse(200, { access_token: 'fresh-at', expires_in: 3600 }),
        );
      const oauth = createOAuth('secret');

      await oauth.invalidateAccessToken('revoked');

      await expect(oauth.getValidAccessToken()).resolves.toBe('fresh-at');
      expect(startCallbackServer).toHaveBeenCalledTimes(1);
    });

    it('runs the browser flow when a token expiring right now cannot be refreshed', async () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
      try {
        const stored = mockOAuthTokens({ expires_at: Date.now(), refresh_token: 'old-rt' });
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.chmod).mockResolvedValue(undefined);
        const startCallbackServer = vi
          .spyOn(asAny(MuralOAuth.prototype), 'startCallbackServer')
          .mockResolvedValue({ code: 'auth-code' });
        fetchMock
          .mockResolvedValueOnce(mockFetchResponse(503, { error: 'server_error' }))
          .mockResolvedValueOnce(
            mockFetchResponse(200, { access_token: 'fresh-at', expires_in: 3600 }),
          );

        await expect(createOAuth('secret').getValidAccessToken()).resolves.toBe('fresh-at');
        expect(startCallbackServer).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs the browser flow when no tokens are stored', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.chmod).mockResolvedValue(undefined);
      vi.spyOn(asAny(MuralOAuth.prototype), 'startCallbackServer').mockResolvedValue({
        code: 'auth-code',
      });
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, {
          access_token: 'fresh-at',
          refresh_token: 'fresh-rt',
          expires_in: 3600,
        }),
      );

      const tokens = await createOAuth('secret').authenticate();

      expect(tokens.access_token).toBe('fresh-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
    });

    it('getValidAccessToken returns the access token of valid stored tokens', async () => {
      const stored = mockOAuthTokens({ expires_at: Date.now() + 60_000 });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));

      await expect(createOAuth().getValidAccessToken()).resolves.toBe(stored.access_token);
    });
  });
});
