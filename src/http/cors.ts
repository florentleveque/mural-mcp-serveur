// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import type { NextFunction, Request, Response } from 'express';

// The major web MCP clients, reachable through Custom Connector UIs. Native
// clients (Claude Desktop, Claude Code, Cursor, VS Code, Zed) send no Origin
// header, so they are unaffected.
export const BROWSER_MCP_CLIENT_ORIGINS: readonly string[] = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://copilot.microsoft.com',
  'https://www.perplexity.ai',
  'https://chat.mistral.ai',
  'https://grok.com',
];

const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS =
  'Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id';
const CORS_EXPOSE_HEADERS = 'mcp-session-id';
const CORS_MAX_AGE = '600';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * The origin to reflect in `Access-Control-Allow-Origin`, or `undefined`.
 * Never the raw `Origin` header: an entry of the constant allowlist, or a
 * loopback origin rebuilt from validated URL parts, the shape CodeQL's
 * `js/cors-misconfiguration-for-credentials` rule recognises as safe.
 */
export const resolveAllowedOrigin = (origin: string): string | undefined => {
  const listed = BROWSER_MCP_CLIENT_ORIGINS.find((entry) => entry === origin);
  if (listed) return listed;
  if (!URL.canParse(origin)) return undefined;
  const url = new URL(origin);
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || !LOCALHOST_HOSTNAMES.has(url.hostname)) {
    return undefined;
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port}`;
};

export const isAllowedOrigin = (origin: string): boolean =>
  resolveAllowedOrigin(origin) !== undefined;

/**
 * CORS for every route: allowed origins get the headers on their actual
 * requests, and a preflight is answered here. A preflight from any other
 * origin still gets its 204, without the headers, so the browser blocks it.
 */
export const cors = (req: Request, res: Response, next: NextFunction): void => {
  const origin = req.headers.origin;
  const allowed = origin ? resolveAllowedOrigin(origin) : undefined;
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
  }
  if (req.method !== 'OPTIONS') {
    next();
    return;
  }
  if (allowed) {
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', CORS_MAX_AGE);
  }
  res.status(204).end();
};
