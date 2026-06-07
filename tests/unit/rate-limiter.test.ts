import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuralRateLimiter } from '../../src/rate-limiter.js';

// Rate limit state persistence goes through fs/promises
// (~/.mural-mcp-rate-limit.json).
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

/** Build a persisted RateLimitState as stored on disk. */
function persistedState(userTokens: number, lastUpdated: number) {
  const now = Date.now();
  return JSON.stringify({
    userBucket: { capacity: 25, tokens: userTokens, refillRate: 25, lastRefill: now, refillIntervalMs: 1000 },
    appBucket: { capacity: 10000, tokens: 10000, refillRate: 10000 / 60, lastRefill: now, refillIntervalMs: 60000 },
    lastUpdated,
  });
}

describe('MuralRateLimiter', () => {
  beforeEach(() => {
    // Freeze time: bucket refill depends on Date.now(), so tests advance
    // the clock explicitly when refill behaviour is under test.
    vi.useFakeTimers();
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('starts with full buckets at the default capacities (user 25/s, app 10000/min)', async () => {
      const status = await new MuralRateLimiter({ persistState: false }).getRateLimitStatus();

      expect(status.user.capacity).toBe(25);
      expect(status.user.tokensRemaining).toBe(25);
      expect(status.app.capacity).toBe(10000);
      expect(status.app.tokensRemaining).toBe(10000);
    });

    it('honours custom capacities', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 2, appRequestsPerMinute: 50, persistState: false });
      const status = await limiter.getRateLimitStatus();

      expect(status.user.capacity).toBe(2);
      expect(status.app.capacity).toBe(50);
    });
  });

  describe('canMakeRequest', () => {
    it('allows requests while tokens remain', async () => {
      const limiter = new MuralRateLimiter({ persistState: false });

      await expect(limiter.canMakeRequest()).resolves.toEqual({ allowed: true });
    });

    it('denies with a wait time and reason when the user bucket is empty', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 2, persistState: false });
      await limiter.consumeRequest();
      await limiter.consumeRequest();

      const result = await limiter.canMakeRequest();

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('User rate limit exceeded');
      expect(result.waitTimeMs).toBeGreaterThan(0);
    });

    it('denies when the app bucket is empty even if the user bucket has tokens', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 10, appRequestsPerMinute: 1, persistState: false });
      await limiter.consumeRequest();

      const result = await limiter.canMakeRequest();

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Application rate limit exceeded');
    });
  });

  describe('consumeRequest', () => {
    it('decrements both buckets by one token', async () => {
      const limiter = new MuralRateLimiter({ persistState: false });

      await expect(limiter.consumeRequest()).resolves.toBe(true);

      const status = await limiter.getRateLimitStatus();
      expect(status.user.tokensRemaining).toBe(24);
      expect(status.app.tokensRemaining).toBe(9999);
    });

    it('returns false once a bucket is exhausted', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 1, persistState: false });

      await expect(limiter.consumeRequest()).resolves.toBe(true);
      await expect(limiter.consumeRequest()).resolves.toBe(false);
    });
  });

  describe('refill', () => {
    it('refills tokens as time passes', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 2, persistState: false });
      await limiter.consumeRequest();
      await limiter.consumeRequest();
      await expect(limiter.canMakeRequest()).resolves.toMatchObject({ allowed: false });

      vi.advanceTimersByTime(1000); // 1s at 2 tokens/s refills the bucket

      await expect(limiter.canMakeRequest()).resolves.toEqual({ allowed: true });
    });

    it('caps refilled tokens at the bucket capacity', async () => {
      const limiter = new MuralRateLimiter({ userRequestsPerSecond: 2, persistState: false });
      await limiter.consumeRequest();

      vi.advanceTimersByTime(60_000); // far more than needed to refill

      const status = await limiter.getRateLimitStatus();
      expect(status.user.tokensRemaining).toBe(2);
    });
  });

  describe('state persistence', () => {
    it('saves state after a consumed request when persistState is enabled', async () => {
      const limiter = new MuralRateLimiter();

      await limiter.consumeRequest();

      expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.mural-mcp-rate-limit.json'), expect.any(String));
    });

    it('never touches the filesystem when persistState is disabled', async () => {
      const limiter = new MuralRateLimiter({ persistState: false });

      await limiter.consumeRequest();
      await limiter.canMakeRequest();

      expect(fs.readFile).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('loads a recent persisted state from disk', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(persistedState(3, Date.now() - 1000));

      const status = await new MuralRateLimiter().getRateLimitStatus();

      expect(status.user.tokensRemaining).toBe(3);
    });

    it('ignores a persisted state older than 5 minutes', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(persistedState(3, Date.now() - 6 * 60 * 1000));

      const status = await new MuralRateLimiter().getRateLimitStatus();

      expect(status.user.tokensRemaining).toBe(25); // fresh default state
    });

    it('falls back to a fresh state when the file is missing', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

      const status = await new MuralRateLimiter().getRateLimitStatus();

      expect(status.user.tokensRemaining).toBe(25);
    });
  });

  describe('reset', () => {
    it('restores full buckets and removes the persisted state file', async () => {
      const limiter = new MuralRateLimiter({ persistState: false });
      await limiter.consumeRequest();

      await limiter.reset();

      const status = await limiter.getRateLimitStatus();
      expect(status.user.tokensRemaining).toBe(25);
      expect(status.app.tokensRemaining).toBe(10000);
    });

    it('deletes the state file when persistState is enabled', async () => {
      await new MuralRateLimiter().reset();

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.mural-mcp-rate-limit.json'));
    });
  });
});
