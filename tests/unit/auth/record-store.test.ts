import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRedisStore,
  openRedisStore,
  type RecordStore,
} from '../../../src/auth/record-store.js';
import { createFakeRedis } from './fake-redis.js';

// A fractional millisecond count, so Math.ceil and Math.floor disagree on it.
const NOW = 1_700_000_000_000;

describe('createRedisStore', () => {
  let fake: ReturnType<typeof createFakeRedis>;
  let store: RecordStore;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    fake = createFakeRedis();
    store = createRedisStore(fake.redis, 'preview');
  });
  afterEach(() => vi.useRealTimers());

  it('prefixes every key with the namespace', async () => {
    await store.set('a', '1');
    await store.setIfAbsent('b', '2');
    await store.addMember('c', 'm', 1000);
    expect(fake.keys()).toEqual(new Set(['preview:a', 'preview:b', 'preview:c']));
    expect(await createRedisStore(fake.redis, 'production').get('a')).toBeUndefined();
  });

  it('reads a missing key as undefined', async () => {
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.take('missing')).toBeUndefined();
  });

  it('writes with a whole-millisecond expiry, at least one, or none', async () => {
    await store.set('forever', 'v');
    await store.set('short', 'v', 1500.2);
    await store.set('past', 'v', -20);
    expect(await store.get('forever')).toBe('v');
    expect(fake.expiryOf('preview:forever')).toBeUndefined();
    expect(fake.expiryOf('preview:short')).toBe(NOW + 1501);
    expect(fake.expiryOf('preview:past')).toBe(NOW + 1);
  });

  it('expires a value after its ttl', async () => {
    await store.set('k', 'v', 1000);
    vi.advanceTimersByTime(999);
    expect(await store.get('k')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await store.get('k')).toBeUndefined();
  });

  it('takes a value once', async () => {
    await store.set('k', 'v');
    expect(await store.take('k')).toBe('v');
    expect(await store.take('k')).toBeUndefined();
    expect(fake.keys()).toEqual(new Set());
  });

  it('writes only an absent key, keeping the first value and its expiry', async () => {
    expect(await store.setIfAbsent('k', 'first', 1000.5)).toBe(true);
    expect(await store.setIfAbsent('k', 'second', 5000)).toBe(false);
    expect(await store.get('k')).toBe('first');
    expect(fake.expiryOf('preview:k')).toBe(NOW + 1001);
    vi.advanceTimersByTime(1001);
    expect(await store.setIfAbsent('k', 'third')).toBe(true);
    expect(fake.expiryOf('preview:k')).toBeUndefined();
    expect(await store.setIfAbsent('k', 'fourth')).toBe(false);
    expect(await store.get('k')).toBe('third');
  });

  it('clamps a non-positive ttl on a conditional write', async () => {
    expect(await store.setIfAbsent('k', 'v', 0)).toBe(true);
    expect(fake.expiryOf('preview:k')).toBe(NOW + 1);
  });

  it('deletes several keys at once, and nothing for no key', async () => {
    await store.set('a', '1');
    await store.set('b', '2');
    await store.set('c', '3');
    await store.delete('a', 'b');
    expect(fake.keys()).toEqual(new Set(['preview:c']));
    // Redis refuses a DEL without keys: the fake throws on one.
    await expect(store.delete()).resolves.toBeUndefined();
  });

  it('keeps a set alive for the longest ttl it was given, never shortening it', async () => {
    await store.addMember('s', 'a', 60_000);
    expect(fake.expiryOf('preview:s')).toBe(NOW + 60_000);
    await store.addMember('s', 'b', 120_000.5);
    expect(fake.expiryOf('preview:s')).toBe(NOW + 120_001);
    await store.addMember('s', 'c', 30_000);
    expect(fake.expiryOf('preview:s')).toBe(NOW + 120_001);
    await store.addMember('s', 'c', -5);
    expect(new Set(await store.members('s'))).toEqual(new Set(['a', 'b', 'c']));
    vi.advanceTimersByTime(120_001);
    expect(await store.members('s')).toEqual([]);
  });

  it('drops the expiry of a set given a member without ttl', async () => {
    await store.addMember('s', 'a', 60_000);
    await store.addMember('s', 'b');
    expect(fake.expiryOf('preview:s')).toBeUndefined();
    expect(new Set(await store.members('s'))).toEqual(new Set(['a', 'b']));
  });

  it('gives a fresh set an expiry even when the new ttl is shorter than nothing', async () => {
    await store.addMember('s', 'a', 0);
    expect(fake.expiryOf('preview:s')).toBe(NOW + 1);
  });
});

describe('openRedisStore', () => {
  const env = {
    KV_REST_API_URL: 'https://kv.example.upstash.io',
    KV_REST_API_TOKEN: 'kv-token',
    VERCEL_ENV: 'preview',
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The client pipelines automatically: one POST to /pipeline, one result per command.
    fetchMock = vi.fn(async () =>
      Response.json([{ result: Buffer.from('{"a":1}').toString('base64') }]),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sentCommand = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const [command] = JSON.parse(String(init.body)) as unknown[];
    return { url, command, auth: headers.get('authorization') };
  };

  it('talks to the integration database, namespaced by VERCEL_ENV, without parsing values', async () => {
    const value = await openRedisStore(env).get('k');
    expect(value).toBe('{"a":1}');
    expect(sentCommand()).toEqual({
      url: 'https://kv.example.upstash.io/pipeline',
      command: ['get', 'preview:k'],
      auth: 'Bearer kv-token',
    });
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('falls back to the development namespace when VERCEL_ENV is %s', async (_label, vercelEnv) => {
    await openRedisStore({ ...env, VERCEL_ENV: vercelEnv }).get('k');
    expect(sentCommand().command).toEqual(['get', 'development:k']);
  });

  it.each([
    ['KV_REST_API_URL', { ...env, KV_REST_API_URL: '' }],
    ['KV_REST_API_TOKEN', { ...env, KV_REST_API_TOKEN: undefined }],
  ])('refuses to start without %s', (_name, incomplete) => {
    expect(() => openRedisStore(incomplete)).toThrow(
      'KV_REST_API_URL and KV_REST_API_TOKEN must be set: the Upstash integration of the Vercel project provides them.',
    );
  });

  it('reads process.env by default', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv-default.example.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'kv-default-token');
    vi.stubEnv('VERCEL_ENV', 'production');
    try {
      await openRedisStore().get('k');
      expect(sentCommand()).toMatchObject({
        url: 'https://kv-default.example.upstash.io/pipeline',
        command: ['get', 'production:k'],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
