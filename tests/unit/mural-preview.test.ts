import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mural-preview skill's helper runs at every Claude Code connection and
// holds a rotating refresh token: a wrong expiry test or a broken lock either
// spams the server or revokes the grant. Files live in this in-memory map.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Map<string, number>(),
}));

vi.mock('node:fs/promises', () => {
  const failure = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  return {
    readFile: vi.fn(async (path: string) => {
      const text = fsState.files.get(path);
      if (text === undefined) throw failure('ENOENT', path);
      return text;
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      fsState.files.set(path, String(data));
    }),
    rename: vi.fn(async (from: string, to: string) => {
      fsState.files.set(to, fsState.files.get(from) ?? '');
      fsState.files.delete(from);
    }),
    rm: vi.fn(async (path: string) => {
      fsState.files.delete(path);
      fsState.dirs.delete(path);
    }),
    mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
      if (fsState.dirs.has(path) && !options?.recursive) throw failure('EEXIST', path);
      if (!fsState.dirs.has(path)) fsState.dirs.set(path, Date.now());
    }),
    stat: vi.fn(async (path: string) => {
      const mtimeMs = fsState.dirs.get(path);
      if (mtimeMs === undefined) throw failure('ENOENT', path);
      return { mtimeMs };
    }),
  };
});

// @ts-expect-error -- plain .mjs helper, no declaration file (same as the
// script tests in this directory).
import * as lib from '../../.claude/skills/mural-preview/scripts/lib.mjs';

const ORIGIN = 'https://preview-git-branch-team.vercel.app';
const FILE = '/cfg/preview-auth/preview-git-branch-team.vercel.app.json';
const NOW = 1_800_000_000_000;

const saved = () => JSON.parse(fsState.files.get(FILE) ?? 'null');
const store = (tokens: Record<string, unknown>) => fsState.files.set(FILE, JSON.stringify(tokens));

const tokenResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const access = (fetchImpl: unknown, now = NOW) =>
  lib.currentAccessToken(ORIGIN, 'bypass-secret', { file: FILE, now: () => now, fetchImpl });

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
});

describe('parseEnvFile', () => {
  it('reads export and plain assignments, dropping quotes and other lines', () => {
    expect(lib.parseEnvFile('export A=1\n# note\nB="two words"\n  C=\'3\'\nnot a line\n')).toEqual({
      A: '1',
      B: 'two words',
      C: '3',
    });
  });
});

describe('readBypassSecret', () => {
  it('prefers the environment', async () => {
    fsState.files.set('/f', 'export VERCEL_AUTOMATION_BYPASS_SECRET=from-file');
    expect(await lib.readBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: 'from-env' }, '/f')).toBe(
      'from-env',
    );
  });

  it('falls back to the file, which Claude Code cannot strip', async () => {
    fsState.files.set('/f', 'export OTHER=1\nexport VERCEL_AUTOMATION_BYPASS_SECRET=from-file\n');
    expect(await lib.readBypassSecret({}, '/f')).toBe('from-file');
  });

  it('is undefined without a file or with an empty value', async () => {
    expect(await lib.readBypassSecret({}, '/missing')).toBeUndefined();
    fsState.files.set('/f', 'export VERCEL_AUTOMATION_BYPASS_SECRET=\n');
    expect(await lib.readBypassSecret({}, '/f')).toBeUndefined();
  });
});

describe('small helpers', () => {
  it('builds the bypass header only with a secret', () => {
    expect(lib.bypassHeaders('s')).toEqual({ 'x-vercel-protection-bypass': 's' });
    expect(lib.bypassHeaders(undefined)).toEqual({});
  });

  it('keeps one token file per preview host', () => {
    expect(lib.tokenFile(`${ORIGIN}/`, '/cfg')).toBe(FILE);
  });

  it('renews a token within one minute of its expiry', () => {
    expect(lib.needsRefresh(undefined, NOW)).toBe(true);
    expect(lib.needsRefresh({ accessToken: 'a', expiresAt: NOW + 61_000 }, NOW)).toBe(false);
    expect(lib.needsRefresh({ accessToken: 'a', expiresAt: NOW + 60_000 }, NOW)).toBe(true);
    expect(lib.needsRefresh({ expiresAt: NOW + 600_000 }, NOW)).toBe(true);
  });

  it('stores a rotated refresh token, or keeps the previous one', () => {
    const previous = { clientId: 'c', refreshToken: 'r1' };
    expect(
      lib.storedTokens(previous, { access_token: 'a', refresh_token: 'r2', expires_in: 600 }, NOW),
    ).toEqual({
      clientId: 'c',
      accessToken: 'a',
      refreshToken: 'r2',
      expiresAt: NOW + 600_000,
    });
    expect(
      lib.storedTokens(previous, { access_token: 'a', expires_in: 600 }, NOW).refreshToken,
    ).toBe('r1');
  });
});

describe('currentAccessToken', () => {
  it('is undefined before any sign-in, without calling the server', async () => {
    const fetchImpl = vi.fn();
    expect(await access(fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a valid token as is', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 300_000 });
    const fetchImpl = vi.fn();
    expect(await access(fetchImpl)).toBe('a1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renews an expiring token through the bypass header and stores the rotation', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 30_000 });
    const fetchImpl = vi.fn(async () =>
      tokenResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 600 }),
    );

    expect(await access(fetchImpl)).toBe('a2');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/token`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'x-vercel-protection-bypass': 'bypass-secret',
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'c',
      refresh_token: 'r1',
      resource: `${ORIGIN}/mcp`,
    });
    expect(saved()).toEqual({
      clientId: 'c',
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: NOW + 600_000,
    });
    expect(fsState.dirs.has(`${FILE}.lock`)).toBe(false);
  });

  it('forgets an ended grant, so the next run asks for a sign-in', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW });
    const fetchImpl = vi.fn(async () => tokenResponse({ error: 'invalid_grant' }, 400));

    await expect(access(fetchImpl)).rejects.toThrow('400 invalid_grant');
    expect(fsState.files.has(FILE)).toBe(false);
    expect(fsState.dirs.has(`${FILE}.lock`)).toBe(false);
  });

  it('keeps the tokens when the server fails for another reason', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW });
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));

    await expect(access(fetchImpl)).rejects.toThrow('sign in again');
    expect(saved().refreshToken).toBe('r1');
  });

  it('renews once when two sessions start together', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW });
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return tokenResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 600 });
    });

    expect(await Promise.all([access(fetchImpl), access(fetchImpl)])).toEqual(['a2', 'a2']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('breaks a lock left by a killed helper', async () => {
    store({ clientId: 'c', accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW });
    fsState.dirs.set(`${FILE}.lock`, Date.now() - 60_000);
    const fetchImpl = vi.fn(async () => tokenResponse({ access_token: 'a2', expires_in: 600 }));

    expect(await access(fetchImpl)).toBe('a2');
  });
});

describe('preview address', () => {
  it("prefers the branch's -git- alias", () => {
    expect(lib.branchAlias(['p-abc-team.vercel.app', 'p-git-b-team.vercel.app'])).toBe(
      'p-git-b-team.vercel.app',
    );
    expect(lib.branchAlias(['p-abc-team.vercel.app'])).toBe('p-abc-team.vercel.app');
    expect(lib.branchAlias([])).toBeUndefined();
  });

  it("picks the branch's newest ready deployment", () => {
    const deployments = [
      { uid: 'old', created: 1, readyState: 'READY', meta: { githubCommitRef: 'b' } },
      { uid: 'new', created: 3, readyState: 'READY', meta: { githubCommitRef: 'b' } },
      { uid: 'building', created: 4, readyState: 'BUILDING', meta: { githubCommitRef: 'b' } },
      { uid: 'other', created: 5, readyState: 'READY', meta: { githubCommitRef: 'main' } },
    ];
    expect(lib.latestReadyDeployment(deployments, 'b').uid).toBe('new');
    expect(lib.latestReadyDeployment(deployments, 'none')).toBeUndefined();
  });
});

describe('syncMcpJson', () => {
  const entry = lib.desiredEntry('p-git-b-team.vercel.app');

  it('declares the preview with the helper and the bypass header reference', () => {
    expect(entry).toEqual({
      type: 'http',
      url: 'https://p-git-b-team.vercel.app/mcp',
      // Claude Code's own `${VAR}` expansion, kept literal in the file.
      headers: { 'x-vercel-protection-bypass': `\${VERCEL_AUTOMATION_BYPASS_SECRET}` },
      headersHelper: 'node .claude/skills/mural-preview/scripts/headers.mjs',
    });
  });

  it('adds the entry to a missing file and keeps other servers', () => {
    expect(lib.syncMcpJson(undefined, entry)).toEqual({
      changed: true,
      next: { mcpServers: { 'mural-mcp-dev': entry } },
    });
    const other = { type: 'stdio', command: 'x' };
    expect(lib.syncMcpJson({ mcpServers: { other } }, entry).next.mcpServers).toEqual({
      other,
      'mural-mcp-dev': entry,
    });
  });

  it('changes nothing when the entry already matches', () => {
    expect(lib.syncMcpJson({ mcpServers: { 'mural-mcp-dev': { ...entry } } }, entry).changed).toBe(
      false,
    );
    expect(
      lib.syncMcpJson(
        { mcpServers: { 'mural-mcp-dev': { ...entry, url: 'https://old/mcp' } } },
        entry,
      ).changed,
    ).toBe(true);
  });
});
