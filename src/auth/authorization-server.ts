// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import type { AdapterFactory } from 'oidc-provider';
import { type CimdLastGood, createCimdDocuments } from './cimd-documents.js';
import { createInteractionRoutes } from './interactions.js';
import type { KeyRing } from './keys.js';
import { consoleLogger, type Logger } from './log.js';
import { createMuralGrants, MURAL_REFRESH_MARGIN_MS } from './mural-grants.js';
import { type MuralTokenSet, type MuralUpstream, parseScopeList } from './mural-upstream.js';
import { ACCESS_TOKEN_TTL_S, buildProvider, RESOURCE_SCOPE } from './provider.js';
import type { RecordStore } from './record-store.js';
import { createAdapterFactory, createSealedCollection } from './store.js';
import { type Fetch, TRUSTED_CLIENTS } from './trusted-clients.js';

export interface VerifiedAccessToken {
  readonly muralAccessToken: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly subject: string;
  readonly scopes: string[];
  /** The scopes Mural granted, when it reported them. */
  readonly muralScopes?: string[] | undefined;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: string[];
  readonly bearer_methods_supported: string[];
  readonly scopes_supported: string[];
}

export interface AuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  readonly protectedResourceMetadata: ProtectedResourceMetadata;
  /** Every route that is neither `/mcp`, the protected-resource metadata nor `/healthz`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Our JWE, decrypted and checked (issuer, audience, expiry, revocation), or `undefined`. */
  verifyAccessToken(bearer: string): Promise<VerifiedAccessToken | undefined>;
  /**
   * End a grant: its access tokens are refused from now on, its refresh tokens
   * and Mural tokens are deleted. Never rejects.
   */
  revokeGrant(grantId: string): Promise<void>;
}

export interface AuthorizationServerOptions {
  /** The public base URL (no trailing slash): our issuer. */
  readonly issuer: string;
  readonly ring: KeyRing;
  readonly store: RecordStore;
  readonly upstream: MuralUpstream;
  readonly isAllowedOrigin: (origin: string) => boolean;
  readonly logger?: Logger | undefined;
  /** Base fetch for CIMD documents (tests). */
  readonly fetch?: Fetch | undefined;
}

const decoder = new TextDecoder();

interface AccessTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  client_id?: unknown;
  scope?: unknown;
  mt?: unknown;
  gid?: unknown;
  ms?: unknown;
}

const asVerified = (
  claims: AccessTokenClaims,
  issuer: string,
  resource: string,
): VerifiedAccessToken | undefined => {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const valid =
    claims.iss === issuer &&
    audiences.includes(resource) &&
    typeof claims.exp === 'number' &&
    claims.exp * 1000 > Date.now() &&
    typeof claims.mt === 'string' &&
    typeof claims.gid === 'string';
  if (!valid) return undefined;
  return {
    muralAccessToken: claims.mt as string,
    grantId: claims.gid as string,
    clientId: String(claims.client_id),
    subject: String(claims.sub),
    scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
    muralScopes: parseScopeList(claims.ms),
    expiresAt: claims.exp as number,
  };
};

export const createAuthorizationServer = (
  options: AuthorizationServerOptions,
): AuthorizationServer => {
  const { issuer, ring, store, upstream } = options;
  const logger = options.logger ?? consoleLogger;
  const resource = `${issuer}/mcp`;

  const muralGrants = createMuralGrants({
    records: createSealedCollection<MuralTokenSet>(store, 'MuralTokens', ring),
    store,
    upstream,
    // A token we mint carries the Mural token for its whole life.
    refreshMarginMs: ACCESS_TOKEN_TTL_S * 1000 + MURAL_REFRESH_MARGIN_MS,
  });

  // Access tokens are stateless JWEs: a grant that ends leaves a denial behind
  // until the last token it issued would have expired anyway.
  const revokedGrants = createSealedCollection<true>(store, 'RevokedGrant', ring);
  const deny = (grantId: string) => revokedGrants.set(grantId, true, ACCESS_TOKEN_TTL_S);

  // However a grant ends (our revocation, a refresh-token replay, the
  // revocation endpoint), oidc-provider destroys its Grant record, inside the
  // request: the denial and the Mural tokens go with it there, where a
  // fire-and-forget event handler could be cut short by the function freezing.
  const baseAdapter = createAdapterFactory(store, ring);
  const adapter: AdapterFactory = (name) => {
    const model = baseAdapter(name);
    if (name !== 'Grant') return model;
    return {
      ...model,
      destroy: async (grantId) => {
        await deny(grantId);
        await model.destroy(grantId);
        await muralGrants.remove(grantId);
      },
    };
  };

  const cimdDocuments = createCimdDocuments(
    options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    {
      lastGood: createSealedCollection<CimdLastGood>(store, 'CimdDocument', ring),
      logger,
    },
  );
  const provider = buildProvider({
    issuer,
    resource,
    ring,
    adapter,
    muralGrants,
    isAllowedOrigin: options.isAllowedOrigin,
    cimdDocuments,
  });
  // A token issued: a user signed in with this client, so its document is worth
  // keeping. Best effort: a copy lost to a frozen function is only a cache miss.
  provider.on('grant.success', (ctx) => {
    // Stryker disable next-line ConditionalExpression: the token endpoint authenticates a client before it emits this.
    if (ctx.oidc.client) void cimdDocuments.granted(ctx.oidc.client);
  });
  provider.on('server_error', (_ctx, err) => {
    logger.error('oauth_server_error', { error: err.message });
  });

  const interactions = createInteractionRoutes({
    provider,
    upstream,
    issuer,
    muralGrants,
    consentMemory: createSealedCollection<true>(store, 'Consent', ring),
    // Stryker disable next-line StringLiteral: a collection name only has to differ from the others'.
    verifiers: createSealedCollection<string>(store, 'PkceVerifier', ring),
    // Stryker disable next-line StringLiteral: a collection name only has to differ from the others'.
    pendingTokens: createSealedCollection<MuralTokenSet>(store, 'PendingMuralTokens', ring),
    trustedClients: TRUSTED_CLIENTS,
    logger,
  });
  const callback = provider.callback();

  // Rejects on anything that is not one of our JWEs.
  const readAccessToken = async (bearer: string): Promise<VerifiedAccessToken | undefined> => {
    const { kid } = decodeProtectedHeader(bearer);
    const keySet = ring.find((set) => set.accessToken.kid === kid);
    // Stryker disable next-line ConditionalExpression: without it, reading the missing key set throws
    // into the same undefined; the always-refuse sibling is killed.
    if (!keySet) return undefined;
    const { plaintext } = await compactDecrypt(bearer, keySet.accessToken.key);
    return asVerified(JSON.parse(decoder.decode(plaintext)) as AccessTokenClaims, issuer, resource);
  };

  return {
    issuer,
    resource,
    protectedResourceMetadata: {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [RESOURCE_SCOPE],
    },
    handle: async (req, res) => {
      // Stryker disable next-line StringLiteral: a request reaching a node:http server always has req.url.
      const url = new URL(req.url ?? '/', issuer);
      if (url.pathname === '/oauth/callback' && req.method === 'GET') {
        interactions.upstreamCallback(res, url);
        return;
      }
      if (url.pathname.startsWith('/interaction/')) {
        await interactions.handle(req, res, url);
        return;
      }
      await callback(req, res);
    },
    verifyAccessToken: async (bearer) => {
      const verified = await readAccessToken(bearer).catch(() => undefined);
      if (!verified) return undefined;
      return (await revokedGrants.get(verified.grantId)) ? undefined : verified;
    },
    revokeGrant: async (grantId) => {
      try {
        // The denial first: the grant's tokens stop working even if the rest fails.
        await deny(grantId);
        await Promise.all([
          provider.Grant.adapter.destroy(grantId),
          provider.RefreshToken.adapter.revokeByGrantId(grantId),
        ]);
      } catch (err) {
        logger.error('oauth_grant_revoke_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
};
