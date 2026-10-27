// Starts the built app the way `pnpm dev:http` does and checks what a client
// sees before signing in: health, OAuth discovery, and the 401 that sends it
// to sign in. Dummy credentials: none of these requests reaches Mural or Redis.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const port = 3999;
const base = `http://localhost:${port}`;

const server = spawn(process.execPath, ['scripts/dev-http.mjs'], {
  env: {
    PATH: process.env['PATH'],
    PORT: String(port),
    KV_REST_API_URL: 'https://redis.invalid',
    KV_REST_API_TOKEN: 'smoke',
    MURAL_CLIENT_ID: 'smoke',
    MURAL_CLIENT_SECRET: 'smoke',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  },
  stdio: ['ignore', 'inherit', 'pipe'],
});

const listening = new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('The server did not start within 10 s.')),
    10_000,
  );
  server.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    if (String(chunk).includes('Mural MCP server on')) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on('exit', (code) => reject(new Error(`The server exited with code ${code}.`)));
});

const failures = [];
const check = (label, ok) => {
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

try {
  await listening;

  const health = await fetch(`${base}/healthz`);
  check('/healthz answers 200 ok', health.status === 200 && (await health.json()).status === 'ok');

  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  check(
    'protected resource metadata names /mcp and this authorization server',
    resource.resource === `${base}/mcp` && resource.authorization_servers?.[0] === base,
  );

  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  check(
    'authorization server metadata: issuer, PKCE S256, DCR, CIMD',
    as.issuer === base &&
      as.code_challenge_methods_supported?.includes('S256') &&
      typeof as.registration_endpoint === 'string' &&
      as.client_id_metadata_document_supported === true,
  );

  const mcp = await fetch(`${base}/mcp`, { method: 'POST' });
  check(
    '/mcp without a token answers 401 pointing at the resource metadata',
    mcp.status === 401 &&
      (mcp.headers.get('www-authenticate') ?? '').includes(
        `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      ),
  );
} catch (err) {
  check(String(err instanceof Error ? err.message : err), false);
} finally {
  server.kill();
}

if (failures.length > 0) process.exit(1);
