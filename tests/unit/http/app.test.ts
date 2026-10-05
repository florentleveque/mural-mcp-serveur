// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import {
  CompactEncrypt,
  compactDecrypt,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  SignJWT,
} from 'jose';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.js';
import { createAuthorizationServer } from '../../../src/auth/authorization-server.js';
import { deriveKeyRing } from '../../../src/auth/keys.js';
import type { Logger } from '../../../src/auth/log.js';
import { createRedisStore, type RecordStore } from '../../../src/auth/record-store.js';
import { isAllowedOrigin } from '../../../src/http/cors.js';
import { toolDefinitions } from '../../../src/tools/registry.js';
import { createFakeRedis } from '../auth/fake-redis.js';
import {
  createMuralOAuthMock,
  localServerPassthrough,
  MURAL_CLIENT,
  MURAL_USER_ID,
  mswServer,
  useMsw,
} from '../msw.js';
import {
  authorize,
  callMcp,
  createCookieJar,
  DCR_REDIRECT,
  exchangeCode,
  mcpRequest,
  refresh,
  registerDcrClient,
  signInWithDcr,
  tokenRequest,
} from '../oauth-client.js';

useMsw();

const OLD = Buffer.alloc(32, 5).toString('base64');
const NEW = Buffer.alloc(32, 6).toString('base64');

const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CHATGPT = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const UNKNOWN = 'https://tools.example.com/oauth/client.json';
const MURAL_TOKEN_URL = 'https://app.mural.co/api/public/v1/authorization/oauth2/token';
const MISSING_BEARER =
  'Missing or invalid access token. Sign in through this server: its OAuth authorization server is named in the protected resource metadata.';

const chatgptKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const chatgptAssertion = (audience: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(CHATGPT)
    .setSubject(CHATGPT)
    .setAudience(audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(chatgptKeys.privateKey);

// The documents as fetched on 2026-09-24 for fruggr/zendesk-mcp-server, served from memory.
const cimdDocuments = async (): Promise<Record<string, unknown>> => ({
  [CLAUDE]: {
    client_id: CLAUDE,
    client_name: 'Claude',
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    ],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [CHATGPT]: {
    client_id: CHATGPT,
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_CALLBACK],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_signing_alg: 'RS256',
    jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  },
  'https://chatgpt.com/oauth/jwks.json': {
    keys: [{ ...(await exportJWK(chatgptKeys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }],
  },
  [UNKNOWN]: {
    client_id: UNKNOWN,
    client_name: 'Some Tool',
    redirect_uris: ['https://tools.example.com/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
});

const cimdRequests: string[] = [];
// Documents whose host answers 403, as bot protection does to some egress IPs.
const blockedDocuments = new Set<string>();

const cimdFetch = async (input: string | URL | Request): Promise<Response> => {
  cimdRequests.push(String(input));
  if (blockedDocuments.has(String(input))) return new Response('blocked', { status: 403 });
  const doc = (await cimdDocuments())[String(input)];
  return doc ? Response.json(doc) : new Response('not found', { status: 404 });
};

const recordingLogger = () => {
  const events: [string, string, unknown][] = [];
  const record =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      events.push([level, event, fields]);
    };
  const logger: Logger = { warn: record('warn'), error: record('error') };
  return { logger, events };
};

describe('the HTTP server', () => {
  let server: Server | undefined;
  let base = '';
  let mural: ReturnType<typeof createMuralOAuthMock>;
  let fakeRedis: ReturnType<typeof createFakeRedis>;
  let store: RecordStore;
  let port = 0;

  interface StartOptions {
    /** The public URL, when it is not the address the test server listens on. */
    issuer?: string;
    secret?: string;
    accessTtlSeconds?: number;
    logger?: Logger;
  }

  const useMural = (accessTtlSeconds?: number) => {
    mural = createMuralOAuthMock(accessTtlSeconds === undefined ? {} : { accessTtlSeconds });
    mswServer.use(localServerPassthrough, ...mural.handlers);
  };

  /** One instance over the shared store; a second call is another Vercel instance. */
  const start = async (options: StartOptions = {}) => {
    await stop();
    if (options.accessTtlSeconds !== undefined) useMural(options.accessTtlSeconds);
    let app: Express | undefined;
    const listening = createServer((req, res) => {
      app?.(req, res);
    });
    // Another instance answers on the same address: the issuer stays the same.
    await new Promise<void>((resolve) => listening.listen(port, '127.0.0.1', resolve));
    server = listening;
    const address = listening.address();
    port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    app = createApp({
      authorizationServer: createAuthorizationServer({
        issuer: options.issuer ?? base,
        ring: deriveKeyRing(options.secret ?? OLD),
        store,
        upstream: MURAL_CLIENT,
        isAllowedOrigin,
        logger: options.logger,
        fetch: cimdFetch,
      }),
      logger: options.logger,
    });
  };

  const stop = async () => {
    const running = server;
    server = undefined;
    if (!running) return;
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
  };

  beforeEach(() => {
    port = 0;
    fakeRedis = createFakeRedis();
    store = createRedisStore(fakeRedis.redis, 'test');
    useMural();
  });
  afterEach(async () => {
    await stop();
    vi.restoreAllMocks();
    blockedDocuments.clear();
    cimdRequests.length = 0;
  });

  describe('discovery', () => {
    it('advertises DCR, CIMD, RFC 9207 iss, PKCE S256 and the client auth methods ChatGPT needs', async () => {
      await start({ issuer: 'https://mcp.example.com' });
      // As the TLS-terminating proxy in front forwards it.
      const meta = await (
        await fetch(`${base}/.well-known/oauth-authorization-server`, {
          headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mcp.example.com' },
        })
      ).json();
      expect({
        issuer: meta.issuer,
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        registration_endpoint: meta.registration_endpoint,
        revocation_endpoint: meta.revocation_endpoint,
        client_id_metadata_document_supported: meta.client_id_metadata_document_supported,
        authorization_response_iss_parameter_supported:
          meta.authorization_response_iss_parameter_supported,
        code_challenge_methods_supported: meta.code_challenge_methods_supported,
        grant_types_supported: meta.grant_types_supported,
        response_types_supported: meta.response_types_supported,
        token_endpoint_auth_methods_supported: meta.token_endpoint_auth_methods_supported,
        scopes_supported: meta.scopes_supported,
        userinfo_endpoint: meta.userinfo_endpoint,
        end_session_endpoint: meta.end_session_endpoint,
      }).toEqual({
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/auth',
        token_endpoint: 'https://mcp.example.com/token',
        registration_endpoint: 'https://mcp.example.com/reg',
        revocation_endpoint: 'https://mcp.example.com/token/revocation',
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: [
          'none',
          'private_key_jwt',
          'client_secret_basic',
          'client_secret_post',
        ],
        scopes_supported: ['mural', 'offline_access', 'openid'],
        userinfo_endpoint: undefined,
        end_session_endpoint: undefined,
      });
    });

    it('serves the protected-resource metadata on both paths, and a health check', async () => {
      await start({ issuer: 'https://mcp.example.com' });
      const expected = {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://mcp.example.com'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mural'],
      };
      for (const path of [
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expected);
      }
      const health = await fetch(`${base}/healthz`);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(health.headers.get('x-powered-by')).toBeNull();
    });

    it('serves the derived signing key, never the library development keys', async () => {
      await start();
      const jwks = await (await fetch(`${base}/jwks`)).json();
      expect(jwks.keys.map((k: { kid: string }) => k.kid)).toEqual([
        deriveKeyRing(OLD)[0].signingJwk.kid,
      ]);
      expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
      expect(jwks.keys[0].d).toBeUndefined();
    });
  });

  describe('DCR clients', () => {
    it('show the consent screen once, then sign in without it', async () => {
      await start();
      const { clientId, result, tokens } = await signInWithDcr(base);
      expect(result.consentShown).toBe(true);
      expect(result.iss).toBe(base);
      expect(tokens.status).toBe(200);
      expect(tokens.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'mural' });
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);

      const again = await authorize(base, { clientId, redirectUri: DCR_REDIRECT });
      expect(again.consentShown).toBe(false);
      expect(again.code).toEqual(expect.any(String));
      expect(mural.state.codeExchanges).toBe(2);
    });

    it('send the user back with access_denied when consent is refused', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
        deny: true,
      });
      expect(result.consentShown).toBe(true);
      expect(result.code).toBeUndefined();
      expect(result.error).toBe('access_denied');
    });

    it('send the user back with access_denied when Mural refuses the sign-in', async () => {
      await start();
      mswServer.use(
        http.post(MURAL_TOKEN_URL, () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
      expect(result.errorDescription).toBe('Mural refused the authorization_code grant (400).');
    });
  });

  describe('CIMD clients', () => {
    it('skip consent for claude.ai, whose redirect is HTTPS and in its own document', async () => {
      await start();
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      expect(result.consentShown).toBe(false);
      expect(result.code).toEqual(expect.any(String));
      expect(result.iss).toBe(base);
      const tokens = await exchangeCode(base, CLAUDE, CLAUDE_CALLBACK, result);
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });

    it('show consent to an unknown client', async () => {
      await start();
      const result = await authorize(base, {
        clientId: UNKNOWN,
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.consentShown).toBe(true);
    });

    it('accept Claude Code on a random loopback port, behind the consent screen', async () => {
      await start();
      const redirectUri = 'http://127.0.0.1:53123/callback';
      const result = await authorize(base, { clientId: CLAUDE_CODE, redirectUri });
      expect(result.consentShown).toBe(true);
      expect(result.code).toEqual(expect.any(String));
      expect((await exchangeCode(base, CLAUDE_CODE, redirectUri, result)).status).toBe(200);
    });

    it('refuse a redirect the document does not list', async () => {
      await start();
      const result = await authorize(base, {
        clientId: CLAUDE,
        redirectUri: 'https://evil.example/cb',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_redirect_uri');
    });

    it('authenticate ChatGPT with private_key_jwt and skip its consent', async () => {
      await start();
      const result = await authorize(base, { clientId: CHATGPT, redirectUri: CHATGPT_CALLBACK });
      expect(result.consentShown).toBe(false);
      const tokens = await tokenRequest(base, {
        grant_type: 'authorization_code',
        client_id: CHATGPT,
        code: result.code ?? '',
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: result.verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await chatgptAssertion(base),
      });
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });
  });

  describe('error paths', () => {
    const html = async (res: Response) => ({ status: res.status, body: await res.text() });

    it('answers an expired or foreign sign-in link with a plain error page', async () => {
      await start();
      const unknown = await html(
        await fetch(`${base}/interaction/unknown-uid`, { redirect: 'manual' }),
      );
      expect(unknown.status).toBe(400);
      expect(unknown.body).toContain('This sign-in has expired or was opened in another browser.');
      const bad = await html(
        await fetch(`${base}/interaction/not%20a%20uid`, { redirect: 'manual' }),
      );
      expect(bad.status).toBe(404);
      const noRoute = await html(
        await fetch(`${base}/interaction/abc/whatever`, { redirect: 'manual' }),
      );
      expect(noRoute.status).toBe(404);
    });

    it('rejects a Mural callback whose state is not an interaction id', async () => {
      await start();
      const res = await fetch(`${base}/oauth/callback?code=x&state=%2F%2Fevil.example`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });

    it('relays a Mural callback without a code as a refused sign-in', async () => {
      await start();
      mswServer.use(
        http.get('https://app.mural.co/api/public/v1/authorization/oauth2', ({ request }) => {
          const url = new URL(request.url);
          const back = new URL(url.searchParams.get('redirect_uri') ?? '');
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('state', url.searchParams.get('state') ?? '');
          return new HttpResponse(null, { status: 302, headers: { location: back.toString() } });
        }),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
    });

    it('refuses the sign-in when Mural does not say who the user is', async () => {
      await start();
      mswServer.use(
        http.get('https://app.mural.co/api/public/v1/users/me', () =>
          HttpResponse.json({ value: { id: null } }),
        ),
      );
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      expect(result.error).toBe('access_denied');
    });

    it('refuses a token for another resource', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
        resource: 'https://other.example/mcp',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_target');
    });

    it('never fetches a client metadata document over plain HTTP', async () => {
      await start();
      const result = await authorize(base, {
        clientId: 'http://tools.example.com/oauth/client.json',
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_client');
    });

    it('answers a failure no route handles with a server error, and logs it', async () => {
      const { logger, events } = recordingLogger();
      await start({ logger });
      const { tokens } = await signInWithDcr(base);
      vi.spyOn(store, 'get').mockRejectedValue(new Error('store down'));
      const res = await mcpRequest(base, tokens.body.access_token, 'tools/list');
      expect(res.status).toBe(500);
      expect(events).toContainEqual(['error', 'http_request_failed', { error: 'store down' }]);
    });
  });

  describe('access tokens', () => {
    it('reject a raw Mural token (no passthrough), a foreign audience and an expired token', async () => {
      await start();
      const { tokens } = await signInWithDcr(base);
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);

      const raw = await callMcp(base, 'mural-access-2');
      expect(raw.status).toBe(401);
      expect(raw.wwwAuthenticate).toBe(
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${MISSING_BEARER}"`,
      );
      expect(JSON.parse(raw.body)).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: MISSING_BEARER },
        id: null,
      });

      const [keys] = deriveKeyRing(OLD);
      // A forged token needs a grant that exists: take the real one's.
      const { gid } = JSON.parse(
        new TextDecoder().decode(
          (await compactDecrypt(tokens.body.access_token ?? '', keys.accessToken.key)).plaintext,
        ),
      ) as { gid: string };
      const forge = (claims: Record<string, unknown>) =>
        new CompactEncrypt(
          new TextEncoder().encode(
            JSON.stringify({
              iss: base,
              aud: `${base}/mcp`,
              exp: Math.floor(Date.now() / 1000) + 60,
              mt: 'mural-access-2',
              gid,
              sub: 's',
              ...claims,
            }),
          ),
        )
          .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: keys.accessToken.kid })
          .encrypt(keys.accessToken.key);
      expect((await callMcp(base, await forge({}))).status).toBe(200);
      for (const claims of [
        { aud: 'https://other.example/mcp' },
        { iss: 'https://other.example' },
        { exp: Math.floor(Date.now() / 1000) - 1 },
        { mt: undefined },
      ]) {
        expect((await callMcp(base, await forge(claims))).status).toBe(401);
      }
      expect((await callMcp(base, undefined)).status).toBe(401);
    });

    it('accept only a bearer token in the Authorization header', async () => {
      await start();
      const { tokens } = await signInWithDcr(base);
      const call = (authorization: string) =>
        fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
      expect((await call(`bearer ${tokens.body.access_token}`)).status).toBe(200);
      expect((await call(`Bearer   ${tokens.body.access_token}  `)).status).toBe(200);
      // Seven characters, like "Bearer ": only the scheme tells them apart.
      expect((await call(`Digest ${tokens.body.access_token}`)).status).toBe(401);
      expect((await call(`Basic ${tokens.body.access_token}`)).status).toBe(401);
      expect((await call('Bearer ')).status).toBe(401);
      expect((await call('Bearer')).status).toBe(401);
    });
  });

  describe('MCP', () => {
    it('lists every tool and calls one with the Mural token of the signed-in user', async () => {
      await start();
      const { tokens } = await signInWithDcr(base);
      const list = await mcpRequest(base, tokens.body.access_token, 'tools/list');
      expect(list.status).toBe(200);
      const tools = list.message?.result?.['tools'] as { name: string }[];
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(toolDefinitions.map((tool) => tool.name));

      const call = await mcpRequest(base, tokens.body.access_token, 'tools/call', {
        name: 'list-workspaces',
        arguments: {},
      });
      expect(call.status).toBe(200);
      const content = call.message?.result?.['content'] as { text: string }[];
      expect(content[0]?.text).toContain('Synthetic workspace');
      expect(mural.state.apiCalls).toEqual(['Bearer mural-access-2']);
    });

    it('ends the grant when Mural answers 401, so the client signs in again', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      mural.revokeAccess('mural-access-2');
      const call = await mcpRequest(base, tokens.body.access_token, 'tools/call', {
        name: 'list-workspaces',
        arguments: {},
      });
      expect(call.message?.result?.['isError']).toBe(true);
      const content = call.message?.result?.['content'] as { text: string }[];
      expect(content[0]?.text).toContain(
        'Mural no longer accepts the authorization behind this connection. Sign in again.',
      );
      // One call with the revoked token, no retry with it.
      expect(mural.state.apiCalls).toEqual(['Bearer mural-access-2']);
      const next = await mcpRequest(base, tokens.body.access_token, 'tools/list');
      expect(next.status).toBe(401);
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).body.error).toBe(
        'invalid_grant',
      );
    });

    it('revokes the grant of the caller only on clear-auth', async () => {
      await start();
      const first = await signInWithDcr(base);
      const second = await signInWithDcr(base);
      const cleared = await mcpRequest(base, first.tokens.body.access_token, 'tools/call', {
        name: 'clear-auth',
        arguments: {},
      });
      expect(cleared.message?.result?.['isError']).toBeUndefined();
      expect((await callMcp(base, first.tokens.body.access_token)).status).toBe(401);
      expect((await callMcp(base, second.tokens.body.access_token)).status).toBe(200);
    });

    it('reports the Mural scopes the server asks for', async () => {
      await start();
      const { tokens } = await signInWithDcr(base);
      const call = await mcpRequest(base, tokens.body.access_token, 'tools/call', {
        name: 'check-user-scopes',
        arguments: {},
      });
      const content = call.message?.result?.['content'] as { text: string }[];
      expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ missing: [] });
    });
  });

  describe('refresh', () => {
    it('rotates our refresh token and keeps the Mural one until it nears expiry', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(200);
      expect(next.body.refresh_token).not.toBe(tokens.body.refresh_token);
      expect(mural.state.refreshes).toBe(0);
      expect((await callMcp(base, next.body.access_token)).status).toBe(200);
    });

    it('never spends a Mural refresh token twice, however parallel refreshes interleave', async () => {
      // A Mural token shorter than our access token is refreshed on every
      // issuance, so every one of these refreshes reaches Mural.
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await start({ accessTtlSeconds: 60 });
      const { clientId, tokens } = await signInWithDcr(base);
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => refresh(base, clientId, tokens.body.refresh_token ?? '')),
      );
      for (const result of results) {
        expect(result.status === 200 || result.body.error === 'invalid_grant').toBe(true);
      }
      expect(results.some((result) => result.status === 200)).toBe(true);
      expect(mural.state.refreshFailures).toBe(0);
    });

    it('revokes the whole grant when a consumed refresh token is replayed', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      const replay = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(replay.body.error).toBe('invalid_grant');
      const latest = await refresh(base, clientId, next.body.refresh_token ?? '');
      expect(latest.body.error).toBe('invalid_grant');
    });

    it('ends the grant when Mural refuses the upstream refresh', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await start({ accessTtlSeconds: 60 });
      const { clientId, tokens } = await signInWithDcr(base);
      mswServer.use(
        http.post(MURAL_TOKEN_URL, () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(400);
      expect(next.body.error).toBe('invalid_grant');
    });
  });

  describe('provider configuration', () => {
    it('signs in to Mural again on every authorization, even with a live browser session', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const jar = createCookieJar();
      expect((await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar })).code).toEqual(
        expect.any(String),
      );
      const again = await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar });
      expect(again.code).toEqual(expect.any(String));
      expect(again.hops).toContain('GET 302 /api/public/v1/authorization/oauth2');
      expect(mural.state.codeExchanges).toBe(2);
      const silent = await authorize(base, {
        clientId,
        redirectUri: DCR_REDIRECT,
        jar,
        extra: { prompt: 'none' },
      });
      expect({ error: silent.error, description: silent.errorDescription }).toEqual({
        error: 'interaction_required',
        description: 'every authorization signs in to Mural again',
      });
    });

    it('registers a DCR client as a public code-flow client with refresh by default', async () => {
      await start();
      const res = await fetch(`${base}/reg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [DCR_REDIRECT] }),
      });
      const body = await res.json();
      expect(res.status).toBe(201);
      expect({
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: body.token_endpoint_auth_method,
        id_token_signed_response_alg: body.id_token_signed_response_alg,
      }).toEqual({
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'EdDSA',
      });
      const result = await authorize(base, { clientId: body.client_id, redirectUri: DCR_REDIRECT });
      const tokens = await exchangeCode(base, body.client_id, DCR_REDIRECT, result);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });

    it('keeps refresh tokens alive past the browser session that created them', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      await fakeRedis.redis.del(
        ...[...fakeRedis.keys()].filter((key) => key.startsWith('test:Session')),
      );
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).status).toBe(200);
    });

    it('issues no refresh token to a client registered without the refresh grant', async () => {
      await start();
      const { body } = await registerDcrClient(base, { grant_types: ['authorization_code'] });
      const result = await authorize(base, {
        clientId: body.client_id ?? '',
        redirectUri: DCR_REDIRECT,
      });
      const tokens = await exchangeCode(base, body.client_id ?? '', DCR_REDIRECT, result);
      expect(tokens.status).toBe(200);
      expect(tokens.body.refresh_token).toBeUndefined();
    });

    it('advertises and accepts the code flow only', async () => {
      await start();
      const { body } = await registerDcrClient(base, { response_types: ['code id_token'] });
      expect(body.error).toBe('invalid_client_metadata');
    });

    const forwardedHttpsCookies = async () => {
      const { body } = await registerDcrClient(base);
      const res = await fetch(
        `${base}/auth?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}&response_type=code&scope=mural&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } },
      );
      return new Set(res.headers.getSetCookie().map((c) => /;\s*secure/i.test(c)));
    };

    it('trusts X-Forwarded-Proto behind an HTTPS public URL, so its cookies are Secure', async () => {
      await start({ issuer: 'https://mcp.example.com' });
      expect(await forwardedHttpsCookies()).toEqual(new Set([true]));
    });

    it('ignores X-Forwarded-Proto behind a plain HTTP public URL', async () => {
      await start({ issuer: 'http://mcp.example.com' });
      expect(await forwardedHttpsCookies()).toEqual(new Set([false]));
    });

    it('refuses a provider request from an origin outside the CORS allowlist', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const res = await fetch(`${base}/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: 'nope',
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: `origin https://evil.example not allowed for client: ${clientId}`,
      });
    });

    it('answers CORS preflights, with the headers only for an allowed origin', async () => {
      await start();
      const preflight = (origin: string) =>
        fetch(`${base}/mcp`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        });
      const allowed = await preflight('https://claude.ai');
      expect(allowed.status).toBe(204);
      expect(Object.fromEntries(allowed.headers)).toMatchObject({
        'access-control-allow-origin': 'https://claude.ai',
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers':
          'Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id',
        'access-control-expose-headers': 'mcp-session-id',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      const refused = await preflight('https://evil.example');
      expect(refused.status).toBe(204);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
      expect(refused.headers.get('access-control-allow-methods')).toBeNull();
      const actual = await fetch(`${base}/healthz`, {
        headers: { origin: 'http://localhost:6274' },
      });
      expect(actual.headers.get('access-control-allow-origin')).toBe('http://localhost:6274');
      expect(actual.headers.get('access-control-allow-methods')).toBeNull();
    });

    it('renders an error it cannot send back to the client as an HTML page', async () => {
      await start();
      const res = await fetch(
        `${base}/auth?client_id=unknown&response_type=code&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain(
        '<main><h1>Sign-in failed</h1><p>invalid_client: client is invalid</p></main>',
      );
    });

    it('fetches a client metadata document over HTTPS on the default port only', async () => {
      await start();
      const fetched = async (clientId: string) => {
        cimdRequests.length = 0;
        await authorize(base, { clientId, redirectUri: 'https://tools.example.com/callback' });
        return cimdRequests.length > 0;
      };
      expect(await fetched('https://tools.example.com:8443/oauth/client.json')).toBe(false);
      expect(await fetched('http://tools.example.com/oauth/client.json')).toBe(false);
      expect(await fetched('https://tools.example.com:443/oauth/client.json')).toBe(true);
      expect(await fetched(UNKNOWN)).toBe(true);
    });
  });

  describe('provider protocol', () => {
    const form = (path: string, params: Record<string, string>) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
        body: new URLSearchParams(params),
      });

    it('requires PKCE, from confidential clients too', async () => {
      await start();
      const refusal = async (client: string, redirectUri: string) => {
        const res = await fetch(
          `${base}/auth?client_id=${encodeURIComponent(client)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=mural`,
          { redirect: 'manual' },
        );
        const back = new URL(res.headers.get('location') ?? '', base);
        return [back.searchParams.get('error'), back.searchParams.get('error_description')];
      };
      const expected = [
        'invalid_request',
        'Authorization Server policy requires PKCE to be used for this request',
      ];
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      expect(await refusal(clientId, DCR_REDIRECT)).toEqual(expected);
      expect(await refusal(CHATGPT, CHATGPT_CALLBACK)).toEqual(expected);
    });

    it('defaults the resource to /mcp and issues for the granted one when the token request names none', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const result = await authorize(base, {
        clientId,
        redirectUri: DCR_REDIRECT,
        resource: null,
      });
      const res = await form('/token', {
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: DCR_REDIRECT,
        code: result.code ?? '',
        code_verifier: result.verifier,
      });
      const tokens = await res.json();
      expect(res.status).toBe(200);
      expect((await callMcp(base, tokens.access_token)).status).toBe(200);
      const next = await form('/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      });
      expect(next.status).toBe(200);
      expect((await callMcp(base, (await next.json()).access_token)).status).toBe(200);
    });

    it('revokes a refresh token at the revocation endpoint', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const res = await form('/token/revocation', {
        client_id: clientId,
        token: tokens.body.refresh_token ?? '',
      });
      expect(res.status).toBe(200);
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).body.error).toBe(
        'invalid_grant',
      );
    });

    it('issues an ID token for the Mural account when openid is asked for', async () => {
      await start();
      const result = await authorize(base, {
        clientId: CLAUDE,
        redirectUri: CLAUDE_CALLBACK,
        scope: 'openid mural',
      });
      const tokens = await tokenRequest(base, {
        grant_type: 'authorization_code',
        client_id: CLAUDE,
        redirect_uri: CLAUDE_CALLBACK,
        code: result.code ?? '',
        code_verifier: result.verifier,
      });
      const idToken = (tokens.body as { id_token?: string }).id_token ?? '';
      expect(decodeJwt(idToken)).toMatchObject({
        sub: `mural:${MURAL_USER_ID}`,
        aud: CLAUDE,
        iss: base,
      });
      expect(decodeProtectedHeader(idToken).alg).toBe('EdDSA');
    });

    it('keeps an interaction ten minutes and a browser session twelve hours', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const jar = createCookieJar();
      const lifetimes = new Map<string, number>();
      const record = jar.store;
      jar.store = (res: Response) => {
        for (const cookie of res.headers.getSetCookie()) {
          const expires = /expires=([^;]+)/i.exec(cookie)?.[1];
          if (expires) {
            lifetimes.set(cookie.split('=')[0] ?? '', Date.parse(expires) - Date.now());
          }
        }
        record(res);
      };
      await authorize(base, { clientId, redirectUri: DCR_REDIRECT, jar });
      const minutes = (name: string) => Math.round((lifetimes.get(name) ?? 0) / 60_000);
      expect(minutes('_interaction')).toBe(10);
      expect(minutes('_session')).toBe(12 * 60);
    });

    it('keeps an authorization code one minute and a grant ninety days', async () => {
      await start();
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const now = Date.now();
      await authorize(base, { clientId, redirectUri: DCR_REDIRECT });
      const expiries = [...fakeRedis.keys()]
        .filter((key) => /^test:(AuthorizationCode|Grant):[\w-]{43}$/.test(key))
        .map((key) => [key.split(':')[1], fakeRedis.expiryOf(key)] as const);
      const lifetimeOf = (model: string) => {
        const expiry = expiries.find(([name]) => name === model)?.[1];
        return Math.round(((expiry as number) - now) / 1000);
      };
      expect(lifetimeOf('AuthorizationCode')).toBeGreaterThanOrEqual(59);
      expect(lifetimeOf('AuthorizationCode')).toBeLessThanOrEqual(60);
      expect(Math.round(lifetimeOf('Grant') / 86400)).toBe(90);
    });
  });

  describe('several instances over one store', () => {
    const cimdKey = (clientId: string) =>
      `test:CimdDocument:${createHash('sha256').update(clientId).digest('base64url')}`;

    it('keeps users signed in on another instance with the same secret', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      await start();
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(200);
      expect((await callMcp(base, next.body.access_token)).status).toBe(200);
    });

    it('refreshes on the last good copy when the document host blocks another instance', async () => {
      await start();
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      const tokens = await exchangeCode(base, CLAUDE, CLAUDE_CALLBACK, result);
      // Kept after the token is issued, off the request path.
      await vi.waitFor(() => expect(fakeRedis.keys().has(cimdKey(CLAUDE))).toBe(true));
      await start();
      blockedDocuments.add(CLAUDE);
      cimdRequests.length = 0;
      const next = await refresh(base, CLAUDE, tokens.body.refresh_token ?? '');
      expect(next.status).toBe(200);
      expect(cimdRequests).toContain(CLAUDE);
      expect((await callMcp(base, next.body.access_token)).status).toBe(200);
    });

    it('keeps no document for a client that never got a token', async () => {
      await start();
      await authorize(base, {
        clientId: UNKNOWN,
        redirectUri: 'https://tools.example.com/callback',
      });
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      expect(result.code).toEqual(expect.any(String));
      expect([...fakeRedis.keys()].filter((key) => key.startsWith('test:CimdDocument:'))).toEqual(
        [],
      );
    });

    it('turns a blocked client away when no copy of its document was ever kept', async () => {
      await start();
      blockedDocuments.add(CLAUDE);
      const result = await authorize(base, { clientId: CLAUDE, redirectUri: CLAUDE_CALLBACK });
      expect(result.code).toBeUndefined();
      expect(result.error).toContain('invalid_client');
    });

    it('stores no raw token, no Mural token and no account id', async () => {
      await start();
      const { clientId, tokens } = await signInWithDcr(base);
      const next = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      const raw = fakeRedis.dump();
      for (const secret of [
        tokens.body.refresh_token,
        next.body.refresh_token,
        clientId,
        // Long enough never to turn up by chance in base64url ciphertext.
        'mural-access-',
        'mural-refresh-',
        MURAL_USER_ID,
      ]) {
        expect(raw).not.toContain(secret);
      }
    });

    it('rotates the secret: old tokens work while the old secret is listed, and not after', async () => {
      await start({ secret: OLD });
      const { clientId, tokens } = await signInWithDcr(base);

      await start({ secret: `${NEW},${OLD}` });
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(200);
      const underBoth = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(underBoth.status).toBe(200);

      await start({ secret: NEW });
      expect((await callMcp(base, tokens.body.access_token)).status).toBe(401);
      expect((await callMcp(base, underBoth.body.access_token)).status).toBe(200);
      // The DCR client was re-encrypted when read under both secrets, so it survives.
      expect((await refresh(base, clientId, underBoth.body.refresh_token ?? '')).status).toBe(200);
    });

    it('signs its cookies', async () => {
      await start();
      const { body } = await registerDcrClient(base);
      const res = await fetch(
        `${base}/auth?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(DCR_REDIRECT)}&response_type=code&scope=mural&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
        { redirect: 'manual' },
      );
      const names = res.headers.getSetCookie().map((c) => c.split('=')[0]);
      expect(names).toContain('_interaction');
      expect(names).toContain('_interaction.sig');
    });
  });
});
