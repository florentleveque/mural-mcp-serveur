import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleLogger } from '../../../src/auth/log.js';

describe('consoleLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON line per event, at its level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLogger.warn('oauth_client_fetch_failed', { status: 403 });
    consoleLogger.error('oauth_server_error', { error: 'boom' });
    consoleLogger.warn('bare');
    expect(warn.mock.calls).toEqual([
      ['{"event":"oauth_client_fetch_failed","status":403}'],
      ['{"event":"bare"}'],
    ]);
    expect(error.mock.calls).toEqual([['{"event":"oauth_server_error","error":"boom"}']]);
  });
});
