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
    unlink: vi.fn(),
  },
}));

// The interactive parts of the flow (authenticate() full browser flow,
// startCallbackServer, browser spawn) are intentionally out of unit test
// scope: they require a real HTTP server and a browser.

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function createOAuth(clientSecret?: string): MuralOAuth {
  return new MuralOAuth('client-id', clientSecret);
}

/** Access a private method without changing its visibility in source. */
function asAny(oauth: MuralOAuth): any {
  return oauth as any;
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
  });

  describe('exchangeCodeForTokens', () => {
    it('returns tokens with a computed expires_at on success', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 }));
      const before = Date.now();

      const tokens = await asAny(createOAuth('secret')).exchangeCodeForTokens('auth-code', 'verifier');

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
      fetchMock.mockResolvedValue(mockFetchResponse(400, { error: 'invalid_client', error_description: 'Client authentication failed' }));

      await expect(asAny(createOAuth()).exchangeCodeForTokens('auth-code', 'verifier')).rejects.toThrow(
        'OAuth token exchange failed: invalid_client - Client authentication failed',
      );
    });
  });

  describe('refreshAccessToken', () => {
    it('returns refreshed tokens on success', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }));

      const tokens = await asAny(createOAuth('secret')).refreshAccessToken('old-rt');

      expect(tokens.access_token).toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-rt');
    });

    it('throws on invalid_grant', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(400, { error: 'invalid_grant', error_description: 'Refresh token expired' }));

      await expect(asAny(createOAuth()).refreshAccessToken('old-rt')).rejects.toThrow('OAuth token refresh failed: invalid_grant - Refresh token expired');
    });
  });

  describe('token persistence', () => {
    it('getStoredTokens parses the token file', async () => {
      const stored = mockOAuthTokens();
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));

      await expect(createOAuth().getStoredTokens()).resolves.toEqual(stored);
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('.mural-mcp-tokens.json'), 'utf-8');
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
      fetchMock.mockResolvedValue(mockFetchResponse(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }));

      const tokens = await createOAuth('secret').authenticate();

      expect(tokens.access_token).toBe('new-at');
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.mural-mcp-tokens.json'), expect.stringContaining('new-at'));
    });

    it('getValidAccessToken returns the access token of valid stored tokens', async () => {
      const stored = mockOAuthTokens({ expires_at: Date.now() + 60_000 });
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(stored));

      await expect(createOAuth().getValidAccessToken()).resolves.toBe(stored.access_token);
    });
  });
});
