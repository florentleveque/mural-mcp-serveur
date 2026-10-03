import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuralOAuth, parseRedirectUri, type CallbackEndpoint } from '../../src/oauth.js';

// The local OAuth callback server is exercised for real: an HTTP server bound
// to a free loopback port, hit with plain http.get requests.

const STATE = 'expected-state-0123456789abcdef';

interface SimpleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(url: string): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, res => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the callback server and wait until it accepts connections. The result
 * promise is wrapped: returning it bare from an async function would await it.
 */
async function startServer(endpoint: CallbackEndpoint): Promise<{ result: Promise<{ code: string }> }> {
  const promise = (new MuralOAuth('client-id') as any).startCallbackServer(STATE, endpoint) as Promise<{ code: string }>;
  // Keep a rejection from being reported as unhandled before the test awaits it.
  promise.catch(() => undefined);
  await vi.waitFor(() => {
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('OAuth callback server listening'));
  });
  return { result: promise };
}

describe('OAuth callback server', () => {
  let port: number;
  let base: string;
  let endpoint: CallbackEndpoint;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    port = await getFreePort();
    base = `http://127.0.0.1:${port}`;
    endpoint = { hosts: ['127.0.0.1'], port, pathname: '/callback' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the code on a callback carrying the expected state', async () => {
    const { result } = await startServer(endpoint);

    const res = await get(`${base}/callback?code=auth-code&state=${STATE}`);

    expect(res.status).toBe(200);
    await expect(result).resolves.toEqual({ code: 'auth-code' });
  });

  it('serves static pages with a restrictive CSP and never echoes request parameters', async () => {
    const { result } = await startServer(endpoint);

    const res = await get(`${base}/callback?error=${encodeURIComponent('<script>alert(1)</script>')}&state=${STATE}`);

    expect(res.status).toBe(400);
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('alert');
    expect(res.body).not.toContain(STATE);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The error code reaches the logs/tool result sanitised.
    await expect(result).rejects.toThrow('OAuth error: scriptalert1script');
  });

  it('answers 400 to a wrong or missing state and keeps waiting for the real callback', async () => {
    const { result } = await startServer(endpoint);

    const wrongState = await get(`${base}/callback?code=forged&state=wrong`);
    const missingState = await get(`${base}/callback?code=forged`);
    const forgedError = await get(`${base}/callback?error=access_denied&state=wrong`);

    expect([wrongState.status, missingState.status, forgedError.status]).toEqual([400, 400, 400]);
    expect(wrongState.body).not.toContain(STATE);

    await get(`${base}/callback?code=real-code&state=${STATE}`);
    await expect(result).resolves.toEqual({ code: 'real-code' });
  });

  it('never logs the state values', async () => {
    const { result } = await startServer(endpoint);

    await get(`${base}/callback?code=forged&state=attacker-state`);
    await get(`${base}/callback?code=real-code&state=${STATE}`);
    await result;

    const logged = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(arg => String(arg))
      .join('\n');
    expect(logged).toContain('state: mismatch');
    expect(logged).toContain('state: match');
    expect(logged).not.toContain(STATE);
    expect(logged).not.toContain('attacker-state');
  });

  it('rejects a callback with the expected state but no code', async () => {
    const { result } = await startServer(endpoint);

    const res = await get(`${base}/callback?state=${STATE}`);

    expect(res.status).toBe(400);
    await expect(result).rejects.toThrow('No authorization code received');
  });

  it('answers 404 outside the redirect URI path and keeps waiting', async () => {
    const custom = { ...endpoint, pathname: '/oauth/cb' };
    const { result } = await startServer(custom);

    expect((await get(`${base}/callback?code=c&state=${STATE}`)).status).toBe(404);
    expect((await get(`${base}/oauth/cb/extra?code=c&state=${STATE}`)).status).toBe(404);

    await get(`${base}/oauth/cb?code=c&state=${STATE}`);
    await expect(result).resolves.toEqual({ code: 'c' });
  });

  it('listens on the loopback addresses only, on the port of the redirect URI', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen');
    const { result } = await startServer(parseRedirectUri(`http://localhost:${port}/callback`));

    const hosts = listen.mock.calls.map(call => call[1]);
    expect(hosts).toEqual(['127.0.0.1', '::1']);
    expect(listen.mock.calls.every(call => call[0] === port)).toBe(true);

    await get(`${base}/callback?code=c&state=${STATE}`);
    await expect(result).resolves.toEqual({ code: 'c' });
  });

  it('clears the 5 minute timeout once settled', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { result } = await startServer(endpoint);
    const callIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === 5 * 60 * 1000);
    const authTimeout = setTimeoutSpy.mock.results[callIndex]?.value;
    expect(authTimeout).toBeDefined();

    await get(`${base}/callback?code=c&state=${STATE}`);
    await result;

    expect(clearTimeoutSpy).toHaveBeenCalledWith(authTimeout);
  });

  it('rejects with a clear error when the port is already in use', async () => {
    const blocker = http.createServer();
    await new Promise<void>(resolve => blocker.listen(port, '127.0.0.1', resolve));

    try {
      await expect((new MuralOAuth('client-id') as any).startCallbackServer(STATE, endpoint)).rejects.toThrow(`Port ${port} is already in use`);
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});

describe('parseRedirectUri', () => {
  it('derives port and path, listening on both loopback families for localhost', () => {
    expect(parseRedirectUri('http://localhost:8080/cb')).toEqual({ hosts: ['127.0.0.1', '::1'], port: 8080, pathname: '/cb' });
  });

  it('keeps the default redirect URI behaviour (port 3000, /callback)', () => {
    expect(parseRedirectUri('http://localhost:3000/callback')).toEqual({ hosts: ['127.0.0.1', '::1'], port: 3000, pathname: '/callback' });
  });

  it('binds a single family for an explicit loopback address', () => {
    expect(parseRedirectUri('http://127.0.0.1:4000/callback').hosts).toEqual(['127.0.0.1']);
    expect(parseRedirectUri('http://[::1]:4000/callback').hosts).toEqual(['::1']);
  });

  it('defaults to port 80 when the URI has no port', () => {
    expect(parseRedirectUri('http://localhost/callback').port).toBe(80);
  });

  it.each([
    ['https://localhost:3000/callback', 'must use http://'],
    ['http://example.com:3000/callback', 'must point to localhost'],
    ['http://0.0.0.0:3000/callback', 'must point to localhost'],
    ['not a uri', 'Invalid redirect URI'],
  ])('rejects %s', (uri, message) => {
    expect(() => parseRedirectUri(uri)).toThrow(message);
  });
});
