import type { RedisCommands } from '../../../src/auth/record-store.js';

interface Entry {
  value: string | Set<string>;
  /** Epoch ms, read against Date.now() so fake timers drive expiry. */
  exp?: number;
}

/**
 * An in-memory stand-in for the Upstash commands the store uses, with Redis
 * semantics for what the store relies on: PX and NX on SET, GETDEL, sets, and
 * PEXPIRE's NX and GT (a key without expiry counts as infinite for GT).
 */
export const createFakeRedis = () => {
  const entries = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry?.exp !== undefined && entry.exp <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const stringAt = (key: string): string | null => {
    const value = live(key)?.value;
    if (value instanceof Set) throw new Error('WRONGTYPE');
    return value ?? null;
  };
  const setAt = (key: string): Set<string> | undefined => {
    const value = live(key)?.value;
    if (typeof value === 'string') throw new Error('WRONGTYPE');
    return value;
  };
  const validTtl = (ms: number): number => {
    if (!Number.isInteger(ms) || ms <= 0) throw new Error('ERR invalid expire time');
    return ms;
  };

  const commands = {
    get: async (key: string) => stringAt(key),
    getdel: async (key: string) => {
      const value = stringAt(key);
      entries.delete(key);
      return value;
    },
    set: async (key: string, value: string, opts: { px?: number; nx?: boolean } = {}) => {
      if (opts.nx && live(key)) return null;
      entries.set(key, {
        value,
        ...(opts.px === undefined ? {} : { exp: Date.now() + validTtl(opts.px) }),
      });
      return 'OK';
    },
    del: async (...keys: string[]) => {
      if (keys.length === 0) throw new Error("ERR wrong number of arguments for 'del' command");
      return keys.filter((key) => live(key) && entries.delete(key)).length;
    },
    sadd: async (key: string, ...members: string[]) => {
      const set = setAt(key) ?? new Set<string>();
      const before = set.size;
      for (const member of members) set.add(member);
      if (!live(key)) entries.set(key, { value: set });
      return set.size - before;
    },
    smembers: async (key: string) => [...(setAt(key) ?? [])],
    persist: async (key: string) => {
      const entry = live(key);
      if (entry?.exp === undefined) return 0;
      delete entry.exp;
      return 1;
    },
    pexpire: async (key: string, ms: number, option?: string) => {
      const entry = live(key);
      if (!entry) return 0;
      const exp = Date.now() + validTtl(ms);
      if (option === 'NX' && entry.exp !== undefined) return 0;
      if (option === 'GT' && (entry.exp === undefined || exp <= entry.exp)) return 0;
      if (option !== undefined && option !== 'NX' && option !== 'GT') {
        throw new Error(`fake redis: PEXPIRE ${option} is not implemented`);
      }
      entry.exp = exp;
      return 1;
    },
  };

  return {
    redis: commands as unknown as RedisCommands,
    /** Live keys. */
    keys: () => new Set([...entries.keys()].filter((key) => live(key))),
    /** Epoch ms the key expires at, `undefined` without expiry, `'absent'` when missing. */
    expiryOf: (key: string): number | undefined | 'absent' => {
      const entry = live(key);
      return entry === undefined ? 'absent' : entry.exp;
    },
    /** Raw value, for tampering and plaintext checks. */
    raw: (key: string) => live(key)?.value,
    /** Every key and value, for checks that nothing is stored in clear. */
    dump: () =>
      JSON.stringify(
        [...entries].map(([key, { value }]) => [key, value instanceof Set ? [...value] : value]),
      ),
  };
};
