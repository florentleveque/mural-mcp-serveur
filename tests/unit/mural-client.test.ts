import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuralClient } from '../../src/mural-client.js';
import { mockFetchResponse, mockOAuthTokens } from './helpers.js';

// MuralClient instantiates MuralOAuth and MuralRateLimiter internally,
// so both modules are mocked at module level. The hoisted vi.fn() handles
// let each test configure behaviour per call.
const mocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  getStoredTokens: vi.fn(),
  clearTokens: vi.fn(),
  canMakeRequest: vi.fn(),
  consumeRequest: vi.fn(),
  getRateLimitStatus: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../../src/oauth.js', () => ({
  MuralOAuth: class {
    getValidAccessToken = mocks.getValidAccessToken;
    getStoredTokens = mocks.getStoredTokens;
    clearTokens = mocks.clearTokens;
  },
}));

vi.mock('../../src/rate-limiter.js', () => ({
  MuralRateLimiter: class {
    canMakeRequest = mocks.canMakeRequest;
    consumeRequest = mocks.consumeRequest;
    getRateLimitStatus = mocks.getRateLimitStatus;
    reset = mocks.reset;
  },
}));

function createClient(): MuralClient {
  return new MuralClient('client-id', 'client-secret');
}

describe('MuralClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.getValidAccessToken.mockResolvedValue('mock-token');
    mocks.getStoredTokens.mockResolvedValue(mockOAuthTokens());
    mocks.canMakeRequest.mockResolvedValue({ allowed: true });
    mocks.consumeRequest.mockResolvedValue(true);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The client logs retries and failures on stderr; keep test output clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('makeAuthenticatedRequest (via getWorkspace)', () => {
    it('returns parsed JSON and sends the Bearer token on success', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'ws1', name: 'Workspace' }));

      const workspace = await createClient().getWorkspace('ws1');

      expect(workspace).toEqual({ id: 'ws1', name: 'Workspace' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://app.mural.co/api/public/v1/workspaces/ws1');
      expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer mock-token');
    });

    it('returns undefined on 204 No Content', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(204));

      await expect(createClient().getWorkspace('ws1')).resolves.toBeUndefined();
    });

    it('returns undefined on 200 with an empty body', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));

      await expect(createClient().getWorkspace('ws1')).resolves.toBeUndefined();
    });

    it.each([400, 401, 403])('does not retry on HTTP %i client errors', async status => {
      fetchMock.mockResolvedValue(mockFetchResponse(status, { message: 'client error' }));

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('includes the API error message in thrown client errors', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(403, { message: 'Forbidden', errors: ['missing scope'] }));

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow('Forbidden - missing scope');
    });

    it('retries on 500 with exponential backoff then succeeds', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(500, { message: 'oops' }))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      // First retry waits 2^0 * 1000 = 1000ms
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxRetries consecutive 500s', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(mockFetchResponse(500, { message: 'oops' }));

      const promise = createClient().getWorkspace('ws1');
      const expectation = expect(promise).rejects.toThrow('HTTP 500');
      // Backoffs: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(7000);

      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('honours the Retry-After header on 429 then retries', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(429, null, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits and retries when the local rate limiter asks for a short wait', async () => {
      vi.useFakeTimers();
      mocks.canMakeRequest
        .mockResolvedValueOnce({ allowed: false, waitTimeMs: 1000, reason: 'User rate limit' })
        .mockResolvedValueOnce({ allowed: true });
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws immediately when the local rate limiter wait is too long', async () => {
      mocks.canMakeRequest.mockResolvedValue({ allowed: false, waitTimeMs: 60_000, reason: 'App rate limit' });

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow('Rate limit exceeded');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when a rate limit token cannot be consumed', async () => {
      mocks.consumeRequest.mockResolvedValue(false);

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow('Failed to consume rate limit token');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchAllPages (via getMuralWidgets)', () => {
    it('fetches a single page when there is no next cursor', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: [{ id: 'w1' }, { id: 'w2' }] }));

      const widgets = await createClient().getMuralWidgets('m1');

      expect(widgets).toEqual([{ id: 'w1' }, { id: 'w2' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows the next cursor across pages and concatenates results', async () => {
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(200, { value: [{ id: 'w1' }], next: 'cursor-1' }))
        .mockResolvedValueOnce(mockFetchResponse(200, { value: [{ id: 'w2' }], next: 'cursor-2' }))
        .mockResolvedValueOnce(mockFetchResponse(200, { value: [{ id: 'w3' }] }));

      const widgets = await createClient().getMuralWidgets('m1');

      expect(widgets).toEqual([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
      const thirdUrl = fetchMock.mock.calls[2]?.[0] as string;
      expect(secondUrl).toContain('next=cursor-1');
      expect(thirdUrl).toContain('next=cursor-2');
    });

    it('unwraps the widgets key when value is absent', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { widgets: [{ id: 'w1' }] }));

      await expect(createClient().getMuralWidgets('m1')).resolves.toEqual([{ id: 'w1' }]);
    });

    it('accepts a bare array response', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, [{ id: 'w1' }]));

      await expect(createClient().getMuralWidgets('m1')).resolves.toEqual([{ id: 'w1' }]);
    });

    it('rejects when the OAuth token is missing the required scope', async () => {
      mocks.getStoredTokens.mockResolvedValue(mockOAuthTokens({ scope: 'workspaces:read' }));

      await expect(createClient().getMuralWidgets('m1')).rejects.toThrow("missing required scope: murals:read");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('representative endpoint methods', () => {
    it('getWorkspaces unwraps the value array', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: [{ id: 'ws1' }] }));

      await expect(createClient().getWorkspaces()).resolves.toEqual([{ id: 'ws1' }]);
    });

    it('getWorkspaces returns an empty array when value is missing', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, {}));

      await expect(createClient().getWorkspaces()).resolves.toEqual([]);
    });

    it('getWorkspaces forwards limit and offset as query parameters', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: [] }));

      await createClient().getWorkspaces(10, 5);

      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://app.mural.co/api/public/v1/workspaces?limit=10&offset=5');
    });

    it('deleteWidget resolves on 204 and issues a DELETE request', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(204));

      await expect(createClient().deleteWidget('m1', 'w1')).resolves.toBeUndefined();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://app.mural.co/api/public/v1/murals/m1/widgets/w1');
      expect(options.method).toBe('DELETE');
    });
  });
});
