// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpResponse, http } from 'msw';
import type Provider from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_MEMORY_TTL_S,
  consentMemoryKey,
  createInteractionRoutes,
  type InteractionDeps,
  PENDING_TTL_S,
} from '../../../src/auth/interactions.js';
import { deriveKeyRing } from '../../../src/auth/keys.js';
import type { Logger } from '../../../src/auth/log.js';
import { MURAL_SCOPES, type MuralTokenSet } from '../../../src/auth/mural-upstream.js';
import { createRedisStore } from '../../../src/auth/record-store.js';
import { createSealedCollection, hashId } from '../../../src/auth/store.js';
import { createMuralOAuthMock, MURAL_CLIENT, MURAL_USER_ID, mswServer, useMsw } from '../msw.js';
import { createFakeRedis } from './fake-redis.js';

useMsw();

/**
 * The interaction routes against a scripted stand-in for oidc-provider: each
 * test sets what `interactionDetails` answers and reads back what the routes
 * handed to `interactionFinished`, the Grant and the stores. Mural is MSW.
 */

const ISSUER = 'https://mcp.example.com';
const RESOURCE = `${ISSUER}/mcp`;
const TRUSTED = 'https://trusted.example/client.json';
const TRUSTED_REDIRECT = 'https://trusted.example/callback';
const DCR = 'dcr-client';
const DCR_REDIRECT = 'http://127.0.0.1:9/callback';
const ACCOUNT = `mural:${MURAL_USER_ID}`;
const EXPIRED =
  'This sign-in has expired or was opened in another browser. Start the connection again from your MCP client.';
const MURAL_EXPIRED = {
  error: 'access_denied',
  error_description: 'The Mural sign-in expired. Try again.',
};

interface Details {
  prompt: { name: string; details: Record<string, unknown> };
  params: Record<string, unknown>;
  session?: { accountId: string };
}

interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writes: number;
  writeHead(status: number, headers?: Record<string, string>): FakeResponse;
  end(body?: string): void;
}

const fakeRes = (): FakeResponse => ({
  status: 0,
  headers: {},
  body: '',
  headersSent: false,
  writes: 0,
  writeHead(status, headers = {}) {
    if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    this.writes += 1;
    return this;
  },
  end(body = '') {
    this.body = body;
  },
});

const REQ = {} as IncomingMessage;
const asRes = (res: FakeResponse) => res as unknown as ServerResponse;

interface GrantRecord {
  accountId: string;
  clientId: string;
  oidc: string[];
  resources: [string, string][];
}

function FakeGrant(init: { accountId: string; clientId: string }) {
  const record: GrantRecord = { ...init, oidc: [], resources: [] };
  fake.grants.push(record);
  return {
    addOIDCScope: (scope: string) => record.oidc.push(scope),
    addResourceScope: (indicator: string, scope: string) =>
      record.resources.push([indicator, scope]),
    save: async () => `grant-${fake.grants.length}`,
  };
}

const fake = {
  details: undefined as Details | Error | undefined,
  finished: [] as [Record<string, unknown>, unknown][],
  finishError: undefined as Error | undefined,
  grants: [] as GrantRecord[],
  clients: {} as Record<string, { redirectUris: string[]; clientName?: string }>,
};

const provider = {
  interactionDetails: async (_req: unknown, res: FakeResponse) => {
    if (fake.details instanceof Error) {
      if ('writeFirst' in fake.details) res.writeHead(500);
      throw fake.details;
    }
    return fake.details;
  },
  interactionFinished: async (
    _req: unknown,
    res: FakeResponse,
    result: Record<string, unknown>,
    options: unknown,
  ) => {
    const error = fake.finishError;
    fake.finishError = undefined;
    if (error) throw error;
    fake.finished.push([result, options]);
    res.writeHead(303, { Location: '/auth/resumed' });
    res.end();
  },
  Grant: FakeGrant,
  Client: { find: async (id: string) => fake.clients[id] },
} as unknown as Provider;

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

const ring = deriveKeyRing(Buffer.alloc(32, 4).toString('base64'));

const build = (overrides: Partial<InteractionDeps> = {}) => {
  const saved: [string, MuralTokenSet][] = [];
  const fakeRedis = createFakeRedis();
  const store = createRedisStore(fakeRedis.redis, 'test');
  const consent = createSealedCollection<true>(store, 'Consent', ring);
  const { logger, events } = recordingLogger();
  const routes = createInteractionRoutes({
    provider,
    upstream: MURAL_CLIENT,
    issuer: ISSUER,
    muralGrants: {
      save: async (grantId, tokens) => {
        saved.push([grantId, tokens]);
      },
      freshTokens: async () => ({ accessToken: 'unused', expiresAt: 0 }),
      remove: async () => undefined,
    },
    consentMemory: consent,
    verifiers: createSealedCollection<string>(store, 'PkceVerifier', ring),
    pendingTokens: createSealedCollection<MuralTokenSet>(store, 'PendingMuralTokens', ring),
    trustedClients: new Set([TRUSTED]),
    logger,
    ...overrides,
  });
  return { routes, saved, consent, events, fakeRedis };
};

const at = (path: string) => new URL(path, ISSUER);

const loginPrompt = (clientId: string): Details => ({
  prompt: { name: 'login', details: {} },
  params: { client_id: clientId },
});

const consentPrompt = (clientId: string, redirectUri: string, details = {}): Details => ({
  prompt: {
    name: 'consent',
    details: { missingResourceScopes: { [RESOURCE]: ['mural'] }, ...details },
  },
  params: { client_id: clientId, redirect_uri: redirectUri },
  session: { accountId: ACCOUNT },
});

type Routes = ReturnType<typeof build>['routes'];

const get = async (routes: Routes, path: string) => {
  const res = fakeRes();
  await routes.handle({ ...REQ, method: 'GET' } as IncomingMessage, asRes(res), at(path));
  return res;
};

const post = async (routes: Routes, path: string) => {
  const res = fakeRes();
  await routes.handle({ ...REQ, method: 'POST' } as IncomingMessage, asRes(res), at(path));
  return res;
};

/** Login step, Mural round trip, callback: the upstream tokens end up pending. */
const signIn = async (routes: Routes, uid: string, clientId: string) => {
  fake.details = loginPrompt(clientId);
  const start = await get(routes, `/interaction/${uid}`);
  const mural = await fetch(start.headers['Location'] ?? '', { redirect: 'manual' });
  const hop = fakeRes();
  routes.upstreamCallback(asRes(hop), new URL(mural.headers.get('location') ?? ''));
  return { start, hop, callback: await get(routes, hop.headers['Location'] ?? '') };
};

describe('createInteractionRoutes', () => {
  let mural: ReturnType<typeof createMuralOAuthMock>;
  let now = 1_700_000_000_000;

  beforeEach(() => {
    fake.details = undefined;
    fake.finished = [];
    fake.finishError = undefined;
    fake.grants = [];
    fake.clients = {
      [TRUSTED]: { redirectUris: [TRUSTED_REDIRECT], clientName: 'Trusted Tool' },
      [DCR]: { redirectUris: [DCR_REDIRECT], clientName: 'DCR <Tool>' },
    };
    now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mural = createMuralOAuthMock();
    mswServer.use(...mural.handlers);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('login', () => {
    it('sends the browser to Mural with PKCE, our callback and every scope', async () => {
      const { routes, fakeRedis } = build();
      fake.details = loginPrompt(DCR);
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(302);
      expect(res.headers['Cache-Control']).toBe('no-store');
      const location = new URL(res.headers['Location'] ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(
        'https://app.mural.co/api/public/v1/authorization/oauth2',
      );
      const params = Object.fromEntries(location.searchParams);
      expect(params['code_challenge']).toMatch(/^[\w-]{43}$/);
      expect({ ...params, code_challenge: '<challenge>' }).toEqual({
        client_id: 'mural-client-id',
        code_challenge: '<challenge>',
        code_challenge_method: 'S256',
        redirect_uri: 'https://mcp.example.com/oauth/callback',
        response_type: 'code',
        scope: MURAL_SCOPES.join(' '),
        state: 'uid-1',
      });
      expect(PENDING_TTL_S).toBe(600);
      expect(fakeRedis.expiryOf(`test:PkceVerifier:${hashId('uid-1')}`)).toBe(now + 600_000);
    });

    it('hops from the Mural callback to the interaction, carrying only the code and the scopes', () => {
      const { routes } = build();
      const withCode = fakeRes();
      routes.upstreamCallback(
        asRes(withCode),
        at('/oauth/callback?code=m-1&scopes=murals%3Aread%20rooms%3Aread&state=uid-1&x=y'),
      );
      expect(withCode.status).toBe(302);
      expect(withCode.headers).toEqual({
        Location: '/interaction/uid-1/callback?code=m-1&scopes=murals%3Aread+rooms%3Aread',
        'Cache-Control': 'no-store',
      });
      const scopesOnly = fakeRes();
      routes.upstreamCallback(asRes(scopesOnly), at('/oauth/callback?scopes=x&state=uid-1'));
      expect(scopesOnly.headers['Location']).toBe('/interaction/uid-1/callback?scopes=x');
      const withoutCode = fakeRes();
      routes.upstreamCallback(asRes(withoutCode), at('/oauth/callback?error=denied&state=uid-1'));
      expect(withoutCode.headers['Location']).toBe('/interaction/uid-1/callback');
    });

    it('answers a Mural callback without a usable state with an error page', () => {
      const { routes } = build();
      for (const query of ['?code=x', '?code=x&state=%2F%2Fevil.example']) {
        const res = fakeRes();
        routes.upstreamCallback(asRes(res), at(`/oauth/callback${query}`));
        expect(res.status).toBe(400);
        expect(res.headers).toEqual({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        expect(res.body).toContain('<h1>Sign-in failed</h1>');
        expect(res.body).toContain(EXPIRED);
      }
    });

    it('finishes the login as the Mural user, keeping the earlier submission', async () => {
      const { routes, fakeRedis } = build();
      const { callback } = await signIn(routes, 'uid-1', DCR);
      expect(callback.status).toBe(303);
      expect(fake.finished).toEqual([
        [{ login: { accountId: ACCOUNT } }, { mergeWithLastSubmission: true }],
      ]);
      expect(mural.state.codeExchanges).toBe(1);
      expect(mural.state.tokenRequests[0]?.get('redirect_uri')).toBe(
        'https://mcp.example.com/oauth/callback',
      );
      expect(fakeRedis.expiryOf(`test:PendingMuralTokens:${hashId(`${ACCOUNT}|${DCR}`)}`)).toBe(
        now + 600_000,
      );
    });

    it.each([
      [
        'the callback reports',
        { grantedScopes: 'murals:read rooms:read' },
        ['murals:read', 'rooms:read'],
      ],
      [
        'the token answer reports, over the callback',
        { grantedScopes: 'murals:read', tokenScope: 'rooms:read' },
        ['rooms:read'],
      ],
      ['none, when Mural reports none', { grantedScopes: null }, undefined],
    ])('keeps with the Mural tokens the scopes %s', async (_label, options, scopes) => {
      mswServer.use(...createMuralOAuthMock(options).handlers);
      const { routes, saved } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT);
      await get(routes, '/interaction/uid-1');
      expect(saved).toHaveLength(1);
      expect(saved[0]?.[1].scopes).toEqual(scopes);
    });

    it('refuses a callback without a code, or one no login step started', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      await get(routes, '/interaction/uid-1');
      await get(routes, '/interaction/uid-1/callback');
      await get(routes, '/interaction/uid-2/callback?code=m-1');
      const refused = {
        error: 'access_denied',
        error_description: 'The Mural sign-in was cancelled or refused.',
      };
      expect(fake.finished.map(([result]) => result)).toEqual([refused, refused]);
      expect(mural.state.tokenRequests).toHaveLength(0);
    });

    it('uses a verifier once only', async () => {
      const { routes } = build();
      const { hop } = await signIn(routes, 'uid-1', DCR);
      await get(routes, hop.headers['Location'] ?? '');
      expect(fake.finished[1]?.[0]).toEqual({
        error: 'access_denied',
        error_description: 'The Mural sign-in was cancelled or refused.',
      });
    });

    it('forgets a verifier once the ten-minute interaction lifetime is over', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      const callbackFor = async (uid: string) => {
        const start = await get(routes, `/interaction/${uid}`);
        const back = await fetch(start.headers['Location'] ?? '', { redirect: 'manual' });
        const hop = fakeRes();
        routes.upstreamCallback(asRes(hop), new URL(back.headers.get('location') ?? ''));
        return hop.headers['Location'] ?? '';
      };
      const inTime = await callbackFor('uid-1');
      const late = await callbackFor('uid-2');
      now += 10 * 60 * 1000 - 1;
      await get(routes, inTime);
      expect(fake.finished[0]?.[0]).toEqual({ login: { accountId: ACCOUNT } });
      now += 1;
      await get(routes, late);
      expect(fake.finished[1]?.[0]).toMatchObject({ error: 'access_denied' });
    });

    it('turns a Mural refusal into access_denied and logs it', async () => {
      mswServer.use(
        http.post('https://app.mural.co/api/public/v1/authorization/oauth2/token', () =>
          HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
        ),
      );
      const { routes, events } = build();
      await signIn(routes, 'uid-1', DCR);
      const description = 'Mural refused the authorization_code grant (400).';
      expect(fake.finished).toEqual([
        [
          { error: 'access_denied', error_description: description },
          { mergeWithLastSubmission: true },
        ],
      ]);
      expect(events).toEqual([['warn', 'oauth_upstream_login_failed', { error: description }]]);
    });

    it('lets any other failure through', async () => {
      const { routes, events } = build();
      fake.finishError = new Error('provider down');
      await expect(signIn(routes, 'uid-1', DCR)).rejects.toThrow('provider down');
      expect(fake.finished).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  describe('consent', () => {
    it('skips the screen for a trusted client on its own HTTPS redirect, with the pending tokens', async () => {
      const { routes, saved, events, fakeRedis } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT, { missingOIDCScope: [] });
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(303);
      expect(fake.grants).toEqual([
        { accountId: ACCOUNT, clientId: TRUSTED, oidc: [], resources: [[RESOURCE, 'mural']] },
      ]);
      expect(saved.map(([grantId, tokens]) => [grantId, tokens.accessToken])).toEqual([
        ['grant-1', 'mural-access-2'],
      ]);
      expect(fake.finished[1]).toEqual([
        { consent: { grantId: 'grant-1' } },
        { mergeWithLastSubmission: true },
      ]);
      expect(events).toEqual([]);
      expect([...fakeRedis.keys()].some((key) => key.startsWith('test:Consent:'))).toBe(false);
      // Taken: a second consent step cannot reuse the Mural sign-in.
      await get(routes, '/interaction/uid-1');
      expect(fake.finished[2]?.[0]).toEqual(MURAL_EXPIRED);
    });

    it('grants the missing OIDC scopes and resource scopes it is asked for', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT, {
        missingOIDCScope: ['openid', 'offline_access'],
        missingResourceScopes: { [RESOURCE]: ['mural', 'other'] },
      });
      await get(routes, '/interaction/uid-1');
      expect(fake.grants[0]).toMatchObject({
        oidc: ['openid offline_access'],
        resources: [[RESOURCE, 'mural other']],
      });
    });

    it('grants nothing more when the prompt names no missing scope', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      fake.details = {
        ...consentPrompt(TRUSTED, TRUSTED_REDIRECT),
        prompt: { name: 'consent', details: {} },
      };
      await get(routes, '/interaction/uid-1');
      expect(fake.grants[0]).toMatchObject({ oidc: [], resources: [] });
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
    });

    it('denies a skipped consent whose Mural sign-in is no longer pending', async () => {
      const { routes, saved } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      now += 10 * 60 * 1000;
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT);
      await get(routes, '/interaction/uid-1');
      expect(fake.finished[1]?.[0]).toEqual(MURAL_EXPIRED);
      expect(saved).toEqual([]);
    });

    it('keeps the pending tokens for ten minutes', async () => {
      const { routes, saved } = build();
      await signIn(routes, 'uid-1', TRUSTED);
      now += 10 * 60 * 1000 - 1;
      fake.details = consentPrompt(TRUSTED, TRUSTED_REDIRECT);
      await get(routes, '/interaction/uid-1');
      expect(saved).toHaveLength(1);
    });

    it('shows the screen to an untrusted client, naming it and its redirect', async () => {
      const { routes } = build();
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(200);
      expect(res.headers).toEqual({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      expect(res.body).toContain('<h1>Allow DCR &lt;Tool&gt; to use your Mural account?</h1>');
      expect(res.body).toContain(
        'sent back to 127.0.0.1:9 (<code>http://127.0.0.1:9/callback</code>)',
      );
      expect(res.body).toContain('action="/interaction/uid-1/confirm"');
      expect(fake.grants).toEqual([]);
    });

    it('names the client by its id when the client is gone', async () => {
      const { routes } = build();
      fake.details = {
        prompt: { name: 'consent', details: {} },
        params: { client_id: 'gone', redirect_uri: DCR_REDIRECT },
        session: { accountId: ACCOUNT },
      };
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<h1>Allow gone to use your Mural account?</h1>');
    });

    it('skips the screen for a client this user already approved with the same redirect URIs', async () => {
      const { routes, consent } = build();
      await consent.set(consentMemoryKey(ACCOUNT, DCR, [DCR_REDIRECT]), true);
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(303);
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
    });

    it('remembers an approval for ninety days, then grants', async () => {
      const { routes, consent, fakeRedis, saved } = build();
      await signIn(routes, 'uid-1', DCR);
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await post(routes, '/interaction/uid-1/confirm');
      expect(res.status).toBe(303);
      expect(CONSENT_MEMORY_TTL_S).toBe(7_776_000);
      const key = consentMemoryKey(ACCOUNT, DCR, [DCR_REDIRECT]);
      expect(await consent.get(key)).toBe(true);
      expect(fakeRedis.expiryOf(`test:Consent:${hashId(key)}`)).toBe(now + 7_776_000_000);
      expect(fake.finished[1]?.[0]).toEqual({ consent: { grantId: 'grant-1' } });
      expect(saved.map(([grantId]) => grantId)).toEqual(['grant-1']);
    });

    it('refuses a confirmation whose Mural sign-in is no longer pending, remembering nothing', async () => {
      const { routes, consent } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      await post(routes, '/interaction/uid-1/confirm');
      expect(await consent.get(consentMemoryKey(ACCOUNT, DCR, [DCR_REDIRECT]))).toBeUndefined();
      expect(fake.finished[0]?.[0]).toEqual(MURAL_EXPIRED);
    });

    it('looks a client that is gone up in the consent memory under no redirect URI', async () => {
      const { routes, consent } = build();
      await consent.set(consentMemoryKey(ACCOUNT, 'gone', []), true);
      fake.details = consentPrompt('gone', DCR_REDIRECT);
      const res = await get(routes, '/interaction/uid-1');
      // Remembered, so no consent page: straight to the (here expired) sign-in check.
      expect(res.status).toBe(303);
      expect(fake.finished[0]?.[0]).toEqual(MURAL_EXPIRED);
    });

    it('refuses a confirmation without a session instead of failing', async () => {
      const { routes } = build();
      fake.details = { ...consentPrompt(DCR, DCR_REDIRECT), session: undefined };
      await post(routes, '/interaction/uid-1/confirm');
      expect(fake.finished[0]?.[0]).toMatchObject({ error: 'access_denied' });
    });

    it('answers a confirmation outside the consent step with an error page', async () => {
      const { routes } = build();
      fake.details = loginPrompt(DCR);
      const res = await post(routes, '/interaction/uid-1/confirm');
      expect(res.status).toBe(400);
      expect(res.headers['Content-Type']).toBe('text/html; charset=utf-8');
      expect(res.body).toContain('<h1>Sign-in failed</h1>');
      expect(res.body).toContain(EXPIRED);
      expect(fake.finished).toEqual([]);
    });

    it('sends a refusal back as access_denied', async () => {
      const { routes } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const res = await post(routes, '/interaction/uid-1/abort');
      expect(res.status).toBe(303);
      expect(fake.finished).toEqual([
        [
          { error: 'access_denied', error_description: 'The user declined access.' },
          { mergeWithLastSubmission: true },
        ],
      ]);
    });
  });

  describe('routing', () => {
    it('answers anything but the four interaction routes with a 404 page', async () => {
      const { routes } = build();
      fake.details = consentPrompt(DCR, DCR_REDIRECT);
      const responses = [
        await get(routes, '/interaction/not%20a%20uid'),
        await get(routes, '/interaction/'),
        await post(routes, '/interaction/uid-1'),
        await post(routes, '/interaction/uid-1/callback'),
        await get(routes, '/interaction/uid-1/confirm'),
        await get(routes, '/interaction/uid-1/abort'),
        await post(routes, '/interaction/uid-1/whatever'),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.headers).toEqual({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        expect(res.body).toContain('<h1>Not found</h1>');
        expect(res.body).toContain(EXPIRED);
      }
      expect(fake.finished).toEqual([]);
    });

    it('answers an expired or foreign interaction cookie with an error page', async () => {
      const { routes } = build();
      for (const name of ['SessionNotFound', 'InvalidRequest']) {
        fake.details = Object.assign(new Error('gone'), { name });
        const res = await get(routes, '/interaction/uid-1');
        expect(res.status).toBe(400);
        expect(res.body).toContain('<h1>Sign-in failed</h1>');
      }
    });

    it('leaves a response alone once the provider has started it', async () => {
      const { routes } = build();
      fake.details = Object.assign(new Error('gone'), {
        name: 'SessionNotFound',
        writeFirst: true,
      });
      const res = await get(routes, '/interaction/uid-1');
      expect(res.status).toBe(500);
      expect(res.writes).toBe(1);
    });

    it('lets any other error through, even one named like an expired link', async () => {
      const { routes } = build();
      fake.details = Object.assign(new Error('boom'), { name: 'TypeError' });
      await expect(get(routes, '/interaction/uid-1')).rejects.toThrow('boom');
      const impostor = { name: 'SessionNotFound' };
      fake.details = undefined;
      vi.spyOn(provider, 'interactionDetails').mockRejectedValueOnce(impostor);
      await expect(get(routes, '/interaction/uid-1')).rejects.toBe(impostor);
    });
  });
});

describe('consentMemoryKey', () => {
  it('hashes the account, the client and the redirect URIs in any order', () => {
    const key = consentMemoryKey('mural:1', 'c', ['https://b/cb', 'https://a/cb']);
    expect(key).toBe(
      createHash('sha256')
        .update(JSON.stringify(['mural:1', 'c', ['https://a/cb', 'https://b/cb']]))
        .digest('base64url'),
    );
    expect(consentMemoryKey('mural:1', 'c', ['https://a/cb', 'https://b/cb'])).toBe(key);
    expect(consentMemoryKey('mural:1', 'c', ['https://a/cb'])).not.toBe(key);
    expect(consentMemoryKey('mural:2', 'c', ['https://b/cb', 'https://a/cb'])).not.toBe(key);
  });
});
