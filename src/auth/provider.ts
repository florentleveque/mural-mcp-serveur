// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import Provider, {
  type Configuration,
  type ErrorOut,
  errors,
  interactionPolicy,
} from 'oidc-provider';
import type { CimdDocuments } from './cimd-documents.js';
import { renderErrorPage } from './consent.js';
import type { KeyRing } from './keys.js';
import { isGrantUnavailableError, type MuralGrants } from './mural-grants.js';

// Our access token carries the Mural access token, which lives 900 s: ours
// must die first. Minted only from a Mural token with at least this long plus
// the refresh margin left (src/auth/mural-grants.ts), so with Mural's 900 s a
// token is reused for up to 240 s, then every refresh of ours refreshes Mural's.
export const ACCESS_TOKEN_TTL_S = 600;
export const GRANT_TTL_S = 90 * 86400;
// A browser sign-in, remembered across authorizations of the same browser.
const SESSION_TTL_S = 12 * 3600;
const INTERACTION_TTL_S = 10 * 60;

/**
 * The one scope of the MCP resource: every tool, on the user's behalf, with
 * the Mural permissions the consent page lists. `offline_access` is for
 * clients (ChatGPT) that ask for it.
 */
export const RESOURCE_SCOPE = 'mural';

export interface ProviderOptions {
  readonly issuer: string;
  /** The canonical `/mcp` resource: the only audience our tokens carry. */
  readonly resource: string;
  readonly ring: KeyRing;
  readonly adapter: NonNullable<Configuration['adapter']>;
  readonly muralGrants: MuralGrants;
  /** CORS for the provider's own endpoints: the same allowlist as `/mcp`. */
  readonly isAllowedOrigin: (origin: string) => boolean;
  /** Fetches CIMD documents. oidc-provider's SSRF guard rides in the options it passes. */
  readonly cimdDocuments: CimdDocuments;
}

// Every authorization goes through Mural, even with a live browser session:
// each grant needs its own fresh Mural tokens. The check lets the login that
// just happened in this very authorization through, or it would loop.
const policyWithUpstreamLogin = () => {
  const policy = interactionPolicy.base();
  // Stryker disable next-line OptionalChaining: the base policy always has a login prompt.
  policy.get('login')?.checks.add(
    new interactionPolicy.Check(
      // Stryker disable next-line StringLiteral: the reason only reaches prompt.reasons, which nothing reads.
      'upstream_login_required',
      'every authorization signs in to Mural again',
      (ctx) =>
        ctx.oidc.result?.['login'] === undefined
          ? interactionPolicy.Check.REQUEST_PROMPT
          : interactionPolicy.Check.NO_NEED_TO_PROMPT,
    ),
  );
  return policy;
};

/** The page oidc-provider shows when it cannot send the error back to the client. */
export const providerErrorPage = (out: ErrorOut): string =>
  renderErrorPage(
    'Sign-in failed',
    `${out.error}: ${out.error_description ?? 'the authorization request was rejected'}`,
  );

export const buildProvider = (options: ProviderOptions): Provider => {
  const { ring, resource } = options;
  const [current] = ring;

  const provider = new Provider(options.issuer, {
    adapter: options.adapter,
    // Never the library defaults: DEV_KEYSTORE is public and empty cookie keys
    // leave cookies unsigned.
    jwks: { keys: ring.map((set) => set.signingJwk) },
    cookies: { keys: ring.map((set) => set.cookieKey) },
    clients: [],
    fetch: options.cimdDocuments.fetch,
    scopes: [RESOURCE_SCOPE, 'offline_access'],
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // The only signing key is Ed25519; the RS256 default makes DCR fail.
      id_token_signed_response_alg: 'EdDSA',
    },
    // Authorization code only: no implicit or hybrid flow to advertise or accept.
    responseTypes: ['code'],
    clientAuthMethods: ['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post'],
    clientBasedCORS: (_ctx, origin) => options.isAllowedOrigin(origin),
    pkce: { required: () => true },
    // Refresh tokens without `offline_access`: MCP clients do not all ask for it.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_S,
      AuthorizationCode: 60,
      Grant: GRANT_TTL_S,
      Interaction: INTERACTION_TTL_S,
      RefreshToken: GRANT_TTL_S,
      Session: SESSION_TTL_S,
    },
    features: {
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: our router takes every /interaction/ path first.
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        // SSRF (special-use IPs, redirects, size, time) is guarded by the
        // library's fetch; this only pins the scheme and port.
        allowFetch: async (_ctx, clientId) => {
          const url = new URL(clientId);
          // Stryker disable next-line ConditionalExpression,BooleanLiteral: oidc-provider only fetches https:
          // ids, so this is defence in depth; its always-refuse sibling is killed.
          if (url.protocol !== 'https:') return false;
          // WHATWG URL drops an explicit :443, so any port left is a non-default one.
          return url.port === '';
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        // Stryker disable next-line BooleanLiteral: with one resource, the default names the one the grant holds.
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return {
            scope: RESOURCE_SCOPE,
            audience: resource,
            accessTokenTTL: ACCESS_TOKEN_TTL_S,
            accessTokenFormat: 'jwt',
            // Encrypt-only: authenticated encryption with a symmetric key needs
            // no separate signature, and hides the Mural token inside.
            jwt: {
              encrypt: {
                alg: 'dir',
                enc: 'A256GCM',
                key: current.accessToken.key,
                kid: current.accessToken.kid,
              },
            },
          };
        },
      },
    },
    extraTokenClaims: async (_ctx, token) => {
      // Stryker disable next-line ConditionalExpression,LogicalOperator: only code-flow access tokens are minted
      // here, each with its grant; the always-skip sibling is killed.
      if (token.kind !== 'AccessToken' || !token.grantId) return undefined;
      try {
        const mural = await options.muralGrants.freshTokens(token.grantId);
        return {
          mt: mural.accessToken,
          gid: token.grantId,
          ...(mural.scopes ? { ms: mural.scopes.join(' ') } : {}),
        };
      } catch (err) {
        if (isGrantUnavailableError(err)) {
          // Stryker disable next-line ObjectLiteral: detail and cause only reach oidc-provider's debug log.
          throw new errors.InvalidGrant({
            // Stryker disable next-line StringLiteral: only reaches oidc-provider's debug log.
            detail: 'the Mural authorization behind this grant is no longer valid',
            cause: err,
          });
        }
        throw err;
      }
    },
    findAccount: async (_ctx, sub) => ({
      accountId: sub,
      // Stryker disable next-line ArrowFunction,ObjectLiteral: the ID token's sub comes from accountId,
      // and no other claim is ever released (no userinfo, no profile scope).
      claims: async () => ({ sub }),
    }),
    // A fresh grant per authorization, created by our consent step with the
    // Mural tokens of that very sign-in: never one remembered by the session.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.['consent']?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: policyWithUpstreamLogin(),
    },
    renderError: async (ctx, out) => {
      // Stryker disable next-line StringLiteral: with the type cleared, koa infers html from the '<' body.
      ctx.type = 'html';
      ctx.body = providerErrorPage(out);
    },
  });
  // Vercel terminates TLS: trust its X-Forwarded-* headers, or every URL the
  // provider builds and every cookie it sets would say http.
  provider.proxy = options.issuer.startsWith('https:');
  return provider;
};
