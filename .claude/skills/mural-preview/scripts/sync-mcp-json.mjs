// Points the mural-mcp-dev entry of .mcp.json at the Vercel preview of the
// current branch, and makes sure this machine holds a Vercel bypass secret.
// Needs the Vercel CLI signed in with access to the project's team. Run from
// the repository root:
//   node .claude/skills/mural-preview/scripts/sync-mcp-json.mjs [--check]
// --check reports what is missing or stale without changing anything.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  branchAlias,
  desiredEntry,
  latestReadyDeployment,
  loadJson,
  parseEnvFile,
  readBypassSecret,
  SECRET_FILE,
  SECRET_VAR,
  SERVER_NAME,
  syncMcpJson,
  tokenFile,
} from './lib.mjs';

const PROJECT = process.env['MURAL_PREVIEW_VERCEL_PROJECT'] ?? 'mural-mcp-serveur';
const TEAM = process.env['MURAL_PREVIEW_VERCEL_TEAM'] ?? 'goku-ea72';
const checkOnly = process.argv.includes('--check');

const fail = (message) => {
  console.error(`mural-preview: ${message}`);
  process.exit(1);
};
const say = (line) => process.stdout.write(`${line}\n`);

const vercelAuthFile = () =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json')
    : join(
        process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'),
        'com.vercel.cli',
        'auth.json',
      );

const vercelToken = async () => {
  if (process.env['VERCEL_TOKEN']) return process.env['VERCEL_TOKEN'];
  const auth = await loadJson(vercelAuthFile());
  // `expiresAt` is in seconds.
  if (auth?.token && (auth.expiresAt ?? Number.POSITIVE_INFINITY) * 1000 > Date.now() + 60_000) {
    return auth.token;
  }
  try {
    // The CLI renews its own session whenever it runs.
    execFileSync('vercel', ['whoami'], { stdio: 'ignore' });
  } catch {
    fail('no valid Vercel CLI session: run `vercel login`');
  }
  const renewed = await loadJson(vercelAuthFile());
  if (!renewed?.token) fail('no valid Vercel CLI session: run `vercel login`');
  return renewed.token;
};

// Never print a response body: the project and bypass ones list bypass secrets.
const api = async (token, path, init = {}) => {
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('slug', TEAM);
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Vercel API ${url.pathname}: ${res.status} ${body.error?.code ?? ''}`);
  return body;
};

const readMcpJson = async () => {
  let text;
  try {
    text = await readFile('.mcp.json', 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail('.mcp.json is not valid JSON: fix it first');
  }
};

/** Owner-only, the one line replaced: the file may hold other variables. */
const writeSecret = async (secret) => {
  const previous = await readFile(SECRET_FILE, 'utf8').catch(() => '');
  const kept = previous
    .split('\n')
    .filter((line) => line.trim() && !(SECRET_VAR in parseEnvFile(line)));
  await mkdir(dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  await writeFile(SECRET_FILE, `${[...kept, `export ${SECRET_VAR}=${secret}`].join('\n')}\n`, {
    mode: 0o600,
  });
};

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (branch === 'HEAD') fail('detached HEAD: check out a branch');

const token = await vercelToken();
const { deployments = [] } = await api(
  token,
  `/v6/deployments?app=${encodeURIComponent(PROJECT)}&target=preview&limit=100`,
);
const deployment = latestReadyDeployment(deployments, branch);
if (!deployment)
  fail(`no ready Vercel preview for ${branch}: push the branch, wait for its deployment`);
const { alias = [] } = await api(token, `/v13/deployments/${deployment.uid}`);
const host = branchAlias(alias);
if (!host) fail(`the preview of ${branch} has no alias yet: wait for its deployment`);
const origin = `https://${host}`;

if (await readBypassSecret()) say('Vercel bypass secret: present');
else if (checkOnly) say(`Vercel bypass secret: missing from ${SECRET_FILE}`);
else {
  // The API takes exactly 32 alphanumerics.
  const secret = randomBytes(16).toString('hex');
  const project = await api(token, `/v9/projects/${encodeURIComponent(PROJECT)}`);
  await api(token, `/v1/projects/${project.id}/protection-bypass`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ generate: { secret, note: 'mural-preview skill' } }),
  });
  await writeSecret(secret);
  say(`Vercel bypass secret: created in ${SECRET_FILE}`);
}

const { changed, next } = syncMcpJson(await readMcpJson(), desiredEntry(host));
if (!changed) say(`.mcp.json: ${SERVER_NAME} already points at ${origin}/mcp`);
else if (checkOnly) say(`.mcp.json: ${SERVER_NAME} should point at ${origin}/mcp`);
else {
  await writeFile('.mcp.json', `${JSON.stringify(next, null, 2)}\n`);
  say(`.mcp.json: ${SERVER_NAME} now points at ${origin}/mcp (commit it on this branch)`);
}

say(
  (await loadJson(tokenFile(origin)))
    ? `sign-in: done for ${origin}`
    : `sign-in: needed for ${origin}, run sign-in.mjs`,
);
