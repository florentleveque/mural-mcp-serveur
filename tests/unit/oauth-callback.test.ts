import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuralOAuth } from '../../src/oauth.js';

type Handler = (req: { url?: string }, res: FakeResponse) => void;

interface FakeResponse {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

// A fake node:http server: captures the request handler so a test can drive
// the callback without binding port 3000.
const fake = vi.hoisted(() => ({ handler: null as unknown, server: null as unknown }));

vi.mock('node:http', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    default: {
      createServer: (handler: unknown) => {
        fake.handler = handler;
        const server = Object.assign(new Emitter(), {
          listen: vi.fn((_port: number, onListening: () => void) => onListening()),
          close: vi.fn(),
        });
        fake.server = server;
        return server;
      },
    },
  };
});

function startServer(expectedState?: string): Promise<{ code: string; state?: string }> {
  return (new MuralOAuth('client-id') as any).startCallbackServer(expectedState);
}

function request(url: string): FakeResponse {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  (fake.handler as Handler)({ url }, res);
  return res;
}

describe('MuralOAuth callback server', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the code and logs that a code was received', async () => {
    const result = startServer('s1');

    const res = request('/callback?code=abc&state=s1');

    await expect(result).resolves.toEqual({ code: 'abc', state: 's1' });
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    expect(console.error).toHaveBeenCalledWith(
      'Callback received - Code: present, State: s1, Expected: s1',
    );
  });

  it('answers a second callback with "Already processed"', async () => {
    const result = startServer('s1');
    request('/callback?code=abc&state=s1');
    await result;

    const res = request('/callback?code=abc&state=s1');

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'text/html' });
    expect(res.end).toHaveBeenCalledWith(
      '<h1>Already processed</h1><p>Authentication already handled. You can close this window.</p>',
    );
  });

  it('rejects a callback without code and logs that the code is missing', async () => {
    const result = startServer('s1');

    const res = request('/callback?state=s1');

    await expect(result).rejects.toThrow('No authorization code received');
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
    expect(console.error).toHaveBeenCalledWith(
      'Callback received - Code: missing, State: s1, Expected: s1',
    );
  });

  it('rejects a callback whose state does not match', async () => {
    const result = startServer('s1');

    const res = request('/callback?code=abc&state=other');

    await expect(result).rejects.toThrow('Invalid state parameter. Expected: s1, Got: other');
    expect(console.error).toHaveBeenCalledWith(
      'State mismatch - Expected: "s1", Received: "other"',
    );
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'text/html' });
    expect(res.end).toHaveBeenCalledWith(
      '<h1>Error</h1><p>Invalid state parameter. Expected: s1, Got: other</p>',
    );
  });

  it('rejects with the OAuth error the provider sent back', async () => {
    const result = startServer('s1');

    request('/callback?error=access_denied&state=s1');

    await expect(result).rejects.toThrow('OAuth error: access_denied');
  });

  it('rejects when the server fails to start', async () => {
    const result = startServer('s1');

    (fake.server as EventEmitter).emit('error', new Error('EADDRINUSE'));

    await expect(result).rejects.toThrow('EADDRINUSE');
  });
});
