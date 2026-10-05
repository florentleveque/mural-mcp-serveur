import { toNodeHandler } from '@modelcontextprotocol/node';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  type AuthorizationServer,
  createAuthorizationServer,
  type VerifiedAccessToken,
} from './auth/authorization-server.js';
import { deriveKeyRing } from './auth/keys.js';
import { consoleLogger, type Logger } from './auth/log.js';
import { MURAL_SCOPES } from './auth/mural-upstream.js';
import { openRedisStore } from './auth/record-store.js';
import { cors, isAllowedOrigin } from './http/cors.js';
import { MuralClient } from './mural-client.js';
import { createMcpServer } from './server.js';
import type { MuralTokenProvider } from './types.js';

// RFC 9728 section 3.1: the metadata of `<issuer>/mcp` lives at
// `<issuer>/.well-known/oauth-protected-resource/mcp`. The bare path is served
// too, for clients that probe it first.
const PROTECTED_RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
];

// ASCII only: it rides in the WWW-Authenticate header, where node:http
// rejects anything else with a 500 instead of the 401.
const MISSING_BEARER_MESSAGE =
  'Missing or invalid access token. Sign in through this server: its OAuth ' +
  'authorization server is named in the protected resource metadata.';

const TRAILING_SLASHES = /\/+$/;

const REVOKED_MESSAGE =
  'Mural no longer accepts the authorization behind this connection. Sign in again.';

export const extractBearer = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice('bearer '.length).trim() || undefined;
};

/**
 * The Mural token of one MCP request. Mural answering 401 to it means the
 * user's authorization is gone (our tokens never outlive the Mural one they
 * carry): the grant ends, so the client's next request signs in again.
 */
export const requestTokenProvider = (
  token: VerifiedAccessToken,
  revokeGrant: (grantId: string) => Promise<void>,
): MuralTokenProvider => {
  let revoked = false;
  return {
    getValidAccessToken: async () => {
      if (revoked) throw new Error(REVOKED_MESSAGE);
      return token.muralAccessToken;
    },
    getScopes: async () => [...MURAL_SCOPES],
    invalidateAccessToken: async () => {
      revoked = true;
      await revokeGrant(token.grantId);
    },
  };
};

interface RequestAuth {
  readonly token: VerifiedAccessToken;
}

export interface AppOptions {
  readonly authorizationServer: AuthorizationServer;
  readonly logger?: Logger | undefined;
}

/**
 * The whole server: `/mcp` behind our bearer tokens, the protected-resource
 * metadata, `/healthz`, and the authorization server on every other path. No
 * body parser anywhere: oidc-provider and the MCP handler each read the raw
 * request themselves.
 */
export const createApp = ({
  authorizationServer: as,
  logger = consoleLogger,
}: AppOptions): Express => {
  const app = express();
  app.disable('x-powered-by');

  const metadataUrl = `${as.issuer}${PROTECTED_RESOURCE_PATHS[0]}`;
  const unauthorized = (res: Response): void => {
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="${MISSING_BEARER_MESSAGE}"`,
      )
      .json({ jsonrpc: '2.0', error: { code: -32000, message: MISSING_BEARER_MESSAGE }, id: null });
  };

  // A fresh McpServer and MuralClient per request, over the token it carries.
  const mcp = toNodeHandler(
    createMcpHandler(({ authInfo }) => {
      // Set by the /mcp route below on every request it lets through.
      const { token } = (authInfo as AuthInfo).extra as unknown as RequestAuth;
      const revokeGrant = (grantId: string) => as.revokeGrant(grantId);
      return createMcpServer({
        client: new MuralClient(requestTokenProvider(token, revokeGrant)),
        clearAuthentication: () => revokeGrant(token.grantId),
      });
    }),
  );

  app.use(cors);
  app.get(PROTECTED_RESOURCE_PATHS, (_req, res) => {
    res.json(as.protectedResourceMetadata);
  });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.all('/mcp', async (req, res) => {
    // Every request carries its own token: there is no session to trust.
    const bearer = extractBearer(req);
    const token = bearer ? await as.verifyAccessToken(bearer) : undefined;
    if (!bearer || !token) {
      unauthorized(res);
      return;
    }
    const auth: AuthInfo = {
      token: bearer,
      clientId: token.clientId,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      resource: new URL(as.resource),
      extra: { token } satisfies RequestAuth as unknown as Record<string, unknown>,
    };
    await mcp(Object.assign(req, { auth }), res);
  });
  // Discovery, /auth, /token, /reg, /jwks, the interactions and the Mural callback.
  app.use((req, res) => as.handle(req, res));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    logger.error('http_request_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Too late for a status: Express's own handler closes the connection.
    // Stryker disable next-line ConditionalExpression,BlockStatement: without it the status write throws, and Express's handler closes the connection all the same.
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: 'server_error' });
  });
  return app;
};

/**
 * The public base URL, our issuer: `PUBLIC_URL` when set, else the Vercel
 * address clients are given (the production domain, or the branch's stable
 * preview address), else the local `vercel dev` one.
 */
export const resolveIssuer = (env: NodeJS.ProcessEnv): string => {
  const explicit = env['PUBLIC_URL']?.replace(TRAILING_SLASHES, '');
  if (explicit) return explicit;
  const host =
    env['VERCEL_ENV'] === 'production'
      ? env['VERCEL_PROJECT_PRODUCTION_URL']
      : (env['VERCEL_BRANCH_URL'] ?? env['VERCEL_URL']);
  return host ? `https://${host}` : 'http://localhost:3000';
};

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
};

/** The app of this deployment, from its environment. */
export const createAppFromEnv = (env: NodeJS.ProcessEnv): Express =>
  createApp({
    authorizationServer: createAuthorizationServer({
      issuer: resolveIssuer(env),
      ring: deriveKeyRing(required(env, 'TOKEN_ENCRYPTION_KEY')),
      store: openRedisStore(env),
      upstream: {
        clientId: required(env, 'MURAL_CLIENT_ID'),
        clientSecret: required(env, 'MURAL_CLIENT_SECRET'),
      },
      isAllowedOrigin,
    }),
  });

// Vercel's Express preset deploys this default export. Built on the first
// request, so importing the module needs no environment.
let deployed: Express | undefined;
const app: Express = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  deployed ??= createAppFromEnv(process.env);
  deployed(req, res, next);
});

// biome-ignore lint/style/noDefaultExport: Vercel's Express preset deploys the module's default export.
export default app;
