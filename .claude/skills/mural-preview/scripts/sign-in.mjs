// Signs this machine in to the branch preview named by .mcp.json: registers an
// OAuth client (DCR), runs the authorization-code flow with PKCE through the
// browser, and stores the tokens headers.mjs then renews. Every request carries
// the Vercel bypass header. Run from the repository root:
//   node .claude/skills/mural-preview/scripts/sign-in.mjs [--no-open]
// --no-open only prints the address, for a browser driven another way.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  bypassHeaders,
  readBypassSecret,
  SERVER_NAME,
  saveJson,
  storedTokens,
  tokenFile,
  withLock,
} from './lib.mjs';

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const WSL_KERNEL = /microsoft/i;
const HTML_SPECIAL = /[&<>"']/g;

const fail = (message) => {
  console.error(`mural-preview: ${message}`);
  process.exit(1);
};

const escapeHtml = (text) => text.replace(HTML_SPECIAL, (c) => `&#${c.charCodeAt(0)};`);

const page = (title, text) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${escapeHtml(text)}</p></html>`;

const isWsl = () => {
  try {
    return WSL_KERNEL.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
};

const openBrowser = (url) => {
  const browser = process.env['BROWSER'];
  let command = ['xdg-open', url];
  if (browser) command = [browser, url];
  else if (process.platform === 'darwin') command = ['open', url];
  else if (process.platform === 'win32') command = ['cmd', '/c', 'start', '', url];
  else if (isWsl())
    command = ['powershell.exe', '-NoProfile', '-Command', `Start-Process '${url}'`];
  const [cmd, ...args] = command;
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () =>
      console.error('mural-preview: could not open a browser, open the address yourself'),
    )
    .unref();
};

const config = JSON.parse(await readFile('.mcp.json', 'utf8').catch(() => '{}'));
const entryUrl = config.mcpServers?.[SERVER_NAME]?.url;
if (!entryUrl?.startsWith('https://'))
  fail(`no ${SERVER_NAME} entry in .mcp.json: run sync-mcp-json.mjs first`);
const origin = new URL(entryUrl).origin;
const secret = await readBypassSecret();
if (!secret) fail('no Vercel bypass secret: run sync-mcp-json.mjs first');

const preview = (path, init) =>
  fetch(`${origin}${path}`, { ...init, headers: { ...bypassHeaders(secret), ...init.headers } });

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const registration = await preview('/reg', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'mural-preview skill (Claude Code)',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }),
});
const client = await registration.json().catch(() => ({}));
if (!client.client_id)
  fail(`client registration failed: ${registration.status} ${client.error ?? ''}`);

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('base64url');
const authorization = new URL(`${origin}/auth`);
for (const [key, value] of Object.entries({
  client_id: client.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'mural',
  state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  resource: `${origin}/mcp`,
})) {
  authorization.searchParams.set(key, value);
}

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('no sign-in within 5 minutes')),
    SIGN_IN_TIMEOUT_MS,
  );
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirectUri);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    clearTimeout(timer);
    const received = url.searchParams.get('state') === state ? url.searchParams.get('code') : null;
    const problem = `${url.searchParams.get('error') ?? 'invalid callback'} ${url.searchParams.get('error_description') ?? ''}`;
    res
      .writeHead(received ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        received
          ? page('Signed in', 'You can close this tab and go back to Claude Code.')
          : page('Sign-in failed', problem),
      );
    if (received) resolve(received);
    else reject(new Error(problem.trim()));
  });
  process.stdout.write(`Sign in at: ${authorization}\n`);
  if (!process.argv.includes('--no-open')) openBrowser(authorization.toString());
})
  .catch((err) => fail(err.message))
  .finally(() => {
    // The browser keeps its connection alive, which would hold the process open.
    server.closeAllConnections();
    server.close();
  });

const exchange = await preview('/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  }),
});
const body = await exchange.json().catch(() => ({}));
if (!body.access_token) fail(`token exchange failed: ${exchange.status} ${body.error ?? ''}`);

const file = tokenFile(origin);
const tokens = storedTokens({ clientId: client.client_id }, body, Date.now());
await withLock(file, () => saveJson(file, tokens));

const check = await preview('/mcp', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${tokens.accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mural-preview', version: '1' },
    },
  }),
});
if (!check.ok) fail(`signed in, but ${origin}/mcp answered ${check.status}`);
process.stdout.write(`Signed in to ${origin}. Reconnect ${SERVER_NAME} with /mcp.\n`);
