// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveKeyRing } from '../../../src/auth/keys.js';
import {
  createMuralGrants,
  isGrantUnavailableError,
  MURAL_REFRESH_MARGIN_MS,
  MURAL_TOKENS_TTL_S,
  REFRESH_LOCK_TTL_MS,
} from '../../../src/auth/mural-grants.js';
import type { MuralTokenSet } from '../../../src/auth/mural-upstream.js';
import { createRedisStore } from '../../../src/auth/record-store.js';
import { createSealedCollection, hashId } from '../../../src/auth/store.js';
import { createFakeRedis } from './fake-redis.js';

const UPSTREAM = { clientId: 'c', clientSecret: 's' };
const ring = deriveKeyRing(Buffer.alloc(32, 3).toString('base64'));
const LOCK = `test:MuralRefreshLock:${hashId('g')}`;

const upstreamError = (message: string, status?: number): Error =>
  Object.assign(new Error(message), {
    name: 'UpstreamAuthError',
    ...(status === undefined ? {} : { status }),
  });
const refusal = (status: number) =>
  upstreamError(`Mural refused the refresh_token grant (${status}).`, status);
const fresh = (accessToken: string): MuralTokenSet => ({
  accessToken,
  refreshToken: `${accessToken}-refresh`,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** One shared database, and as many server instances over it as a test asks for. */
const setup = (refresh = vi.fn(), refreshMarginMs?: number) => {
  const fake = createFakeRedis();
  const store = createRedisStore(fake.redis, 'test');
  const records = createSealedCollection<MuralTokenSet>(store, 'MuralTokens', ring);
  let clock = 1_000_000;
  const now = () => clock;
  // Each poll lets the event loop (and the test) run; the clock only moves
  // when a test says so, so a holder is never timed out by accident.
  let advanceOnSleep = false;
  const sleep = vi.fn(async (ms: number) => {
    if (advanceOnSleep) clock += ms;
    await new Promise((resolve) => setImmediate(resolve));
  });
  const instance = () =>
    createMuralGrants({ records, store, upstream: UPSTREAM, refresh, now, sleep, refreshMarginMs });
  const moveClockOnSleep = () => {
    advanceOnSleep = true;
  };
  return {
    grants: instance(),
    instance,
    records,
    store,
    fake,
    refresh,
    now,
    sleep,
    moveClockOnSleep,
  };
};

afterEach(() => vi.restoreAllMocks());

describe('createMuralGrants', () => {
  it('returns the stored token outside the refresh margin, without taking the lock', async () => {
    const { grants, refresh, now, store } = setup();
    const setIfAbsent = vi.spyOn(store, 'setIfAbsent');
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + MURAL_REFRESH_MARGIN_MS + 1 });
    expect(await grants.accessToken('g')).toBe('a1');
    expect(refresh).not.toHaveBeenCalled();
    expect(setIfAbsent).not.toHaveBeenCalled();
  });

  it('keeps the tokens at rest for 90 days', async () => {
    const { grants, fake } = setup();
    vi.useFakeTimers({ now: 5_000 });
    try {
      await grants.save('g', fresh('a1'));
      expect(MURAL_TOKENS_TTL_S).toBe(90 * 86400);
      expect(fake.expiryOf(`test:MuralTokens:${hashId('g')}`)).toBe(5_000 + 90 * 86400 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes at the margin, persists the rotated set and releases the lock', async () => {
    const refresh = vi.fn(async () => fresh('a2'));
    const { grants, records, now, fake } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + MURAL_REFRESH_MARGIN_MS });
    expect(await grants.accessToken('g')).toBe('a2');
    expect(refresh).toHaveBeenCalledWith(UPSTREAM, 'a1-refresh');
    expect(await records.get('g')).toEqual(fresh('a2'));
    expect(fake.keys().has(LOCK)).toBe(false);
    // Fresh now: served without another refresh.
    expect(await grants.accessToken('g')).toBe('a2');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('honours a wider margin: a token our access token would outlive is refreshed', async () => {
    const refresh = vi.fn(async () => fresh('a2'));
    const { grants, now } = setup(refresh, 660_000);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + 660_001 });
    expect(await grants.accessToken('g')).toBe('a1');
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + 660_000 });
    expect(await grants.accessToken('g')).toBe('a2');
  });

  it('spends the Mural refresh token once across instances', async () => {
    let resolveRefresh: (v: MuralTokenSet) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<MuralTokenSet>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { grants, instance, now } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    const other = instance();
    const pending = Promise.all(
      [grants, other, grants, other, grants].map((instanceOf) => instanceOf.accessToken('g')),
    );
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh(fresh('a2'));
    expect(await pending).toEqual(['a2', 'a2', 'a2', 'a2', 'a2']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401])('drops the grant when Mural refuses the refresh (%i)', async (status) => {
    const refresh = vi.fn(async () => {
      throw refusal(status);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { grants, records, now, fake } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    const failure = grants.accessToken('g');
    await expect(failure).rejects.toThrow(
      'The Mural authorization behind this grant is no longer valid.',
    );
    await failure.catch((err: unknown) => expect(isGrantUnavailableError(err)).toBe(true));
    expect(await records.get('g')).toBeUndefined();
    expect(fake.keys().has(LOCK)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      `Mural refused a refresh: Mural refused the refresh_token grant (${status}).`,
    );
  });

  it.each([
    ['a server error', upstreamError('Mural refused the refresh_token grant (503).', 503)],
    ['an unreachable endpoint', upstreamError('Mural token endpoint unreachable.')],
    ['any other failure', new Error('boom')],
  ])('keeps the grant on %s, which may leave the refresh token unspent', async (_label, error) => {
    const refresh = vi.fn(async () => {
      throw error;
    });
    const { grants, records, now, fake } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    await expect(grants.accessToken('g')).rejects.toBe(error);
    expect(await records.get('g')).toMatchObject({ accessToken: 'a1' });
    expect(fake.keys().has(LOCK)).toBe(false);
  });

  it('recognises only its own grant-unavailable error', () => {
    expect(isGrantUnavailableError(new Error('x'))).toBe(false);
    expect(isGrantUnavailableError({ name: 'MuralGrantUnavailable' })).toBe(false);
  });

  it('reports a grant without Mural tokens as unavailable', async () => {
    const { grants } = setup();
    const failure = grants.accessToken('unknown');
    await expect(failure).rejects.toThrow('no longer valid');
    await failure.catch((err: unknown) => expect(isGrantUnavailableError(err)).toBe(true));
  });

  it('reports a grant removed while waiting for the lock as unavailable', async () => {
    const { grants, records, store, now } = setup();
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    await store.setIfAbsent(`MuralRefreshLock:${hashId('g')}`, '1', REFRESH_LOCK_TTL_MS);
    const pending = grants.accessToken('g');
    await records.delete('g');
    await store.delete(`MuralRefreshLock:${hashId('g')}`);
    await expect(pending).rejects.toThrow('no longer valid');
  });

  it('serves what another instance refreshed while this one waited', async () => {
    const refresh = vi.fn(async () => fresh('never'));
    const { grants, records, store, now } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    await store.setIfAbsent(`MuralRefreshLock:${hashId('g')}`, '1', REFRESH_LOCK_TTL_MS);
    const pending = grants.accessToken('g');
    await records.set('g', fresh('a2'));
    await store.delete(`MuralRefreshLock:${hashId('g')}`);
    expect(await pending).toBe('a2');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a stale grant without refresh token as unavailable', async () => {
    const { grants, now, refresh } = setup();
    await grants.save('g', { accessToken: 'a1', expiresAt: now() });
    await expect(grants.accessToken('g')).rejects.toThrow('no longer valid');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gives up on a lock held past its lifetime, polling every 100 ms', async () => {
    const { grants, store, now, sleep, refresh, moveClockOnSleep } = setup();
    moveClockOnSleep();
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    // A lock that never expires: its holder never lets go.
    await store.setIfAbsent(`MuralRefreshLock:${hashId('g')}`, '1');
    await expect(grants.accessToken('g')).rejects.toThrow(
      'Timed out waiting for another refresh of this Mural grant.',
    );
    expect(sleep).toHaveBeenCalledTimes(REFRESH_LOCK_TTL_MS / 100);
    expect(new Set(sleep.mock.calls.map(([ms]) => ms))).toEqual(new Set([100]));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('expires its own lock after 15 s, in case the instance dies holding it', async () => {
    let resolveRefresh: (v: MuralTokenSet) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<MuralTokenSet>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    vi.useFakeTimers({ now: 7_000, toFake: ['Date'] });
    try {
      const { grants, now, fake } = setup(refresh);
      await grants.save('g', { ...fresh('a1'), expiresAt: now() });
      const pending = grants.accessToken('g');
      while (refresh.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
      expect(REFRESH_LOCK_TTL_MS).toBe(15_000);
      expect(fake.expiryOf(LOCK)).toBe(7_000 + 15_000);
      resolveRefresh(fresh('a2'));
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a grant only once a running refresh has let go', async () => {
    let resolveRefresh: (v: MuralTokenSet) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<MuralTokenSet>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { grants, records, now } = setup(refresh);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() });
    const refreshing = grants.accessToken('g');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    const removal = grants.remove('g');
    resolveRefresh(fresh('a2'));
    await refreshing;
    await removal;
    expect(await records.get('g')).toBeUndefined();
  });

  it('warns when Mural hands out a token that would expire within the margin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { grants, now } = setup(vi.fn(), 660_000);
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + 660_001 });
    expect(warn).not.toHaveBeenCalled();
    await grants.save('g', { ...fresh('a1'), expiresAt: now() + 660_000 });
    expect(warn).toHaveBeenCalledWith(
      'Mural issued an access token that expires within the refresh margin (660000 ms): tokens minted from it outlive it. Mural may have shortened its token lifetime.',
    );
  });
});

describe('createMuralGrants defaults', () => {
  it('waits on the real clock for a lock another instance releases', async () => {
    const fake = createFakeRedis();
    const store = createRedisStore(fake.redis, 'test');
    const records = createSealedCollection<MuralTokenSet>(store, 'MuralTokens', ring);
    const grants = createMuralGrants({ records, store, upstream: UPSTREAM });
    await grants.save('g', fresh('a1'));
    await store.setIfAbsent(`MuralRefreshLock:${hashId('g')}`, '1', REFRESH_LOCK_TTL_MS);
    const started = Date.now();
    setTimeout(() => void store.delete(`MuralRefreshLock:${hashId('g')}`), 30);
    await grants.remove('g');
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(await records.get('g')).toBeUndefined();
  });

  it('refreshes through Mural with the default margin', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 900 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const store = createRedisStore(createFakeRedis().redis, 'test');
      const records = createSealedCollection<MuralTokenSet>(store, 'MuralTokens', ring);
      const grants = createMuralGrants({ records, store, upstream: UPSTREAM });
      await grants.save('g', {
        ...fresh('a1'),
        expiresAt: Date.now() + MURAL_REFRESH_MARGIN_MS + 5_000,
      });
      expect(await grants.accessToken('g')).toBe('a1');
      await grants.save('g', {
        ...fresh('a1'),
        expiresAt: Date.now() + MURAL_REFRESH_MARGIN_MS - 5_000,
      });
      expect(await grants.accessToken('g')).toBe('a2');
      expect(MURAL_REFRESH_MARGIN_MS).toBe(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
