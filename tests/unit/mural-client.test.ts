import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuralApiError, MuralClient } from '../../src/mural-client.js';
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

// downloadExport writes the fetched export file to disk via fs/promises.
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
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
      fetchMock.mockResolvedValueOnce(mockFetchResponse(500, { message: 'oops' })).mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

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

    it('derives the 429 wait time from x-ratelimit-reset when the user bucket is exhausted', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_000_000); // round timestamp so epoch math is exact
      const resetEpoch = Date.now() / 1000 + 2; // 2s ahead, in seconds
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(429, null, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) }))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('derives the 429 wait time from x-ratelimit-app-reset when the app bucket is exhausted', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_000_000);
      const resetEpoch = Date.now() / 1000 + 1;
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse(429, null, {
            'x-ratelimit-remaining': '5',
            'x-ratelimit-app-remaining': '0',
            'x-ratelimit-app-reset': String(resetEpoch),
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(1000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on 429 when the reset is beyond the 30s cap', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000_000_000);
      const resetEpoch = Date.now() / 1000 + 60; // 60s ahead
      fetchMock.mockResolvedValue(mockFetchResponse(429, null, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) }));

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow('API rate limit exceeded');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to exponential backoff on 429 without any rate-limit header', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(mockFetchResponse(429)).mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(1000); // 2^0 * 1000

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('honours the Retry-After header on 429 then retries', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(mockFetchResponse(429, null, { 'Retry-After': '2' })).mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(2000);

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits and retries when the local rate limiter asks for a short wait', async () => {
      vi.useFakeTimers();
      mocks.canMakeRequest.mockResolvedValueOnce({ allowed: false, waitTimeMs: 1000, reason: 'User rate limit' }).mockResolvedValueOnce({ allowed: true });
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

      await expect(createClient().getMuralWidgets('m1')).rejects.toThrow('missing required scope: murals:read');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getMuralWidget (single)', () => {
    it('unwraps the value envelope returned by the single-widget endpoint', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: { id: 'w1', type: 'sticky note' } }));

      const widget = await createClient().getMuralWidget('m1', 'w1');

      expect(widget).toEqual({ id: 'w1', type: 'sticky note' });
    });

    it('returns the body as-is when there is no value envelope', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'w1', type: 'shape' }));

      await expect(createClient().getMuralWidget('m1', 'w1')).resolves.toEqual({ id: 'w1', type: 'shape' });
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

  describe('export status & download', () => {
    it('getExportStatus unwraps the value envelope and targets the exports endpoint', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: { url: 'https://s3.example/export.pdf' } }));

      const status = await createClient().getExportStatus('m1', 'e1');

      expect(status).toEqual({ url: 'https://s3.example/export.pdf' });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://app.mural.co/api/public/v1/murals/m1/exports/e1');
    });

    it('getExportStatus returns a payload without url while the export is still processing', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: {} }));

      await expect(createClient().getExportStatus('m1', 'e1')).resolves.toEqual({});
    });

    it('downloadExport writes the file to outputPath when the export is ready', async () => {
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(200, { value: { url: 'https://s3.example/export.pdf' } }))
        .mockResolvedValueOnce(new Response('PDF-BYTES', { status: 200 }));

      const result = await createClient().downloadExport('m1', 'e1', '/tmp/out/export.pdf');

      expect(result.ready).toBe(true);
      expect(result.path).toBe('/tmp/out/export.pdf');
      expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith('/tmp/out', { recursive: true });
      expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith('/tmp/out/export.pdf', expect.any(Buffer));
      // The signed URL is fetched raw, without the Bearer header used for Mural API calls.
      const [, downloadOptions] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
      expect(downloadOptions).toBeUndefined();
    });

    it('downloadExport does not download or write when the export is not ready yet', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: {} }));

      const result = await createClient().downloadExport('m1', 'e1', '/tmp/out/export.pdf');

      expect(result.ready).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // status only, no download attempt
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    });
  });

  describe('MuralApiError', () => {
    it('exposes status, errorCode and apiMessage from the API error body', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, { code: 'MURAL_NOT_FOUND', message: 'Mural not found' }));

      const error = await createClient()
        .getWorkspace('ws1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MuralApiError);
      const apiError = error as MuralApiError;
      expect(apiError.status).toBe(404);
      expect(apiError.errorCode).toBe('MURAL_NOT_FOUND');
      expect(apiError.apiMessage).toBe('Mural not found');
      expect(apiError.message).toContain('HTTP 404');
    });

    it('marks 4xx errors as nonRetryable and 5xx as retryable', () => {
      expect(new MuralApiError(403, 'Forbidden').nonRetryable).toBe(true);
      expect(new MuralApiError(429, 'Too Many Requests').nonRetryable).toBe(true); // only thrown once retries are exhausted
      expect(new MuralApiError(500, 'Server Error').nonRetryable).toBe(false);
    });

    it('keeps a message without API details when the error body is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('plain text', { status: 400, statusText: 'Bad Request' }));

      const error = await createClient()
        .getWorkspace('ws1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MuralApiError);
      expect((error as MuralApiError).errorCode).toBeUndefined();
      expect((error as MuralApiError).message).toBe('Mural API request failed: HTTP 400: Bad Request');
    });

    it('maps an API 403 INVALID_SCOPE to a permission-denied message in scope-aware methods', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(403, { code: 'INVALID_SCOPE', message: 'Invalid scope' }));

      await expect(createClient().getMuralWidgets('m1')).rejects.toThrow(/^Permission denied/);
    });
  });
});
