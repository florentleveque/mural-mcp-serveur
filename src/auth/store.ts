// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { createHash } from 'node:crypto';
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from 'jose';
import { type Adapter, type AdapterFactory, type AdapterPayload, errors } from 'oidc-provider';
import type { KeyRing } from './keys.js';
import type { RecordStore } from './record-store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Ids are hashed because oidc-provider uses an opaque token's *value* as its
// id: stored raw, a read of the database would hand out valid refresh tokens.
export const hashId = (id: string): string => createHash('sha256').update(id).digest('base64url');

const recordKey = (name: string, hash: string) => `${name}:${hash}`;

interface SealedRecord<T> {
  readonly value: T;
  /** False when the record was sealed under an older secret. */
  readonly current: boolean;
  /** Epoch ms the record was written to expire at, if it does. */
  readonly expiresAt: number | undefined;
}

export interface SealedCollection<T> {
  get(id: string): Promise<T | undefined>;
  /** Reads and deletes in one step: a value handed out once is never handed out again. */
  take(id: string): Promise<T | undefined>;
  set(id: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(id: string): Promise<void>;
}

// The expiry rides in the (authenticated) protected header rather than the
// payload, whose shape varies by collection: a rewrite under a newer secret
// keeps it whatever the record holds.
const seal = (ring: KeyRing, value: unknown, expiresAt: number | undefined): Promise<string> =>
  new CompactEncrypt(encoder.encode(JSON.stringify(value)))
    .setProtectedHeader({
      alg: 'dir',
      enc: 'A256GCM',
      kid: ring[0].atRest.kid,
      // Left out of the header when undefined: JSON drops it.
      expiresAt,
    })
    .encrypt(ring[0].atRest.key);

const unseal = async <T>(ring: KeyRing, sealed: string): Promise<SealedRecord<T> | undefined> => {
  const { kid, expiresAt } = decodeProtectedHeader(sealed);
  const keySet = ring.find((set) => set.atRest.kid === kid);
  // Stryker disable next-line ConditionalExpression: without the guard the missing key throws
  // into open's catch, which answers undefined all the same.
  if (!keySet) return undefined;
  const { plaintext } = await compactDecrypt(sealed, keySet.atRest.key);
  return {
    value: JSON.parse(decoder.decode(plaintext)) as T,
    current: keySet === ring[0],
    expiresAt: expiresAt as number | undefined,
  };
};

// Unknown kid, tampering or a foreign value: indistinguishable from absent.
const open = <T>(ring: KeyRing, sealed: string): Promise<SealedRecord<T> | undefined> =>
  unseal<T>(ring, sealed).catch(() => undefined);

/**
 * One named collection of whole-payload-encrypted records. A record read under
 * an older secret is rewritten under the current one, so dropping that secret
 * later loses nothing still in use (DCR clients are otherwise never rewritten).
 */
export const createSealedCollection = <T>(
  store: RecordStore,
  name: string,
  ring: KeyRing,
): SealedCollection<T> => {
  const key = (id: string) => recordKey(name, hashId(id));
  return {
    get: async (id) => {
      const sealed = await store.get(key(id));
      // Stryker disable next-line ConditionalExpression: open answers undefined for a missing one too.
      if (sealed === undefined) return undefined;
      const record = await open<T>(ring, sealed);
      if (record && !record.current) {
        const { expiresAt } = record;
        const ttlMs = expiresAt === undefined ? undefined : expiresAt - Date.now();
        await store.set(key(id), await seal(ring, record.value, expiresAt), ttlMs);
      }
      return record?.value;
    },
    take: async (id) => {
      const sealed = await store.take(key(id));
      // Stryker disable next-line ConditionalExpression: open answers undefined for a missing one too.
      return sealed === undefined ? undefined : (await open<T>(ring, sealed))?.value;
    },
    set: async (id, value, ttlSeconds) => {
      const ttlMs = ttlSeconds ? ttlSeconds * 1000 : undefined;
      const expiresAt = ttlMs === undefined ? undefined : Date.now() + ttlMs;
      await store.set(key(id), await seal(ring, value, expiresAt), ttlMs);
    },
    delete: async (id) => {
      await store.delete(key(id));
    },
  };
};

// Milliseconds left until a token's `exp` (epoch seconds), if it has one.
const msUntil = (exp: number | undefined): number | undefined =>
  exp === undefined ? undefined : exp * 1000 - Date.now();

/**
 * oidc-provider adapter factory: every model in Redis, sealed with the at-rest
 * key, because a Vercel instance keeps nothing between requests. Consumption
 * is a separate `SET NX` marker, so of two concurrent redemptions of one code
 * or refresh token only the first succeeds.
 */
export const createAdapterFactory =
  (store: RecordStore, ring: KeyRing): AdapterFactory =>
  (name: string): Adapter => {
    const records = createSealedCollection<AdapterPayload>(store, name, ring);
    const uidIndex = createSealedCollection<string>(store, `${name}:uid`, ring);
    const consumedKey = (hash: string) => `${name}:consumed:${hash}`;
    const grantKey = (grantId: string) => `${name}:grant:${hashId(grantId)}`;

    return {
      upsert: async (id, payload, expiresIn) => {
        await records.set(id, payload, expiresIn);
        if (payload.grantId) {
          await store.addMember(grantKey(payload.grantId), hashId(id), msUntil(payload.exp));
        }
        if (payload.uid) await uidIndex.set(payload.uid, id, expiresIn);
      },
      find: async (id) => {
        const [payload, consumed] = await Promise.all([
          records.get(id),
          store.get(consumedKey(hashId(id))),
        ]);
        if (!payload || consumed === undefined) return payload;
        return { ...payload, consumed: Number(consumed) };
      },
      findByUid: async (uid) => {
        const id = await uidIndex.get(uid);
        return id ? records.get(id) : undefined;
      },
      // Device flow is not enabled.
      findByUserCode: async () => undefined,
      consume: async (id) => {
        const payload = await records.get(id);
        if (!payload) return;
        const first = await store.setIfAbsent(
          consumedKey(hashId(id)),
          String(Math.floor(Date.now() / 1000)),
          msUntil(payload.exp),
        );
        // A concurrent redemption got there first: this one must not mint tokens too.
        if (!first) throw new errors.InvalidGrant('grant already consumed');
      },
      destroy: async (id) => {
        const hash = hashId(id);
        await store.delete(recordKey(name, hash), consumedKey(hash));
      },
      revokeByGrantId: async (grantId) => {
        const hashes = await store.members(grantKey(grantId));
        await store.delete(
          ...hashes.flatMap((hash) => [recordKey(name, hash), consumedKey(hash)]),
          grantKey(grantId),
        );
      },
    };
  };
