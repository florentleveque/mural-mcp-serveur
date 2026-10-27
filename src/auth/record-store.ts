import { Redis } from '@upstash/redis';

/**
 * The key-value operations the authorization server needs, each a single
 * atomic Redis command: Vercel runs any number of instances at once, so no
 * read-modify-write may rely on a process-local lock.
 */
export interface RecordStore {
  get(key: string): Promise<string | undefined>;
  /** Reads and deletes in one step: of two concurrent callers, one gets the value. */
  take(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Writes only when the key is absent, and says whether it did. */
  setIfAbsent(key: string, value: string, ttlMs?: number): Promise<boolean>;
  delete(...keys: string[]): Promise<void>;
  /**
   * Adds a member to a set that then lives at least `ttlMs`, never less than an
   * earlier `ttlMs` gave it. Without `ttlMs`, the set loses its expiry.
   */
  addMember(key: string, member: string, ttlMs?: number): Promise<void>;
  members(key: string): Promise<string[]>;
}

/** The slice of the Upstash client the store uses: what a test double implements. */
export type RedisCommands = Pick<
  Redis,
  'get' | 'getdel' | 'set' | 'del' | 'sadd' | 'smembers' | 'pexpire' | 'persist'
>;

// Redis rejects a non-positive or fractional PX. A record read just before its
// expiry and rewritten just after keeps the shortest valid lifetime instead.
const px = (ttlMs: number): number => Math.max(Math.ceil(ttlMs), 1);

/**
 * A `RecordStore` over Redis. Every key is prefixed with `namespace`, so the
 * production, preview and development deployments can share one database
 * without ever reading each other's records.
 */
export const createRedisStore = (redis: RedisCommands, namespace: string): RecordStore => {
  const key = (name: string) => `${namespace}:${name}`;
  const orUndefined = (value: string | null): string | undefined => value ?? undefined;
  return {
    get: async (name) => orUndefined(await redis.get<string>(key(name))),
    take: async (name) => orUndefined(await redis.getdel<string>(key(name))),
    set: async (name, value, ttlMs) => {
      await (ttlMs === undefined
        ? redis.set(key(name), value)
        : redis.set(key(name), value, { px: px(ttlMs) }));
    },
    setIfAbsent: async (name, value, ttlMs) =>
      (await (ttlMs === undefined
        ? redis.set(key(name), value, { nx: true })
        : redis.set(key(name), value, { px: px(ttlMs), nx: true }))) === 'OK',
    delete: async (...names) => {
      if (names.length > 0) await redis.del(...names.map(key));
    },
    addMember: async (name, member, ttlMs) => {
      await redis.sadd(key(name), member);
      if (ttlMs === undefined) {
        await redis.persist(key(name));
        return;
      }
      // A set SADD just created has no expiry, which GT reads as infinite:
      // NX gives it one, GT then only ever extends it.
      await redis.pexpire(key(name), px(ttlMs), 'NX');
      await redis.pexpire(key(name), px(ttlMs), 'GT');
    },
    members: (name) => redis.smembers(key(name)),
  };
};

/**
 * The store of this deployment: the Upstash database the Vercel integration
 * attached (`KV_REST_API_URL`, `KV_REST_API_TOKEN`), namespaced by `VERCEL_ENV`.
 */
export const openRedisStore = (env: NodeJS.ProcessEnv = process.env): RecordStore => {
  const url = env['KV_REST_API_URL'];
  const token = env['KV_REST_API_TOKEN'];
  if (!url || !token) {
    throw new Error(
      'KV_REST_API_URL and KV_REST_API_TOKEN must be set: the Upstash integration of the Vercel project provides them.',
    );
  }
  // Values are JWE strings; never let the client parse one as JSON.
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return createRedisStore(redis, env['VERCEL_ENV'] || 'development');
};
