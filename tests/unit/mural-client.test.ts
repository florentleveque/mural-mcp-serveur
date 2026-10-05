import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuralApiError, MuralClient } from '../../src/mural-client.js';
import { mockFetchResponse } from './helpers.js';

// MuralClient receives its token provider: the hoisted vi.fn() handles let
// each test configure behaviour per call.
const mocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  getScopes: vi.fn(),
  invalidateAccessToken: vi.fn(),
}));

const ALL_SCOPES = [
  'workspaces:read',
  'murals:read',
  'murals:write',
  'rooms:read',
  'rooms:write',
  'templates:read',
  'templates:write',
  'identity:read',
];

function createClient(): MuralClient {
  return new MuralClient({
    getValidAccessToken: mocks.getValidAccessToken,
    getScopes: mocks.getScopes,
    invalidateAccessToken: mocks.invalidateAccessToken,
  });
}

describe('MuralClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.getValidAccessToken.mockResolvedValue('mock-token');
    mocks.getScopes.mockResolvedValue(ALL_SCOPES);
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
      expect((options.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer mock-token',
      );
    });

    it('returns undefined on 204 No Content', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(204));

      await expect(createClient().getWorkspace('ws1')).resolves.toBeUndefined();
    });

    it('returns undefined on 200 with an empty body', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 200 }));

      await expect(createClient().getWorkspace('ws1')).resolves.toBeUndefined();
    });

    it.each([400, 403, 404])('does not retry on HTTP %i client errors', async (status) => {
      fetchMock.mockResolvedValue(mockFetchResponse(status, { message: 'client error' }));

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mocks.invalidateAccessToken).not.toHaveBeenCalled();
    });

    it('drops a token Mural rejects with 401 and retries once with a fresh one', async () => {
      mocks.getValidAccessToken.mockResolvedValueOnce('revoked').mockResolvedValueOnce('fresh');
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(401, { code: 'UNAUTHORIZED' }))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      await expect(createClient().getWorkspace('ws1')).resolves.toEqual({ id: 'ws1' });

      expect(mocks.invalidateAccessToken).toHaveBeenCalledExactlyOnceWith('revoked');
      const sent = fetchMock.mock.calls.map(
        ([, options]) => (options as RequestInit).headers as Record<string, string>,
      );
      expect(sent.map((headers) => headers.Authorization)).toEqual([
        'Bearer revoked',
        'Bearer fresh',
      ]);
    });

    it('throws on a second 401 instead of retrying again', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(mockFetchResponse(401, { code: 'UNAUTHORIZED' })),
      );

      const error = await createClient()
        .getWorkspace('ws1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MuralApiError);
      expect((error as MuralApiError).status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mocks.invalidateAccessToken).toHaveBeenCalledTimes(1);
    });

    it('throws a 401 met on the last attempt rather than running out of attempts', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(500))
        .mockResolvedValueOnce(mockFetchResponse(500))
        .mockResolvedValueOnce(mockFetchResponse(500))
        .mockResolvedValueOnce(mockFetchResponse(401, { code: 'UNAUTHORIZED' }));

      const promise = createClient().getWorkspace('ws1');
      const expectation = expect(promise).rejects.toThrow('HTTP 401');
      await vi.advanceTimersByTimeAsync(7000); // backoffs 1s, 2s, 4s

      await expectation;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('includes the API error message in thrown client errors', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(403, { message: 'Forbidden', errors: ['missing scope'] }),
      );

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
      expect(console.warn).toHaveBeenCalledWith(
        'Server error (500). Retrying after 1000ms... (attempt 1/4)',
      );
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
        .mockResolvedValueOnce(
          mockFetchResponse(429, null, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetEpoch),
          }),
        )
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
      fetchMock.mockResolvedValue(
        mockFetchResponse(429, null, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetEpoch),
        }),
      );

      await expect(createClient().getWorkspace('ws1')).rejects.toThrow(
        'Mural API request failed: HTTP 429: Too Many Requests - API rate limit exceeded. Max retries reached or wait time too long.',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to exponential backoff on 429 without any rate-limit header', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(mockFetchResponse(429))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(1000); // 2^0 * 1000

      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expect(console.warn).toHaveBeenCalledWith(
        'API rate limit hit (HTTP 429). Retrying after 2000ms... (attempt 1/4)',
      );
    });

    it.each(['authentication failed', 'authorization denied', 'Rate limit exceeded: upstream'])(
      'rethrows an OAuth error mentioning "%s" without retrying',
      async (message) => {
        mocks.getValidAccessToken.mockRejectedValue(new Error(message));

        await expect(createClient().getWorkspace('ws1')).rejects.toThrow(message);
        expect(mocks.getValidAccessToken).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
      },
    );

    it('retries any other failure after an exponential backoff and logs it', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(mockFetchResponse(200, { id: 'ws1' }));

      const promise = createClient().getWorkspace('ws1');
      await vi.advanceTimersByTimeAsync(1000); // 2^0 * 1000

      expect(fetchMock).toHaveBeenCalledTimes(2);
      await expect(promise).resolves.toEqual({ id: 'ws1' });
      expect(console.warn).toHaveBeenCalledWith(
        'Request failed: TypeError: fetch failed. Retrying after 1000ms... (attempt 1/4)',
      );
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
      mocks.getScopes.mockResolvedValue(['workspaces:read']);

      await expect(createClient().getMuralWidgets('m1')).rejects.toThrow(
        'missing required scope: murals:read',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops at the 100-page cap and reports the truncation', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(mockFetchResponse(200, { value: [{ id: 'w' }], next: 'more' })),
      );

      const widgets = await createClient().getMuralWidgets('m1');

      expect(widgets).toHaveLength(100);
      expect(fetchMock).toHaveBeenCalledTimes(100);
      expect(console.error).toHaveBeenCalledWith(
        'fetchAllPages: reached the 100-page cap for /murals/m1/widgets; results may be truncated.',
      );
    });
  });

  describe('getMuralWidget (single)', () => {
    it('unwraps the value envelope returned by the single-widget endpoint', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { value: { id: 'w1', type: 'sticky note' } }),
      );

      const widget = await createClient().getMuralWidget('m1', 'w1');

      expect(widget).toEqual({ id: 'w1', type: 'sticky note' });
    });

    it('returns the body as-is when there is no value envelope', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { id: 'w1', type: 'shape' }));

      await expect(createClient().getMuralWidget('m1', 'w1')).resolves.toEqual({
        id: 'w1',
        type: 'shape',
      });
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

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://app.mural.co/api/public/v1/workspaces?limit=10&offset=5',
      );
    });

    it('deleteWidget resolves on 204 and issues a DELETE request', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(204));

      await expect(createClient().deleteWidget('m1', 'w1')).resolves.toBeUndefined();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://app.mural.co/api/public/v1/murals/m1/widgets/w1');
      expect(options.method).toBe('DELETE');
    });
  });

  describe('request sent by each endpoint method', () => {
    const note = { x: 1, y: 2, text: 'a', shape: 'rectangle' as const };

    it.each<[string, (c: MuralClient) => Promise<unknown>, string, string | undefined, unknown]>([
      [
        'createMuralFromTemplate',
        (c) => c.createMuralFromTemplate('t 1', 'T', 7, 'f1'),
        '/templates/t%201/murals',
        'POST',
        { title: 'T', roomId: 7, folderId: 'f1' },
      ],
      [
        'createRoom',
        (c) => c.createRoom('ws1', 'R', 'private', 'desc', true),
        '/rooms',
        'POST',
        { name: 'R', type: 'private', workspaceId: 'ws1', description: 'desc', confidential: true },
      ],
      [
        'createMural',
        (c) => c.createMural(7, { title: 'T' }),
        '/murals',
        'POST',
        { roomId: 7, title: 'T' },
      ],
      [
        'updateMural',
        (c) => c.updateMural('m1', { title: 'New' }),
        '/murals/m1',
        'PATCH',
        { title: 'New' },
      ],
      ['deleteMural', (c) => c.deleteMural('m1'), '/murals/m1', 'DELETE', undefined],
      [
        'duplicateMural',
        (c) => c.duplicateMural('m1', 7, 'Copy', { infinite: true }),
        '/murals/m1/duplicate',
        'POST',
        { roomId: 7, title: 'Copy', infinite: true },
      ],
      [
        'exportMural',
        (c) => c.exportMural('m1', 'pdf'),
        '/murals/m1/export',
        'POST',
        { downloadFormat: 'pdf' },
      ],
      [
        'getWorkspaceRooms',
        (c) => c.getWorkspaceRooms('ws1'),
        '/workspaces/ws1/rooms',
        undefined,
        undefined,
      ],
      [
        'getWorkspaceRooms (open only)',
        (c) => c.getWorkspaceRooms('ws1', true),
        '/workspaces/ws1/rooms/open',
        undefined,
        undefined,
      ],
      [
        'getWorkspaceTemplates',
        (c) => c.getWorkspaceTemplates('ws1'),
        '/workspaces/ws1/templates',
        undefined,
        undefined,
      ],
      [
        'getWorkspaceTemplates (without default)',
        (c) => c.getWorkspaceTemplates('ws1', undefined, true),
        '/workspaces/ws1/templates?withoutDefault=true',
        undefined,
        undefined,
      ],
      [
        'getWorkspaceTemplates (search)',
        (c) => c.getWorkspaceTemplates('ws1', ' retro board '),
        '/search/ws1/templates?q=retro+board',
        undefined,
        undefined,
      ],
      [
        'getWorkspaceMurals',
        (c) => c.getWorkspaceMurals('ws1'),
        '/workspaces/ws1/murals',
        undefined,
        undefined,
      ],
      ['getRoomMurals', (c) => c.getRoomMurals('r1'), '/rooms/r1/murals', undefined, undefined],
      ['getMural', (c) => c.getMural('m1'), '/murals/m1', undefined, undefined],
      [
        'getMuralWidgets',
        (c) => c.getMuralWidgets('m1'),
        '/murals/m1/widgets',
        undefined,
        undefined,
      ],
      [
        'getMuralWidget',
        (c) => c.getMuralWidget('m1', 'w1'),
        '/murals/m1/widgets/w1',
        undefined,
        undefined,
      ],
      [
        'createStickyNotes',
        (c) => c.createStickyNotes('m1', [note]),
        '/murals/m1/widgets/sticky-note',
        'POST',
        [note],
      ],
      [
        'updateStickyNote',
        (c) => c.updateStickyNote('m1', 'w1', { text: 'b' }),
        '/murals/m1/widgets/sticky-note/w1',
        'PATCH',
        { text: 'b' },
      ],
      [
        'createShapes',
        (c) => c.createShapes('m1', [{ x: 1 }]),
        '/murals/m1/widgets/shape',
        'POST',
        [{ x: 1 }],
      ],
      [
        'createArrows',
        (c) => c.createArrows('m1', [{ x: 1 }]),
        '/murals/m1/widgets/arrow',
        'POST',
        [{ x: 1 }],
      ],
      [
        'createTextBoxes',
        (c) => c.createTextBoxes('m1', [{ x: 1 }]),
        '/murals/m1/widgets/text-box',
        'POST',
        [{ x: 1 }],
      ],
      [
        'createTitles',
        (c) => c.createTitles('m1', [{ x: 1 }]),
        '/murals/m1/widgets/title',
        'POST',
        [{ x: 1 }],
      ],
      [
        'createAreas',
        (c) => c.createAreas('m1', [{ x: 1 }]),
        '/murals/m1/widgets/area',
        'POST',
        [{ x: 1 }],
      ],
      [
        'updateShape',
        (c) => c.updateShape('m1', 'w1', { x: 2 }),
        '/murals/m1/widgets/shape/w1',
        'PATCH',
        { x: 2 },
      ],
      [
        'updateArrow',
        (c) => c.updateArrow('m1', 'w1', { x: 2 }),
        '/murals/m1/widgets/arrow/w1',
        'PATCH',
        { x: 2 },
      ],
      [
        'updateTextBox',
        (c) => c.updateTextBox('m1', 'w1', { x: 2 }),
        '/murals/m1/widgets/text-box/w1',
        'PATCH',
        { x: 2 },
      ],
      [
        'updateTitle',
        (c) => c.updateTitle('m1', 'w1', { x: 2 }),
        '/murals/m1/widgets/title/w1',
        'PATCH',
        { x: 2 },
      ],
      [
        'updateArea',
        (c) => c.updateArea('m1', 'w1', { x: 2 }),
        '/murals/m1/widgets/area/w1',
        'PATCH',
        { x: 2 },
      ],
    ])('%s sends the expected request', async (_name, call, endpoint, method, body) => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: [] }));

      await call(createClient());

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://app.mural.co/api/public/v1${endpoint}`);
      expect(options.method).toBe(method);
      expect(options.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    });
  });

  describe('scope check before the request', () => {
    it.each<[string, (c: MuralClient) => Promise<unknown>, string]>([
      ['createMuralFromTemplate', (c) => c.createMuralFromTemplate('t1', 'T', 7), 'murals:write'],
      ['createRoom', (c) => c.createRoom('ws1', 'R', 'open'), 'rooms:write'],
      ['createMural', (c) => c.createMural(7), 'murals:write'],
      ['updateMural', (c) => c.updateMural('m1', {}), 'murals:write'],
      ['deleteMural', (c) => c.deleteMural('m1'), 'murals:write'],
      ['duplicateMural', (c) => c.duplicateMural('m1', 7, 'Copy'), 'murals:write'],
      ['exportMural', (c) => c.exportMural('m1', 'pdf'), 'murals:read'],
      ['getExportStatus', (c) => c.getExportStatus('m1', 'e1'), 'murals:read'],
      ['getWorkspaceMurals', (c) => c.getWorkspaceMurals('ws1'), 'murals:read'],
      ['getRoomMurals', (c) => c.getRoomMurals('r1'), 'murals:read'],
      ['getMural', (c) => c.getMural('m1'), 'murals:read'],
      ['getMuralWidget', (c) => c.getMuralWidget('m1', 'w1'), 'murals:read'],
      ['deleteWidget', (c) => c.deleteWidget('m1', 'w1'), 'murals:write'],
      ['createStickyNotes', (c) => c.createStickyNotes('m1', []), 'murals:write'],
      ['updateStickyNote', (c) => c.updateStickyNote('m1', 'w1', {}), 'murals:write'],
      ['createShapes', (c) => c.createShapes('m1', []), 'murals:write'],
      ['updateShape', (c) => c.updateShape('m1', 'w1', {}), 'murals:write'],
    ])('%s refuses without its required scope', async (_name, call, scope) => {
      mocks.getScopes.mockResolvedValue(['workspaces:read']);

      await expect(call(createClient())).rejects.toThrow(
        `Permission denied: User missing required scope: ${scope}. Available scopes: workspaces:read. Please ensure your Mural OAuth app has '${scope}' scope and re-authenticate.`,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('API scope errors mapped to a permission-denied message', () => {
    const scopeAware: [string, (c: MuralClient) => Promise<unknown>, string][] = [
      ['getWorkspaceRooms', (c) => c.getWorkspaceRooms('ws1'), 'rooms:read'],
      ['getWorkspaceTemplates', (c) => c.getWorkspaceTemplates('ws1'), 'templates:read'],
      ['getMuralWidgets', (c) => c.getMuralWidgets('m1'), 'murals:read'],
      ['getWorkspaceMurals', (c) => c.getWorkspaceMurals('ws1'), 'murals:read'],
      ['getRoomMurals', (c) => c.getRoomMurals('r1'), 'murals:read'],
      ['getMural', (c) => c.getMural('m1'), 'murals:read'],
    ];
    const permissionDenied = (scope: string) =>
      `Permission denied: User has required scope: ${scope}. Please ensure your Mural OAuth app has '${scope}' scope and re-authenticate.`;

    it.each(scopeAware)('%s maps a bare HTTP 403', async (_name, call, scope) => {
      fetchMock.mockResolvedValue(mockFetchResponse(403, { message: 'Forbidden' }));

      await expect(call(createClient())).rejects.toThrow(permissionDenied(scope));
    });

    it.each(scopeAware)(
      '%s maps an INVALID_SCOPE code on another status',
      async (_name, call, scope) => {
        fetchMock.mockResolvedValue(mockFetchResponse(400, { code: 'INVALID_SCOPE' }));

        await expect(call(createClient())).rejects.toThrow(permissionDenied(scope));
      },
    );

    it.each(scopeAware)('%s rethrows other API errors unchanged', async (_name, call) => {
      fetchMock.mockResolvedValue(mockFetchResponse(404, { code: 'NOT_FOUND' }));

      const error = await call(createClient()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MuralApiError);
      expect((error as MuralApiError).status).toBe(404);
    });
  });

  describe('token provider', () => {
    it('getUserScopes returns the scopes of the provider', async () => {
      mocks.getScopes.mockResolvedValue(['murals:read']);

      await expect(createClient().getUserScopes()).resolves.toEqual(['murals:read']);
    });

    it('getUserScopes returns no scope and logs when the provider fails', async () => {
      const failure = new Error('token store unavailable');
      mocks.getScopes.mockRejectedValue(failure);

      await expect(createClient().getUserScopes()).resolves.toEqual([]);
      expect(console.error).toHaveBeenCalledWith('Failed to get user scopes:', failure);
    });

    it('asks the provider for a token on every request, with no shared cache', async () => {
      mocks.getValidAccessToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
      fetchMock.mockImplementation(() => Promise.resolve(mockFetchResponse(200, { id: 'ws1' })));
      const client = createClient();

      await Promise.all([client.getWorkspace('ws1'), createClient().getWorkspace('ws1')]);

      const authHeaders = fetchMock.mock.calls.map(
        ([, options]) =>
          (options as RequestInit & { headers: Record<string, string> }).headers.Authorization,
      );
      expect(new Set(authHeaders)).toEqual(new Set(['Bearer first', 'Bearer second']));
    });

    it('debugWorkspacesAPI sends the provider token', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: [] }));

      await createClient().debugWorkspacesAPI();

      const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://app.mural.co/api/public/v1/workspaces');
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
    });
  });

  describe('export status & URL', () => {
    it('getExportStatus unwraps the value envelope and targets the exports endpoint', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(200, { value: { url: 'https://s3.example/export.pdf' } }),
      );

      const status = await createClient().getExportStatus('m1', 'e1');

      expect(status).toEqual({ url: 'https://s3.example/export.pdf' });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://app.mural.co/api/public/v1/murals/m1/exports/e1',
      );
    });

    it('getExportStatus returns a payload without url while the export is still processing', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: {} }));

      await expect(createClient().getExportStatus('m1', 'e1')).resolves.toEqual({});
    });

    it('getExportStatus treats a 404 EXPORT_NOT_FOUND as still processing instead of throwing', async () => {
      // Real API behaviour: while the job runs, Mural returns 404 EXPORT_NOT_FOUND
      // ("...or the process has not finished yet"), not a 200 with an empty value.
      fetchMock.mockResolvedValue(
        mockFetchResponse(404, {
          code: 'EXPORT_NOT_FOUND',
          message: 'The export was not found or the process has not finished yet.',
        }),
      );

      await expect(createClient().getExportStatus('m1', 'e1')).resolves.toEqual({});
    });

    it('getExportStatus still throws on other API errors', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(403, { code: 'INVALID_SCOPE', message: 'Invalid scope' }),
      );

      await expect(createClient().getExportStatus('m1', 'e1')).rejects.toThrow('HTTP 403');
      expect(console.error).toHaveBeenCalledWith(
        'Failed to get export status for mural m1 (export e1):',
        expect.any(MuralApiError),
      );
    });

    it.each([
      ['a 404 with another code', 404, 'MURAL_NOT_FOUND'],
      ['an EXPORT_NOT_FOUND code on another status', 400, 'EXPORT_NOT_FOUND'],
    ])('getExportStatus throws on %s', async (_label, status, code) => {
      fetchMock.mockResolvedValue(mockFetchResponse(status, { code }));

      await expect(createClient().getExportStatus('m1', 'e1')).rejects.toThrow(`HTTP ${status}`);
    });

    it('getExportStatus only treats a MuralApiError as "still processing"', async () => {
      // An OAuth failure is a plain Error: even one carrying the same fields
      // must surface instead of reading as an unfinished export.
      const foreign = Object.assign(new Error('authentication failed'), {
        status: 404,
        errorCode: 'EXPORT_NOT_FOUND',
      });
      mocks.getValidAccessToken.mockRejectedValue(foreign);

      await expect(createClient().getExportStatus('m1', 'e1')).rejects.toBe(foreign);
    });

    it('getExportUrl returns the signed URL once the export is ready, without fetching it', async () => {
      const ready = {
        exportId: 'e1',
        muralId: 'm1',
        url: 'https://s3.example/export.pdf?signature=abc',
        expireOn: 1_780_000_000_000,
      };
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: ready }));

      await expect(createClient().getExportUrl('m1', 'e1')).resolves.toEqual({
        ready: true,
        url: ready.url,
        status: ready,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // the status call only
    });

    it('getExportUrl returns ready:false without a url while the export is processing', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(200, { value: {} }));

      await expect(createClient().getExportUrl('m1', 'e1')).resolves.toEqual({
        ready: false,
        status: {},
      });
    });

    it('getExportUrl returns ready:false on a 404 EXPORT_NOT_FOUND status', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(404, {
          code: 'EXPORT_NOT_FOUND',
          message: 'The export was not found or the process has not finished yet.',
        }),
      );

      await expect(createClient().getExportUrl('m1', 'e1')).resolves.toEqual({
        ready: false,
        status: {},
      });
    });
  });

  describe('MuralApiError', () => {
    it('exposes status, errorCode and apiMessage from the API error body', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(404, { code: 'MURAL_NOT_FOUND', message: 'Mural not found' }),
      );

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
      fetchMock.mockResolvedValue(
        new Response('plain text', { status: 400, statusText: 'Bad Request' }),
      );

      const error = await createClient()
        .getWorkspace('ws1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MuralApiError);
      expect((error as MuralApiError).errorCode).toBeUndefined();
      expect((error as MuralApiError).message).toBe(
        'Mural API request failed: HTTP 400: Bad Request',
      );
    });

    it('maps an API 403 INVALID_SCOPE to a permission-denied message in scope-aware methods', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(403, { code: 'INVALID_SCOPE', message: 'Invalid scope' }),
      );

      await expect(createClient().getMuralWidgets('m1')).rejects.toThrow(/^Permission denied/);
    });
  });
});
