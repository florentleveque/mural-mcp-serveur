// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).

import {
  isUpstreamAuthError,
  type MuralTokenSet,
  type MuralUpstream,
  refreshMuralTokens,
} from './mural-upstream.js';
import type { RecordStore } from './record-store.js';
import { hashId, type SealedCollection } from './store.js';

// How long the Mural tokens of a grant are kept at rest without use. Mural does
// not document its refresh-token lifetime: a refusal ends the grant sooner.
export const MURAL_TOKENS_TTL_S = 90 * 86400;
// Refresh a little before Mural's expiry, for clock skew and a request in flight.
export const MURAL_REFRESH_MARGIN_MS = 60_000;
// Longer than a token request may take (10 s), so a live holder never loses
// the lock; short enough that a crashed one blocks its grant briefly.
export const REFRESH_LOCK_TTL_MS = 15_000;
const REFRESH_LOCK_POLL_MS = 100;

export interface MuralGrants {
  /** Record the Mural tokens obtained at sign-in for one of our grants. */
  save(grantId: string, tokens: MuralTokenSet): Promise<void>;
  /**
   * A Mural access token valid for at least the refresh margin, refreshing (and
   * persisting the rotated set) when needed. Rejects with a grant-unavailable
   * error when the grant has no Mural tokens or Mural refuses the refresh: the
   * user must sign in again. Any other failure is rethrown and the grant kept.
   */
  accessToken(grantId: string): Promise<string>;
  remove(grantId: string): Promise<void>;
}

export interface MuralGrantsOptions {
  readonly records: SealedCollection<MuralTokenSet>;
  /** Holds the per-grant refresh locks. */
  readonly store: RecordStore;
  readonly upstream: MuralUpstream;
  /** How long before Mural's expiry to refresh; at least our access-token lifetime. */
  readonly refreshMarginMs?: number | undefined;
  readonly refresh?: typeof refreshMuralTokens | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const grantUnavailableError = (): Error =>
  Object.assign(new Error('The Mural authorization behind this grant is no longer valid.'), {
    name: 'MuralGrantUnavailable',
  });

export const isGrantUnavailableError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'MuralGrantUnavailable';

// RFC 6749: an invalid or expired refresh token is a 400, a bad client a 401.
const isRefusal = (err: unknown): boolean =>
  isUpstreamAuthError(err) && (err.status === 400 || err.status === 401);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mural tokens per grant of ours. A refresh may rotate Mural's refresh token,
 * so two concurrent refreshes would spend the same one: the refresh holds a
 * per-grant Redis lock, across every instance. Reads that find a fresh token
 * never take it.
 */
export const createMuralGrants = (options: MuralGrantsOptions): MuralGrants => {
  const { records, store, upstream } = options;
  const margin = options.refreshMarginMs ?? MURAL_REFRESH_MARGIN_MS;
  const refresh = options.refresh ?? refreshMuralTokens;
  // Read at call time, so fake clocks in tests reach it.
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? wait;

  const needsRefresh = (tokens: MuralTokenSet): boolean => tokens.expiresAt - now() <= margin;

  const persist = async (grantId: string, tokens: MuralTokenSet): Promise<void> => {
    // Every token minted from these would outlive the Mural one behind it.
    if (needsRefresh(tokens)) {
      console.warn(
        `Mural issued an access token that expires within the refresh margin (${margin} ms): tokens minted from it outlive it. Mural may have shortened its token lifetime.`,
      );
    }
    await records.set(grantId, tokens, MURAL_TOKENS_TTL_S);
  };

  const withLock = async <R>(grantId: string, fn: () => Promise<R>): Promise<R> => {
    const lock = `MuralRefreshLock:${hashId(grantId)}`;
    const deadline = now() + REFRESH_LOCK_TTL_MS;
    // Stryker disable next-line StringLiteral: only the key's presence is the lock; its value is never read.
    while (!(await store.setIfAbsent(lock, '1', REFRESH_LOCK_TTL_MS))) {
      if (now() >= deadline) {
        throw new Error('Timed out waiting for another refresh of this Mural grant.');
      }
      await sleep(REFRESH_LOCK_POLL_MS);
    }
    try {
      return await fn();
    } finally {
      await store.delete(lock);
    }
  };

  const refreshed = async (grantId: string, refreshToken: string): Promise<string> => {
    let fresh: MuralTokenSet;
    try {
      fresh = await refresh(upstream, refreshToken);
    } catch (err) {
      // Only Mural refusing the refresh token ends the grant. An outage may
      // leave that token unspent, so the next attempt can still succeed.
      if (!isRefusal(err)) throw err;
      console.warn(`Mural refused a refresh: ${(err as Error).message}`);
      await records.delete(grantId);
      throw grantUnavailableError();
    }
    await persist(grantId, fresh);
    return fresh.accessToken;
  };

  return {
    save: persist,
    // Under the lock: a refresh already running would otherwise write the
    // rotated tokens back after the removal.
    remove: (grantId) => withLock(grantId, () => records.delete(grantId)),
    accessToken: async (grantId) => {
      const tokens = await records.get(grantId);
      if (!tokens) throw grantUnavailableError();
      if (!needsRefresh(tokens)) return tokens.accessToken;
      return withLock(grantId, async () => {
        // Another instance may have refreshed while this one waited.
        const latest = await records.get(grantId);
        if (!latest) throw grantUnavailableError();
        if (!needsRefresh(latest)) return latest.accessToken;
        if (!latest.refreshToken) throw grantUnavailableError();
        return refreshed(grantId, latest.refreshToken);
      });
    },
  };
};
