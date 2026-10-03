import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

import { decodeJwtPayload } from './jwt.js';
import type { AuthorizationParams, OAuthError, OAuthTokens, PKCEChallenge, RefreshTokenParams, TokenExchangeParams } from './types.js';

const MURAL_OAUTH_BASE = 'https://app.mural.co/api/public/v1/authorization/oauth2';
const TOKEN_FILE_PATH = path.join(os.homedir(), '.mural-mcp-tokens.json');
// Refresh slightly before the real expiry so a token that would lapse mid-request
// is renewed proactively instead of failing the next API call with a 401.
const EXPIRY_MARGIN_MS = 30_000;
// Lifetime assumed when a token response carries neither expires_in nor a JWT exp.
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60_000;
// Delays between rename attempts: on Windows, replacing a file another process
// holds open (antivirus, another server reading it) fails transiently.
const RENAME_RETRY_DELAYS_MS = [50, 100, 200];
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Validate a /token response and compute `expires_at`.
 * Lifetime source, first match wins: `expires_in` (finite, positive, numeric
 * strings accepted), the JWT `exp` claim of the access token, then a
 * conservative default. Throws when `access_token` is missing or empty.
 */
export function normalizeTokenResponse(data: unknown, previousRefreshToken?: string, now = Date.now()): OAuthTokens {
  const raw = (data !== null && typeof data === 'object' ? data : {}) as Record<string, unknown>;

  const accessToken = raw.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('OAuth token response is missing access_token');
  }

  let lifetimeMs: number | undefined;
  const expiresIn = typeof raw.expires_in === 'number' || typeof raw.expires_in === 'string' ? Number(raw.expires_in) : NaN;
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    lifetimeMs = expiresIn * 1000;
  } else {
    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 > now) {
      lifetimeMs = exp * 1000 - now;
    }
  }
  if (lifetimeMs === undefined) {
    console.warn('OAuth token response has no usable expires_in or JWT exp; assuming a 5 minute lifetime');
    lifetimeMs = DEFAULT_TOKEN_LIFETIME_MS;
  }

  const refreshToken = typeof raw.refresh_token === 'string' && raw.refresh_token !== '' ? raw.refresh_token : previousRefreshToken;

  return {
    access_token: accessToken,
    token_type: typeof raw.token_type === 'string' && raw.token_type !== '' ? raw.token_type : 'Bearer',
    expires_in: Math.round(lifetimeMs / 1000),
    expires_at: now + lifetimeMs,
    ...(refreshToken !== undefined && { refresh_token: refreshToken }),
    ...(typeof raw.scope === 'string' && { scope: raw.scope }),
  };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export class MuralOAuth {
  private clientId: string;
  private clientSecret?: string;
  private redirectUri: string;
  private scopes: string[];
  private authenticationPromise: Promise<OAuthTokens> | null = null;
  // Last access token the API answered 401 to (see invalidateAccessToken).
  private rejectedAccessToken: string | null = null;

  constructor(
    clientId: string,
    clientSecret?: string,
    redirectUri = 'http://localhost:3000/callback',
    scopes = ['workspaces:read', 'rooms:read', 'rooms:write', 'murals:read', 'murals:write', 'templates:read', 'templates:write', 'identity:read'],
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
  }

  private generatePKCEChallenge(): PKCEChallenge {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    return {
      codeVerifier,
      codeChallenge,
      codeChallengeMethod: 'S256',
    };
  }

  private generateAuthorizationUrl(pkce: PKCEChallenge, state?: string): string {
    const params: AuthorizationParams = {
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes.join(' '),
      response_type: 'code',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
      ...(state && { state }),
    };

    const url = new URL(MURAL_OAUTH_BASE);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    return url.toString();
  }

  /** POST to the token endpoint; returns the raw JSON body or throws with the OAuth error. */
  private async postTokenRequest(params: TokenExchangeParams | RefreshTokenParams, failureLabel: string): Promise<unknown> {
    const response = await fetch(`${MURAL_OAUTH_BASE}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined))),
    });

    // A gateway error page (502/503) may not be JSON; keep the status-based error.
    const data: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = data as Partial<OAuthError>;
      throw new Error(`OAuth token ${failureLabel} failed: ${error.error ?? `HTTP ${response.status}`} - ${error.error_description || 'Unknown error'}`);
    }

    return data;
  }

  private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const params: TokenExchangeParams = {
      client_id: this.clientId,
      ...(this.clientSecret && { client_secret: this.clientSecret }),
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    };

    return normalizeTokenResponse(await this.postTokenRequest(params, 'exchange'));
  }

  private async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const params: RefreshTokenParams = {
      client_id: this.clientId,
      ...(this.clientSecret && { client_secret: this.clientSecret }),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };

    // Mural's refresh response may omit refresh_token; keep the previous one so
    // we don't lose refresh capability and force a full interactive re-auth.
    return normalizeTokenResponse(await this.postTokenRequest(params, 'refresh'), refreshToken);
  }

  /**
   * Persist tokens atomically: write a private temp file next to the token
   * file, then rename it over the target. Concurrent readers (other MCP server
   * processes share the file) see either the old or the new content, never a
   * truncated one, and the file is never world-readable, even briefly.
   */
  private async saveTokens(tokens: OAuthTokens): Promise<void> {
    const tmpPath = `${TOKEN_FILE_PATH}.${process.pid}.tmp`;
    try {
      // A stale temp file from a crashed run may predate 0o600: `wx` below
      // guarantees this call creates the file, so `mode` always applies.
      await fs.rm(tmpPath, { force: true });
      await fs.writeFile(tmpPath, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: 'wx' });
      await renameWithRetry(tmpPath, TOKEN_FILE_PATH);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      console.error('Failed to save tokens:', error);
      throw new Error('Failed to save authentication tokens', { cause: error });
    }
  }

  private async loadTokens(): Promise<OAuthTokens | null> {
    try {
      const data: unknown = JSON.parse(await fs.readFile(TOKEN_FILE_PATH, 'utf-8'));
      if (data === null || typeof data !== 'object' || typeof (data as OAuthTokens).access_token !== 'string' || (data as OAuthTokens).access_token === '') {
        return null;
      }
      // A non-finite expires_at (e.g. null persisted by older versions) is kept:
      // isUsable() treats it as expired, so the next call refreshes once.
      return data as OAuthTokens;
    } catch {
      return null;
    }
  }

  /** Whether stored tokens can be served: not rejected by the API and valid for at least `marginMs`. */
  private isUsable(tokens: OAuthTokens | null, marginMs: number): tokens is OAuthTokens & { expires_at: number } {
    return (
      tokens !== null &&
      tokens.access_token !== this.rejectedAccessToken &&
      typeof tokens.expires_at === 'number' &&
      Number.isFinite(tokens.expires_at) &&
      tokens.expires_at > Date.now() + marginMs
    );
  }

  /**
   * Mark an access token as rejected by the API (HTTP 401). It is never served
   * again from the token file, whatever its expires_at, so the next
   * authentication picks up a token refreshed by another process, refreshes,
   * or falls back to the interactive flow.
   */
  invalidateAccessToken(token: string): void {
    this.rejectedAccessToken = token;
  }

  private async startCallbackServer(expectedState?: string): Promise<{ code: string; state?: string }> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/callback')) {
          // Prevent multiple resolutions
          if (resolved) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Already processed</h1><p>Authentication already handled. You can close this window.</p>');
            return;
          }

          const url = new URL(req.url, `http://localhost:3000`);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          console.error(`Callback received - Code: ${code ? 'present' : 'missing'}, State: ${state}, Expected: ${expectedState}`);

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h1>Authentication Error</h1><p>${error}</p>`);
            resolved = true;
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>Error</h1><p>No authorization code received</p>');
            resolved = true;
            server.close();
            reject(new Error('No authorization code received'));
            return;
          }

          if (expectedState && state !== expectedState) {
            console.error(`State mismatch - Expected: "${expectedState}", Received: "${state}"`);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h1>Error</h1><p>Invalid state parameter. Expected: ${expectedState}, Got: ${state}</p>`);
            resolved = true;
            server.close();
            reject(new Error(`Invalid state parameter. Expected: ${expectedState}, Got: ${state}`));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Success!</h1><p>Authentication successful. You can close this window.</p>');
          resolved = true;
          server.close();
          resolve({ code, state: state || undefined });
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>Not Found</h1>');
        }
      });

      server.listen(3000, () => {
        console.error('OAuth callback server started on http://localhost:3000');
      });

      server.on('error', error => {
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      // Add timeout to prevent hanging
      setTimeout(
        () => {
          if (!resolved) {
            resolved = true;
            server.close();
            reject(new Error('Authentication timeout after 5 minutes'));
          }
        },
        5 * 60 * 1000,
      );
    });
  }

  async authenticate(): Promise<OAuthTokens> {
    // If authentication is already in progress, return the existing promise
    if (this.authenticationPromise) {
      return this.authenticationPromise;
    }

    // Start new authentication and store the promise
    this.authenticationPromise = this.performAuthentication();

    try {
      const tokens = await this.authenticationPromise;
      return tokens;
    } finally {
      // Clear the promise when done (success or failure)
      this.authenticationPromise = null;
    }
  }

  private async performAuthentication(): Promise<OAuthTokens> {
    // Check for existing valid tokens. The file is shared with other MCP server
    // processes, so this read also picks up a token another process refreshed.
    const existingTokens = await this.loadTokens();
    if (this.isUsable(existingTokens, EXPIRY_MARGIN_MS)) {
      return existingTokens;
    }

    // Try to refresh if we have a refresh token
    if (existingTokens?.refresh_token) {
      try {
        const refreshedTokens = await this.refreshAccessToken(existingTokens.refresh_token);
        await this.saveTokens(refreshedTokens);
        return refreshedTokens;
      } catch (error) {
        // Another process may have refreshed concurrently: if Mural rotates
        // refresh tokens, ours is now invalid (invalid_grant) but the file
        // already holds a fresh token.
        const latestTokens = await this.loadTokens();
        if (this.isUsable(latestTokens, EXPIRY_MARGIN_MS)) {
          return latestTokens;
        }
        // Inside the expiry margin the stored token still works: keep using it
        // rather than blocking on an interactive browser flow over a transient
        // refresh failure (network error, Mural 5xx). Never for a token the API
        // already rejected.
        if (this.isUsable(existingTokens, 0)) {
          console.warn('Token refresh failed, using the still-valid stored token');
          return existingTokens;
        }
        console.warn('Token refresh failed, starting new authentication flow:', error instanceof Error ? error.message : error);
      }
    }

    // Start new authentication flow
    const pkce = this.generatePKCEChallenge();
    const state = randomBytes(16).toString('hex');
    const authUrl = this.generateAuthorizationUrl(pkce, state);

    console.error('Please open the following URL in your browser to authenticate:');
    console.error(authUrl);
    console.error('\nWaiting for authentication callback...');

    // Start callback server and wait for response
    const callbackPromise = this.startCallbackServer(state);

    // Open browser automatically if possible
    const { spawn } = await import('node:child_process');
    const platform = process.platform;
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';

    try {
      const browserProcess = spawn(command, [authUrl], { stdio: 'ignore', detached: true });
      // spawn() reports failures (e.g. xdg-open missing on WSL/Linux) via an async
      // 'error' event, not a thrown exception — handle it so the server doesn't crash.
      browserProcess.on('error', () => {
        // Browser couldn't be opened automatically; the user opens the URL manually.
      });
      browserProcess.unref();
    } catch (error) {
      // Browser opening failed, user will need to open manually
    }

    const { code } = await callbackPromise;

    // Exchange code for tokens
    const tokens = await this.exchangeCodeForTokens(code, pkce.codeVerifier);
    await this.saveTokens(tokens);

    console.error('Authentication successful!');
    return tokens;
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = await this.authenticate();
    return tokens.access_token;
  }

  async getStoredTokens(): Promise<OAuthTokens | null> {
    return await this.loadTokens();
  }

  async clearTokens(): Promise<void> {
    try {
      await fs.unlink(TOKEN_FILE_PATH);
      console.error('Authentication tokens cleared');
    } catch (error) {
      // File doesn't exist, which is fine
    }
  }
}
