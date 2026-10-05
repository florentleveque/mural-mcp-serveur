// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash } from 'node:crypto';
import { errors } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKeyRing } from '../../../src/auth/keys.js';
import { createRedisStore, type RecordStore } from '../../../src/auth/record-store.js';
import { createAdapterFactory, createSealedCollection, hashId } from '../../../src/auth/store.js';
import { createFakeRedis } from './fake-redis.js';

const OLD = Buffer.alloc(32, 1).toString('base64');
const NEW = Buffer.alloc(32, 2).toString('base64');

const hashed = (id: string) => createHash('sha256').update(id).digest('base64url');
// A fractional second, so Math.floor and Math.ceil disagree on it.
const NOW = 1_700_000_000_500;
const NOW_S = Math.floor(NOW / 1000);

describe('hashId', () => {
  it('is the base64url SHA-256 of the id', () => {
    expect(hashId('rt-1')).toBe(hashed('rt-1'));
  });
});

describe('createAdapterFactory', () => {
  let fake: ReturnType<typeof createFakeRedis>;
  let store: RecordStore;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    fake = createFakeRedis();
    store = createRedisStore(fake.redis, 'test');
  });
  afterEach(() => vi.useRealTimers());

  const adapterFor = (name: string, secret = OLD) =>
    createAdapterFactory(store, deriveKeyRing(secret))(name);

  it('round-trips a payload, with its expiry', async () => {
    const adapter = adapterFor('Session');
    await adapter.upsert('s-1', { accountId: 'a', exp: NOW_S + 60 }, 60);
    expect(await adapter.find('s-1')).toEqual({ accountId: 'a', exp: NOW_S + 60 });
    expect(fake.expiryOf(`test:Session:${hashed('s-1')}`)).toBe(NOW + 60_000);
    expect(await adapter.find('unknown')).toBeUndefined();
  });

  it('keeps a client without expiry', async () => {
    const adapter = adapterFor('Client');
    await adapter.upsert('client-1', { client_id: 'client-1' }, undefined as unknown as number);
    expect(await adapter.find('client-1')).toEqual({ client_id: 'client-1' });
    expect(fake.expiryOf(`test:Client:${hashed('client-1')}`)).toBeUndefined();
  });

  it('stores neither the raw id nor any plaintext', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert(
      'raw-refresh-token-value',
      { grantId: 'grant-xyz', accountId: 'mural:4242', uid: 'uid-secret', exp: NOW_S + 60 },
      60,
    );
    await adapter.consume('raw-refresh-token-value');
    const dump = fake.dump();
    for (const secret of [
      'raw-refresh-token-value',
      'grant-xyz',
      'mural:4242',
      '4242',
      'uid-secret',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('keys records as <model>:<sha256 of the id>, with per-model grant and uid indexes', async () => {
    await adapterFor('RefreshToken').upsert('rt-1', { grantId: 'g-1', exp: NOW_S + 60 }, 60);
    await adapterFor('Session').upsert('s-1', { uid: 'u-1' }, 60);
    expect(fake.keys()).toEqual(
      new Set([
        `test:RefreshToken:${hashed('rt-1')}`,
        `test:RefreshToken:grant:${hashed('g-1')}`,
        `test:Session:${hashed('s-1')}`,
        `test:Session:uid:${hashed('u-1')}`,
      ]),
    );
    expect(fake.raw(`test:RefreshToken:grant:${hashed('g-1')}`)).toEqual(new Set([hashed('rt-1')]));
  });

  it('marks a token consumed, stamping the time, and keeps it readable until its expiry', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt', { grantId: 'g', exp: NOW_S + 60 }, 60);
    vi.setSystemTime(NOW + 10_000);
    await adapter.consume('rt');
    expect(await adapter.find('rt')).toEqual({
      grantId: 'g',
      exp: NOW_S + 60,
      consumed: NOW_S + 10,
    });
    // The marker dies with the token: exp is whole seconds, NOW is not.
    expect(fake.expiryOf(`test:RefreshToken:consumed:${hashed('rt')}`)).toBe(NOW_S * 1000 + 60_000);
  });

  it('refuses a second redemption, so concurrent ones mint tokens once', async () => {
    const adapter = adapterFor('AuthorizationCode');
    await adapter.upsert('code', { grantId: 'g', exp: NOW_S + 60 }, 60);
    const results = await Promise.allSettled([adapter.consume('code'), adapter.consume('code')]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(errors.InvalidGrant);
    expect(rejected?.reason).toMatchObject({
      error: 'invalid_grant',
      error_description: 'grant request is invalid',
      error_detail: 'grant already consumed',
    });
  });

  it('marks a token without expiry consumed for good', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt', { accountId: 'a' }, undefined as unknown as number);
    await adapter.consume('rt');
    expect(await adapter.find('rt')).toMatchObject({ consumed: NOW_S });
    expect(fake.expiryOf(`test:RefreshToken:consumed:${hashed('rt')}`)).toBeUndefined();
  });

  it('creates nothing when consuming an unknown token', async () => {
    await expect(adapterFor('RefreshToken').consume('missing')).resolves.toBeUndefined();
    expect(fake.keys()).toEqual(new Set());
  });

  it('destroys a record and its consumption marker', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt', { exp: NOW_S + 60 }, 60);
    await adapter.consume('rt');
    await adapter.destroy('rt');
    expect(await adapter.find('rt')).toBeUndefined();
    expect(fake.keys()).toEqual(new Set());
  });

  it('finds by uid', async () => {
    const adapter = adapterFor('Session');
    await adapter.upsert('sess-1', { uid: 'uid-1', accountId: 'a' }, 60);
    expect(fake.expiryOf(`test:Session:uid:${hashed('uid-1')}`)).toBe(NOW + 60_000);
    expect(await adapter.findByUid('uid-1')).toEqual({ uid: 'uid-1', accountId: 'a' });
    expect(await adapter.findByUid('nope')).toBeUndefined();
    expect(await adapter.findByUserCode('any')).toBeUndefined();
  });

  it('revokes every record of a grant and its markers, and only those, even when written concurrently', async () => {
    const adapter = adapterFor('RefreshToken');
    await Promise.all(
      ['a', 'b', 'c'].map((id) => adapter.upsert(id, { grantId: 'g1', exp: NOW_S + 60 }, 60)),
    );
    await adapter.consume('a');
    await adapter.upsert('other', { grantId: 'g2', exp: NOW_S + 60 }, 60);
    await adapter.revokeByGrantId('g1');
    expect(await adapter.find('a')).toBeUndefined();
    expect(await adapter.find('b')).toBeUndefined();
    expect(await adapter.find('c')).toBeUndefined();
    expect(await adapter.find('other')).toBeDefined();
    expect(fake.keys()).toEqual(
      new Set([`test:RefreshToken:${hashed('other')}`, `test:RefreshToken:grant:${hashed('g2')}`]),
    );
    await expect(adapter.revokeByGrantId('never-seen')).resolves.toBeUndefined();
  });

  it('indexes a grant until its latest expiry, never shortening it', async () => {
    const adapter = adapterFor('RefreshToken');
    const index = `test:RefreshToken:grant:${hashed('g')}`;
    // Up to each token's exp, in whole seconds, not to now plus its ttl.
    await adapter.upsert('a', { grantId: 'g', exp: NOW_S + 60 }, 60);
    expect(fake.expiryOf(index)).toBe((NOW_S + 60) * 1000);
    await adapter.upsert('b', { grantId: 'g', exp: NOW_S + 120 }, 120);
    await adapter.upsert('c', { grantId: 'g', exp: NOW_S + 30 }, 30);
    expect(fake.expiryOf(index)).toBe((NOW_S + 120) * 1000);
    expect(fake.raw(index)).toEqual(new Set([hashed('a'), hashed('b'), hashed('c')]));
  });

  it('indexes a grant with no expiry for good, and one already expired for a millisecond', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('a', { grantId: 'forever' }, undefined as unknown as number);
    expect(fake.expiryOf(`test:RefreshToken:grant:${hashed('forever')}`)).toBeUndefined();
    await adapter.upsert('b', { grantId: 'past', exp: NOW_S - 10 }, 1);
    expect(fake.expiryOf(`test:RefreshToken:grant:${hashed('past')}`)).toBe(NOW + 1);
  });

  it('separates models: a grant revoked for one model leaves the other untouched', async () => {
    await adapterFor('AuthorizationCode').upsert('x', { grantId: 'g', exp: NOW_S + 60 }, 60);
    await adapterFor('RefreshToken').upsert('x', { grantId: 'g', exp: NOW_S + 60 }, 60);
    await adapterFor('AuthorizationCode').revokeByGrantId('g');
    expect(await adapterFor('AuthorizationCode').find('x')).toBeUndefined();
    expect(await adapterFor('RefreshToken').find('x')).toBeDefined();
  });

  it('reads records under an older secret while it is still listed, and rejects them once dropped', async () => {
    await adapterFor('Client', OLD).upsert('c', { client_id: 'c' }, 60);
    expect(await adapterFor('RefreshToken', OLD).find('c')).toBeUndefined();
    expect(await adapterFor('Client', `${NEW},${OLD}`).find('c')).toEqual({ client_id: 'c' });
    await adapterFor('Client', OLD).upsert('stale', { client_id: 'stale' }, 60);
    expect(await adapterFor('Client', NEW).find('stale')).toBeUndefined();
  });

  it('re-encrypts a record read under an older secret, so dropping that secret loses nothing', async () => {
    await adapterFor('Client', OLD).upsert('c', { client_id: 'c' }, 60);
    await adapterFor('Client', `${NEW},${OLD}`).find('c');
    expect(await adapterFor('Client', NEW).find('c')).toEqual({ client_id: 'c' });
  });
});

describe('createSealedCollection', () => {
  let fake: ReturnType<typeof createFakeRedis>;
  let store: RecordStore;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    fake = createFakeRedis();
    store = createRedisStore(fake.redis, 'test');
  });
  afterEach(() => vi.useRealTimers());

  it('treats a tampered or foreign value as absent', async () => {
    const collection = createSealedCollection<{ a: number }>(store, 'Thing', deriveKeyRing(OLD));
    await collection.set('x', { a: 1 });
    expect(fake.keys()).toEqual(new Set([`test:Thing:${hashed('x')}`]));
    await store.set(`Thing:${hashed('x')}`, 'not-a-jwe');
    expect(await collection.get('x')).toBeUndefined();
    await store.set(`Thing:${hashed('y')}`, 'not-a-jwe');
    expect(await collection.take('y')).toBeUndefined();
  });

  it('leaves a record sealed under the current secret as it is on read', async () => {
    const collection = createSealedCollection<string>(
      store,
      'Thing',
      deriveKeyRing(`${NEW},${OLD}`),
    );
    await collection.set('x', 'v', 60);
    const sealed = fake.raw(`test:Thing:${hashed('x')}`);
    expect(await collection.get('x')).toBe('v');
    expect(fake.raw(`test:Thing:${hashed('x')}`)).toBe(sealed);
  });

  it('takes a record once', async () => {
    const collection = createSealedCollection<string>(store, 'Thing', deriveKeyRing(OLD));
    await collection.set('x', 'v', 60);
    expect(await collection.take('x')).toBe('v');
    expect(await collection.take('x')).toBeUndefined();
    expect(await collection.get('x')).toBeUndefined();
  });

  it('keeps its expiry when re-encrypting a record under the current secret', async () => {
    const key = `test:Thing:${hashed('x')}`;
    const write = createSealedCollection<unknown>(store, 'Thing', deriveKeyRing(OLD));
    const rotate = createSealedCollection<unknown>(store, 'Thing', deriveKeyRing(`${NEW},${OLD}`));

    // Whatever the payload: a consent is a bare `true`, Mural tokens carry no
    // `exp`. The expiry set at write time is the one kept.
    await write.set('x', true, 60);
    vi.advanceTimersByTime(10_000);
    expect(await rotate.get('x')).toBe(true);
    expect(fake.expiryOf(key)).toBe(NOW + 60_000);
    vi.advanceTimersByTime(10_000);
    expect(await createSealedCollection(store, 'Thing', deriveKeyRing(NEW)).get('x')).toBe(true);
    expect(fake.expiryOf(key)).toBe(NOW + 60_000);

    await write.set('x', { exp: NOW_S + 999 });
    expect(await rotate.get('x')).toEqual({ exp: NOW_S + 999 });
    expect(fake.expiryOf(key)).toBeUndefined();

    await write.set('x', null);
    expect(await rotate.get('x')).toBeNull();
  });

  it('expires a record after its ttl', async () => {
    const collection = createSealedCollection<string>(store, 'Thing', deriveKeyRing(OLD));
    await collection.set('x', 'v', 10);
    vi.advanceTimersByTime(9_999);
    expect(await collection.get('x')).toBe('v');
    vi.advanceTimersByTime(1);
    expect(await collection.get('x')).toBeUndefined();
  });

  // A store outage must not read as every grant being gone: clients would drop
  // their tokens. Raised, it is a 500 the client retries.
  it('raises a backend failure instead of reading it as a missing record', async () => {
    const fail = (message: string) => () => Promise.reject(new Error(message));
    const down: RecordStore = {
      get: fail('backend down'),
      take: fail('backend down on take'),
      set: fail('backend down on write'),
      setIfAbsent: fail('backend down on write'),
      delete: fail('backend down on delete'),
      addMember: fail('backend down on write'),
      members: fail('backend down'),
    };
    const collection = createSealedCollection<string>(down, 'Thing', deriveKeyRing(OLD));
    await expect(collection.get('x')).rejects.toThrow('backend down');
    await expect(collection.take('x')).rejects.toThrow('backend down on take');
    await expect(collection.set('x', 'v')).rejects.toThrow('backend down on write');
    await expect(collection.delete('x')).rejects.toThrow('backend down on delete');
  });
});
