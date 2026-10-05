import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app, { createApp, requestTokenProvider, resolveIssuer } from '../../../src/app.js';
import type {
  AuthorizationServer,
  VerifiedAccessToken,
} from '../../../src/auth/authorization-server.js';
import type { Logger } from '../../../src/auth/log.js';
import { MURAL_SCOPES } from '../../../src/auth/mural-upstream.js';

describe('resolveIssuer', () => {
  it('takes PUBLIC_URL first, without trailing slashes', () => {
    expect(
      resolveIssuer({ PUBLIC_URL: 'https://mcp.example.com//', VERCEL_BRANCH_URL: 'b.vercel.app' }),
    ).toBe('https://mcp.example.com');
  });

  it('names the production domain in production', () => {
    expect(
      resolveIssuer({
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'mural-mcp-serveur.vercel.app',
        VERCEL_BRANCH_URL: 'branch.vercel.app',
        VERCEL_URL: 'unique.vercel.app',
      }),
    ).toBe('https://mural-mcp-serveur.vercel.app');
  });

  it("names a preview by its branch's stable address, else its own", () => {
    expect(
      resolveIssuer({
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'mural-mcp-serveur.vercel.app',
        VERCEL_BRANCH_URL: 'branch.vercel.app',
        VERCEL_URL: 'unique.vercel.app',
      }),
    ).toBe('https://branch.vercel.app');
    expect(resolveIssuer({ VERCEL_ENV: 'preview', VERCEL_URL: 'unique.vercel.app' })).toBe(
      'https://unique.vercel.app',
    );
  });

  it('falls back to the local vercel dev address', () => {
    expect(resolveIssuer({})).toBe('http://localhost:3000');
    expect(resolveIssuer({ PUBLIC_URL: '' })).toBe('http://localhost:3000');
    expect(resolveIssuer({ VERCEL_ENV: 'production' })).toBe('http://localhost:3000');
  });
});

describe('requestTokenProvider', () => {
  const token: VerifiedAccessToken = {
    muralAccessToken: 'mural-token',
    grantId: 'g-1',
    clientId: 'c-1',
    subject: 'mural:1',
    scopes: ['mural'],
    expiresAt: 0,
  };

  it('hands out the Mural token and the Mural scopes the request carries', async () => {
    const provider = requestTokenProvider({ ...token, muralScopes: ['murals:read'] }, vi.fn());
    expect(await provider.getValidAccessToken()).toBe('mural-token');
    expect(await provider.getScopes()).toEqual(['murals:read']);
  });

  it('reports the scopes asked of Mural when Mural reported none', async () => {
    const provider = requestTokenProvider(token, vi.fn());
    expect(await provider.getScopes()).toEqual(MURAL_SCOPES);
    expect(await provider.getScopes()).not.toBe(MURAL_SCOPES);
  });

  it('ends the grant once Mural refused the token, and hands it out no more', async () => {
    const revoke = vi.fn(async () => undefined);
    const provider = requestTokenProvider(token, revoke);
    await provider.invalidateAccessToken('mural-token');
    expect(revoke).toHaveBeenCalledWith('g-1');
    await expect(provider.getValidAccessToken()).rejects.toThrow(
      'Mural no longer accepts the authorization behind this connection. Sign in again.',
    );
  });
});

describe('the deployed app', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  const serve = async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  };

  const stubDeployment = () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
    vi.stubEnv('MURAL_CLIENT_ID', 'id');
    vi.stubEnv('MURAL_CLIENT_SECRET', 'secret');
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'kv-token');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_BRANCH_URL', 'branch.vercel.app');
  };

  // One module, one app: these run in order and share it, as requests to one instance do.
  it('refuses to serve without its configuration, naming what is missing', async () => {
    stubDeployment();
    vi.stubEnv('MURAL_CLIENT_SECRET', '');
    const base = await serve();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('MURAL_CLIENT_SECRET must be set.');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('is built from the environment on its first request, then kept', async () => {
    stubDeployment();
    const base = await serve();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe('https://branch.vercel.app/mcp');
    // Kept: a later change of environment does not rebuild it.
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe('createApp error handling', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  const serveWith = async (handle: AuthorizationServer['handle']) => {
    const events: [string, unknown][] = [];
    const logger: Logger = {
      warn: vi.fn(),
      error: (event, fields) => events.push([event, fields]),
    };
    const stub: AuthorizationServer = {
      issuer: 'https://mcp.example.com',
      resource: 'https://mcp.example.com/mcp',
      protectedResourceMetadata: {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://mcp.example.com'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mural'],
      },
      handle,
      verifyAccessToken: async () => undefined,
      revokeGrant: async () => undefined,
    };
    server = createServer(createApp({ authorizationServer: stub, logger }));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return { base, events };
  };

  it('answers an unexpected failure with a JSON server error, and logs it', async () => {
    const { base, events } = await serveWith(() => Promise.reject('odd failure'));
    const res = await fetch(`${base}/token`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(events).toEqual([['http_request_failed', { error: 'odd failure' }]]);
  });

  it('closes a response that had already started, rather than writing a second status', async () => {
    const { base, events } = await serveWith(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      throw new Error('mid-stream');
    });
    const res = await fetch(`${base}/token`);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
    expect(events).toEqual([['http_request_failed', { error: 'mid-stream' }]]);
  });
});
