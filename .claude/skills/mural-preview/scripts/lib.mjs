// Shared by the mural-preview scripts: where the bypass secret and the preview
// tokens live, and the decisions the scripts take. See ../SKILL.md.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const CONFIG_DIR = join(homedir(), '.config', 'mural-mcp-serveur');
export const SECRET_FILE = join(CONFIG_DIR, 'dev.env');
export const SECRET_VAR = 'VERCEL_AUTOMATION_BYPASS_SECRET';
export const BYPASS_HEADER = 'x-vercel-protection-bypass';
export const SERVER_NAME = 'mural-mcp-dev';
export const HELPER_COMMAND = 'node .claude/skills/mural-preview/scripts/headers.mjs';
/** Renew this long before expiry, so a token never dies in the middle of a call. */
export const REFRESH_MARGIN_MS = 60_000;

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/;
const QUOTED = /^(['"])(.*)\1$/;

/** `export NAME=value` and `NAME=value` lines; surrounding quotes are dropped. */
export const parseEnvFile = (text) => {
  const vars = {};
  for (const line of text.split('\n')) {
    const match = ENV_LINE.exec(line);
    if (match) vars[match[1]] = match[2].trim().replace(QUOTED, '$2');
  }
  return vars;
};

// Claude Code strips every *SECRET* variable from the environment of a helper
// declared in a project .mcp.json, so the file is the source it can rely on.
export const readBypassSecret = async (env = process.env, file = SECRET_FILE) => {
  if (env[SECRET_VAR]) return env[SECRET_VAR];
  try {
    return parseEnvFile(await readFile(file, 'utf8'))[SECRET_VAR] || undefined;
  } catch {
    return undefined;
  }
};

export const bypassHeaders = (secret) => (secret ? { [BYPASS_HEADER]: secret } : {});

export const tokenFile = (origin, dir = CONFIG_DIR) =>
  join(dir, 'preview-auth', `${new URL(origin).host}.json`);

export const loadJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Atomic and owner-only: the file holds a refresh token. */
export const saveJson = async (file, value) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
};

// Every Claude Code session runs the helper: two of them renewing at once would
// replay one refresh token, and the server revokes a grant on replay.
export const withLock = async (file, fn, { timeoutMs = 4_000, staleMs = 30_000 } = {}) => {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const since = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (since > staleMs) await rm(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`another session holds ${lock}`);
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};

export const needsRefresh = (tokens, now) =>
  !tokens?.accessToken || tokens.expiresAt - REFRESH_MARGIN_MS <= now;

/** The server rotates refresh tokens; keep the previous one only if it sent none. */
export const storedTokens = (previous, body, now) => ({
  ...previous,
  accessToken: body.access_token,
  refreshToken: body.refresh_token ?? previous.refreshToken,
  expiresAt: now + (body.expires_in ?? 0) * 1000,
});

/**
 * The access token for `origin`, renewed when it nears expiry. Undefined when
 * this machine never signed in there; throws when the renewal fails.
 */
export const currentAccessToken = async (
  origin,
  secret,
  { file = tokenFile(origin), now = Date.now, fetchImpl = fetch } = {},
) => {
  const cached = await loadJson(file);
  if (!cached) return undefined;
  if (!needsRefresh(cached, now())) return cached.accessToken;
  return withLock(file, async () => {
    // Another session may have renewed while this one waited for the lock.
    const tokens = await loadJson(file);
    if (!tokens?.refreshToken) return undefined;
    if (!needsRefresh(tokens, now())) return tokens.accessToken;
    const res = await fetchImpl(`${origin}/token`, {
      method: 'POST',
      headers: { ...bypassHeaders(secret), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
        resource: `${origin}/mcp`,
      }),
      // Claude Code kills the helper after 10 s.
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') await rm(file, { force: true });
      throw new Error(
        `token renewal failed (${res.status} ${body.error ?? ''}): run the mural-preview skill to sign in again`,
      );
    }
    const next = storedTokens(tokens, body, now());
    await saveJson(file, next);
    return next.accessToken;
  });
};

/** A branch's stable address is its `-git-` alias; the others name one deployment. */
export const branchAlias = (aliases) =>
  aliases.find((alias) => alias.includes('-git-')) ?? aliases[0];

export const latestReadyDeployment = (deployments, branch) =>
  deployments
    .filter((d) => d.meta?.githubCommitRef === branch && d.readyState === 'READY')
    .sort((a, b) => b.created - a.created)[0];

export const desiredEntry = (alias) => ({
  type: 'http',
  url: `https://${alias}/mcp`,
  // Expanded by Claude Code from the shell; the helper's copy overrides it.
  headers: { [BYPASS_HEADER]: `\${${SECRET_VAR}}` },
  headersHelper: HELPER_COMMAND,
});

/** `.mcp.json` with the mural-mcp-dev entry set to `entry`, other servers untouched. */
export const syncMcpJson = (current, entry) => {
  const changed = !isDeepStrictEqual(current?.mcpServers?.[SERVER_NAME], entry);
  return {
    changed,
    next: { ...current, mcpServers: { ...current?.mcpServers, [SERVER_NAME]: entry } },
  };
};
