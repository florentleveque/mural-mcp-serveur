// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import { renderConsentPage, renderErrorPage } from './consent.js';
import type { Logger } from './log.js';
import type { MuralGrants } from './mural-grants.js';
import {
  buildMuralAuthorizeUrl,
  exchangeMuralCode,
  fetchMuralIdentity,
  generateCodeChallenge,
  generateCodeVerifier,
  isUpstreamAuthError,
  type MuralTokenSet,
  type MuralUpstream,
} from './mural-upstream.js';
import type { SealedCollection } from './store.js';
import { canSkipConsent } from './trusted-clients.js';

// Pending state lives for one sign-in at most: the interaction's own lifetime.
export const PENDING_TTL_S = 10 * 60;
// A remembered consent is asked for again after this long, or as soon as the
// client's redirect URIs change.
export const CONSENT_MEMORY_TTL_S = 90 * 86400;

export interface InteractionDeps {
  readonly provider: Provider;
  readonly upstream: MuralUpstream;
  readonly issuer: string;
  readonly muralGrants: MuralGrants;
  readonly consentMemory: SealedCollection<true>;
  /** PKCE verifiers of the Mural sign-ins in flight, by interaction uid. */
  readonly verifiers: SealedCollection<string>;
  /** Mural tokens of a finished sign-in, until its consent step creates the grant. */
  readonly pendingTokens: SealedCollection<MuralTokenSet>;
  readonly trustedClients: ReadonlySet<string>;
  readonly logger: Logger;
}

const sendHtml = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
};

const redirect = (res: ServerResponse, location: string): void => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
};

const EXPIRED =
  'This sign-in has expired or was opened in another browser. Start the connection again from your MCP client.';
const MURAL_SIGN_IN_EXPIRED = 'The Mural sign-in expired. Try again.';

export const consentMemoryKey = (
  accountId: string,
  clientId: string,
  redirectUris: readonly string[],
): string =>
  createHash('sha256')
    .update(JSON.stringify([accountId, clientId, [...redirectUris].sort()]))
    .digest('base64url');

// oidc-provider throws these on a missing or foreign interaction cookie: an
// expired link, not a server fault.
const isExpiredLink = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'SessionNotFound' || err.name === 'InvalidRequest');

// Uids are nanoids; anything else did not come from oidc-provider.
const UID = /^[\w-]{1,64}$/;

/**
 * The login and consent steps oidc-provider hands off to us. Login is always a
 * round trip to Mural (fresh tokens for every grant); consent is skipped for
 * trusted CIMD clients and for a client this user already approved with the
 * same redirect URIs, and shown otherwise. Every piece of state between two
 * browser hops is in Redis: the next hop may reach another instance.
 */
export const createInteractionRoutes = (deps: InteractionDeps) => {
  const { provider, upstream, issuer, logger } = deps;
  const callbackUrl = `${issuer}/oauth/callback`;

  type Details = Awaited<ReturnType<Provider['interactionDetails']>>;

  const finish = (req: IncomingMessage, res: ServerResponse, result: Record<string, unknown>) =>
    provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });

  const deny = (req: IncomingMessage, res: ServerResponse, description: string) =>
    finish(req, res, { error: 'access_denied', error_description: description });

  const startUpstreamLogin = async (res: ServerResponse, uid: string): Promise<void> => {
    const verifier = generateCodeVerifier();
    await deps.verifiers.set(uid, verifier, PENDING_TTL_S);
    redirect(
      res,
      buildMuralAuthorizeUrl(upstream, {
        redirectUri: callbackUrl,
        state: uid,
        codeChallenge: generateCodeChallenge(verifier),
      }),
    );
  };

  const approve = async (
    req: IncomingMessage,
    res: ServerResponse,
    details: Details,
    { accountId, clientId }: { accountId: string; clientId: string },
    tokens: MuralTokenSet,
  ): Promise<void> => {
    const grant = new provider.Grant({ accountId, clientId });
    const missing = details.prompt.details as {
      missingOIDCScope?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
    if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
    const grantId = await grant.save();
    await deps.muralGrants.save(grantId, tokens);
    await finish(req, res, { consent: { grantId } });
  };

  const consentContext = async (details: Details) => {
    const accountId = String(details.session?.accountId);
    const clientId = String(details.params['client_id']);
    const client = await provider.Client.find(clientId);
    const redirectUris = client?.redirectUris ?? [];
    return {
      client,
      accountId,
      clientId,
      pendingKey: `${accountId}|${clientId}`,
      memoryKey: consentMemoryKey(accountId, clientId, redirectUris),
      redirectUri: String(details.params['redirect_uri']),
      redirectUris,
    };
  };

  const showInteraction = async (req: IncomingMessage, res: ServerResponse, uid: string) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name === 'login') return startUpstreamLogin(res, uid);
    const context = await consentContext(details);
    const skip =
      canSkipConsent(
        {
          clientId: context.clientId,
          redirectUri: context.redirectUri,
          registeredRedirectUris: context.redirectUris,
        },
        deps.trustedClients,
      ) || (await deps.consentMemory.get(context.memoryKey)) === true;
    if (skip) {
      const tokens = await deps.pendingTokens.take(context.pendingKey);
      if (!tokens) return deny(req, res, MURAL_SIGN_IN_EXPIRED);
      return approve(req, res, details, context, tokens);
    }
    sendHtml(
      res,
      200,
      renderConsentPage({
        uid,
        clientName: context.client?.clientName,
        clientId: context.clientId,
        redirectUri: context.redirectUri,
      }),
    );
  };

  const completeUpstreamLogin = async (
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    url: URL,
  ) => {
    const details = await provider.interactionDetails(req, res);
    const verifier = await deps.verifiers.take(uid);
    const code = url.searchParams.get('code');
    if (!verifier || !code) return deny(req, res, 'The Mural sign-in was cancelled or refused.');
    try {
      const tokens = await exchangeMuralCode(upstream, {
        code,
        redirectUri: callbackUrl,
        codeVerifier: verifier,
      });
      const identity = await fetchMuralIdentity(tokens.accessToken);
      const accountId = `mural:${identity.id}`;
      await deps.pendingTokens.set(
        `${accountId}|${String(details.params['client_id'])}`,
        tokens,
        PENDING_TTL_S,
      );
      await finish(req, res, { login: { accountId } });
    } catch (err) {
      if (!isUpstreamAuthError(err)) throw err;
      logger.warn('oauth_upstream_login_failed', { error: err.message });
      await deny(req, res, err.message);
    }
  };

  const confirm = async (req: IncomingMessage, res: ServerResponse) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name !== 'consent') {
      return sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
    }
    const context = await consentContext(details);
    const tokens = await deps.pendingTokens.take(context.pendingKey);
    if (!tokens) return deny(req, res, MURAL_SIGN_IN_EXPIRED);
    await deps.consentMemory.set(context.memoryKey, true, CONSENT_MEMORY_TTL_S);
    return approve(req, res, details, context, tokens);
  };

  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const segments = url.pathname.split('/');
    // Stryker disable next-line StringLiteral: any default the UID pattern rejects gets the same 404.
    const [, , uid = '', action] = segments;
    if (!UID.test(uid)) return sendHtml(res, 404, renderErrorPage('Not found', EXPIRED));
    if (req.method === 'GET' && action === undefined) return showInteraction(req, res, uid);
    if (req.method === 'GET' && action === 'callback') {
      return completeUpstreamLogin(req, res, uid, url);
    }
    if (req.method === 'POST' && action === 'confirm') return confirm(req, res);
    if (req.method === 'POST' && action === 'abort') {
      await provider.interactionDetails(req, res);
      return deny(req, res, 'The user declined access.');
    }
    return sendHtml(res, 404, renderErrorPage('Not found', EXPIRED));
  };

  return {
    /** `/oauth/callback`: the one redirect URI registered at Mural. */
    upstreamCallback: (res: ServerResponse, url: URL): void => {
      // Stryker disable next-line StringLiteral: any default the UID pattern rejects gets the same 400.
      const uid = url.searchParams.get('state') ?? '';
      if (!UID.test(uid)) {
        sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
        return;
      }
      // The interaction cookie is scoped to /interaction/<uid>, so hop there.
      const next = new URL(`/interaction/${uid}/callback`, issuer);
      const code = url.searchParams.get('code');
      if (code) next.searchParams.set('code', code);
      redirect(res, `${next.pathname}${next.search}`);
    },
    /** `/interaction/<uid>[/callback|/confirm|/abort]`. */
    handle: async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
      try {
        await routes(req, res, url);
      } catch (err) {
        if (!isExpiredLink(err)) throw err;
        if (!res.headersSent) sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
      }
    },
  };
};
