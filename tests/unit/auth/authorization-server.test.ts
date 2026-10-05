// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createServer, type Server } from 'node:http';
import { CompactEncrypt, decodeProtectedHeader } from 'jose';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthorizationServer,
  createAuthorizationServer,
} from '../../../src/auth/authorization-server.js';
import { deriveKeyRing } from '../../../src/auth/keys.js';
import type { Logger } from '../../../src/auth/log.js';
import { ACCESS_TOKEN_TTL_S, providerErrorPage } from '../../../src/auth/provider.js';
import { createRedisStore, type RecordStore } from '../../../src/auth/record-store.js';
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
  DCR_REDIRECT,
  exchangeCode,
  refresh,
  registerDcrClient,
  signInWithDcr,
} from '../oauth-client.js';
import { createFakeRedis } from './fake-redis.js';

useMsw();

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

const RING = deriveKeyRing(Buffer.alloc(32, 7).toString('base64'));
const ISSUER = 'https://mcp.example.com';

/** A store over the fake Redis whose operations on matching keys can be made to fail. */
const faultyStore = () => {
  const fake = createFakeRedis();
  const inner = createRedisStore(fake.redis, 'test');
  const faults = { failing: undefined as string | undefined, error: new Error('store down') };
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (faults.failing && args.some((arg) => String(arg).startsWith(`${faults.failing}:`))) {
        throw faults.error;
      }
      return fn(...args);
    };
  const store: RecordStore = {
    get: guard(inner.get),
    take: guard(inner.take),
    set: guard(inner.set),
    setIfAbsent: guard(inner.setIfAbsent),
    delete: guard(inner.delete),
    addMember: guard(inner.addMember),
    members: guard(inner.members),
  };
  const collectionOf = (key: string) => /^test:(.+):[\w-]{43}$/.exec(key)?.[1];
  return {
    store,
    faults,
    fake,
    collections: () =>
      [...new Set([...fake.keys()].map(collectionOf))].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
  };
};

const build = (store: RecordStore, logger?: Logger, issuer = ISSUER) =>
  createAuthorizationServer({
    issuer,
    ring: RING,
    store,
    upstream: MURAL_CLIENT,
    isAllowedOrigin: () => false,
    logger,
  });

const forge = (issuer: string, claims: Record<string, unknown>) =>
  new CompactEncrypt(
    new TextEncoder().encode(
      JSON.stringify({
        iss: issuer,
        aud: `${issuer}/mcp`,
        exp: Math.floor(Date.now() / 1000) + 60,
        mt: 'mural-token',
        gid: 'g-1',
        sub: 'mural:1',
        client_id: 'c-1',
        scope: 'mural',
        ...claims,
      }),
    ),
  )
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: RING[0].accessToken.kid })
    .encrypt(RING[0].accessToken.key);

describe('providerErrorPage', () => {
  it('names the error and its description', () => {
    expect(
      providerErrorPage({ error: 'invalid_client', error_description: 'client is invalid' }),
    ).toContain('<p>invalid_client: client is invalid</p>');
  });

  it('explains an error that comes without a description', () => {
    expect(providerErrorPage({ error: 'access_denied' })).toContain(
      '<main><h1>Sign-in failed</h1><p>access_denied: the authorization request was rejected</p></main>',
    );
  });
});

describe('createAuthorizationServer', () => {
  it('names the resource after the issuer, with its one scope', () => {
    const as = build(faultyStore().store);
    expect(as.issuer).toBe(ISSUER);
    expect(as.resource).toBe('https://mcp.example.com/mcp');
    expect(as.protectedResourceMetadata).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://mcp.example.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mural'],
    });
  });

  it('rejects anything that is not one of its tokens', async () => {
    const as = build(faultyStore().store);
    for (const bearer of ['', 'mural-access-1', 'a.b.c.d.e', 'eyJhbGciOiJkaXIifQ.x.y.z.w']) {
      expect(await as.verifyAccessToken(bearer)).toBeUndefined();
    }
    const foreign = await new CompactEncrypt(new TextEncoder().encode('{}'))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: 'someone-else' })
      .encrypt(RING[0].atRest.key);
    expect(await as.verifyAccessToken(foreign)).toBeUndefined();
  });

  it('reads a token encrypted under an older secret while the ring still lists it', async () => {
    const OLDER = Buffer.alloc(32, 8).toString('base64');
    const older = deriveKeyRing(OLDER);
    const token = await new CompactEncrypt(
      new TextEncoder().encode(
        JSON.stringify({
          iss: ISSUER,
          aud: `${ISSUER}/mcp`,
          exp: Math.floor(Date.now() / 1000) + 60,
          mt: 'mural-token',
          gid: 'g-1',
        }),
      ),
    )
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: older[0].accessToken.kid })
      .encrypt(older[0].accessToken.key);
    const rotating = createAuthorizationServer({
      issuer: ISSUER,
      ring: deriveKeyRing(`${Buffer.alloc(32, 7).toString('base64')},${OLDER}`),
      store: faultyStore().store,
      upstream: MURAL_CLIENT,
      isAllowedOrigin: () => false,
    });
    expect(await rotating.verifyAccessToken(token)).toMatchObject({ grantId: 'g-1' });
    expect(await build(faultyStore().store).verifyAccessToken(token)).toBeUndefined();
  });

  it('never rejects when revoking a grant fails in the store, and logs why', async () => {
    const { store, faults } = faultyStore();
    faults.failing = 'RevokedGrant';
    const { logger, events } = recordingLogger();
    await expect(build(store, logger).revokeGrant('g-1')).resolves.toBeUndefined();
    expect(events).toEqual([['error', 'oauth_grant_revoke_failed', { error: 'store down' }]]);
  });

  it('logs a store failure that is not an Error as its string', async () => {
    const { store, faults } = faultyStore();
    faults.failing = 'Grant';
    faults.error = 'socket closed' as unknown as Error;
    const { logger, events } = recordingLogger();
    await build(store, logger).revokeGrant('g-1');
    expect(events).toEqual([['error', 'oauth_grant_revoke_failed', { error: 'socket closed' }]]);
  });

  it('revokes a grant it does not know without failing', async () => {
    const { logger, events } = recordingLogger();
    await build(faultyStore().store, logger).revokeGrant('unknown');
    expect(events).toEqual([]);
  });

  describe('verifyAccessToken', () => {
    afterEach(() => vi.restoreAllMocks());

    it('hands back what the token carries', async () => {
      const as = build(faultyStore().store);
      const exp = Math.floor(Date.now() / 1000) + 60;
      expect(await as.verifyAccessToken(await forge(ISSUER, { exp }))).toEqual({
        muralAccessToken: 'mural-token',
        grantId: 'g-1',
        clientId: 'c-1',
        subject: 'mural:1',
        scopes: ['mural'],
        expiresAt: exp,
      });
      expect(
        await as.verifyAccessToken(await forge(ISSUER, { aud: ['https://x', `${ISSUER}/mcp`] })),
      ).toMatchObject({ grantId: 'g-1' });
    });

    it('reads the scope as a list, and none from anything but a string', async () => {
      const as = build(faultyStore().store);
      const scopesOf = async (scope: unknown) =>
        (await as.verifyAccessToken(await forge(ISSUER, { scope })))?.scopes;
      expect(await scopesOf('mural  offline_access')).toEqual(['mural', 'offline_access']);
      expect(await scopesOf('')).toEqual([]);
      expect(await scopesOf(['mural'])).toEqual([]);
      expect(await scopesOf(undefined)).toEqual([]);
    });

    it('rejects a token for another issuer or audience, or without what it must carry', async () => {
      const as = build(faultyStore().store);
      for (const claims of [
        { exp: String(Math.floor(Date.now() / 1000) + 60) },
        { exp: undefined },
        { mt: 42 },
        { mt: undefined },
        { gid: undefined },
        { gid: 7 },
        { aud: undefined },
        { aud: 'https://mcp.example.com/other' },
        { aud: ['https://elsewhere.example/mcp'] },
        { iss: undefined },
        { iss: 'https://elsewhere.example' },
      ]) {
        expect(await as.verifyAccessToken(await forge(ISSUER, claims))).toBeUndefined();
      }
    });

    it('rejects a token from its expiry second on', async () => {
      const as = build(faultyStore().store);
      const token = await forge(ISSUER, { exp: 2_000_000_000 });
      vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000 - 1);
      expect(await as.verifyAccessToken(token)).toMatchObject({ expiresAt: 2_000_000_000 });
      vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
      expect(await as.verifyAccessToken(token)).toBeUndefined();
    });

    it('refuses a revoked grant for one access-token lifetime, and only that grant', async () => {
      const as = build(faultyStore().store);
      const revoked = await forge(ISSUER, { gid: 'g-1', exp: 2_000_000_000 });
      const other = await forge(ISSUER, { gid: 'g-2', exp: 2_000_000_000 });
      const start = 1_900_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(start);
      await as.revokeGrant('g-1');
      await as.revokeGrant('g-3');
      expect(await as.verifyAccessToken(revoked)).toBeUndefined();
      expect(await as.verifyAccessToken(other)).toMatchObject({ grantId: 'g-2' });
      expect(ACCESS_TOKEN_TTL_S).toBe(600);
      vi.spyOn(Date, 'now').mockReturnValue(start + 600 * 1000 - 1);
      expect(await as.verifyAccessToken(revoked)).toBeUndefined();
      vi.spyOn(Date, 'now').mockReturnValue(start + 600 * 1000);
      expect(await as.verifyAccessToken(revoked)).toMatchObject({ grantId: 'g-1' });
    });
  });

  describe('over HTTP', () => {
    let server: Server | undefined;
    let base = '';
    let mural: ReturnType<typeof createMuralOAuthMock>;

    const serve = async (store: RecordStore, logger?: Logger): Promise<AuthorizationServer> => {
      let as: AuthorizationServer | undefined;
      server = createServer((req, res) => {
        void as?.handle(req, res).catch(() => {
          res.statusCode = 599;
          res.end();
        });
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      as = build(store, logger, base);
      return as;
    };

    const useMural = (accessTtlSeconds?: number) => {
      mural = createMuralOAuthMock(accessTtlSeconds === undefined ? {} : { accessTtlSeconds });
      mswServer.use(localServerPassthrough, ...mural.handlers);
    };

    beforeEach(() => useMural());
    afterEach(async () => {
      vi.restoreAllMocks();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    });

    it('mints encrypted tokens that carry the grant and the signed-in Mural user', async () => {
      const as = await serve(faultyStore().store);
      const { clientId, tokens } = await signInWithDcr(base);
      const access = tokens.body.access_token ?? '';
      expect(decodeProtectedHeader(access)).toMatchObject({ alg: 'dir', enc: 'A256GCM' });
      const verified = await as.verifyAccessToken(access);
      expect(verified).toEqual({
        muralAccessToken: 'mural-access-2',
        grantId: expect.any(String),
        clientId,
        subject: `mural:${MURAL_USER_ID}`,
        scopes: ['mural'],
        expiresAt: expect.any(Number),
      });
      const lifetime = (verified?.expiresAt ?? 0) - Date.now() / 1000;
      expect(lifetime).toBeGreaterThan(590);
      expect(lifetime).toBeLessThanOrEqual(600);
      expect(tokens.body.refresh_token).toEqual(expect.any(String));
    });

    it('keeps every record in Redis, in named collections', async () => {
      const store = faultyStore();
      await serve(store.store);
      await signInWithDcr(base);
      expect(store.collections()).toEqual([
        'AuthorizationCode',
        'AuthorizationCode:consumed',
        'AuthorizationCode:grant',
        'Client',
        'Consent',
        'Grant',
        'MuralTokens',
        'RefreshToken',
        'RefreshToken:grant',
        'RegistrationAccessToken',
        'Session',
        'Session:uid',
      ]);
    });

    it('ends a revoked grant: its tokens, its refresh token and its Mural tokens', async () => {
      const store = faultyStore();
      const { logger, events } = recordingLogger();
      const as = await serve(store.store, logger);
      const { clientId, tokens } = await signInWithDcr(base);
      const kept = await signInWithDcr(base);
      const { grantId } = (await as.verifyAccessToken(tokens.body.access_token ?? '')) ?? {};
      await as.revokeGrant(grantId ?? '');
      expect(events).toEqual([]);
      expect(await as.verifyAccessToken(tokens.body.access_token ?? '')).toBeUndefined();
      expect((await refresh(base, clientId, tokens.body.refresh_token ?? '')).body.error).toBe(
        'invalid_grant',
      );
      expect(await as.verifyAccessToken(kept.tokens.body.access_token ?? '')).toBeDefined();
      expect(
        (await refresh(base, kept.clientId, kept.tokens.body.refresh_token ?? '')).status,
      ).toBe(200);
    });

    it('drops the Mural tokens and refuses the access tokens of a grant revoked on a refresh-token replay', async () => {
      const store = faultyStore();
      const as = await serve(store.store);
      const { clientId, tokens } = await signInWithDcr(base);
      const access = tokens.body.access_token ?? '';
      await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(store.collections()).toContain('MuralTokens');
      const replay = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(replay.body.error).toBe('invalid_grant');
      // Inside the replayed request, not after it: nothing left to wait for.
      expect(store.collections()).not.toContain('MuralTokens');
      expect(store.collections()).toContain('RevokedGrant');
      expect(await as.verifyAccessToken(access)).toBeUndefined();
    });

    it('answers a store failure while minting a token with a server error, and logs it', async () => {
      const store = faultyStore();
      const { logger, events } = recordingLogger();
      await serve(store.store, logger);
      const clientId = (await registerDcrClient(base)).body.client_id ?? '';
      const result = await authorize(base, { clientId, redirectUri: DCR_REDIRECT });
      store.faults.failing = 'MuralTokens';
      const tokens = await exchangeCode(base, clientId, DCR_REDIRECT, result);
      expect(tokens.status).toBe(500);
      expect(tokens.body.error).toBe('server_error');
      expect(events).toContainEqual(['error', 'oauth_server_error', { error: 'store down' }]);
    });

    it('refuses a refresh whose Mural authorization is gone, so the client signs in again', async () => {
      await serve(faultyStore().store);
      const { clientId, tokens } = await signInWithDcr(base);
      mural.revokeAllAccess();
      mswServer.use(
        http.post('https://app.mural.co/api/public/v1/authorization/oauth2/token', () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // Push the Mural token inside the refresh margin.
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 300_000);
      const refused = await refresh(base, clientId, tokens.body.refresh_token ?? '');
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_grant');
    });

    it('refreshes a Mural token that would lapse within our access-token lifetime', async () => {
      useMural(ACCESS_TOKEN_TTL_S + 60);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await serve(faultyStore().store);
      await signInWithDcr(base);
      expect(mural.state.refreshes).toBe(1);
    });

    it('keeps a Mural token that outlives our access token by the refresh margin', async () => {
      useMural(ACCESS_TOKEN_TTL_S + 60 + 5);
      await serve(faultyStore().store);
      await signInWithDcr(base);
      expect(mural.state.refreshes).toBe(0);
    });

    it('fetches client metadata documents with the global fetch unless told otherwise', async () => {
      const clientId = 'https://tools.example.com/oauth/client.json';
      mswServer.use(
        http.get(clientId, () =>
          HttpResponse.json({
            client_id: clientId,
            client_name: 'Some Tool',
            redirect_uris: ['https://tools.example.com/callback'],
            token_endpoint_auth_method: 'none',
          }),
        ),
      );
      await serve(faultyStore().store);
      const result = await authorize(base, {
        clientId,
        redirectUri: 'https://tools.example.com/callback',
      });
      expect(result.consentShown).toBe(true);
      expect(result.code).toEqual(expect.any(String));
    });

    it('leaves a non-GET request on the Mural callback path to the provider', async () => {
      await serve(faultyStore().store);
      const res = await fetch(`${base}/oauth/callback?state=abc&code=x`, {
        method: 'POST',
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    });

    it('serves its discovery document with DCR, CIMD, PKCE S256 and its one scope', async () => {
      await serve(faultyStore().store);
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      expect({
        issuer: meta.issuer,
        registration_endpoint: meta.registration_endpoint,
        client_id_metadata_document_supported: meta.client_id_metadata_document_supported,
        code_challenge_methods_supported: meta.code_challenge_methods_supported,
        response_types_supported: meta.response_types_supported,
        scopes_supported: meta.scopes_supported,
        userinfo_endpoint: meta.userinfo_endpoint,
      }).toEqual({
        issuer: base,
        registration_endpoint: `${base}/reg`,
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'],
        scopes_supported: ['mural', 'offline_access', 'openid'],
        userinfo_endpoint: undefined,
      });
    });
  });
});
