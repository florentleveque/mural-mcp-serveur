import { describe, expect, it, vi } from 'vitest';

import { utilityTools } from '../../../src/tools/utilities.js';
import { callTool, toolContext } from '../helpers.js';

const ALL_SCOPES = [
  'workspaces:read',
  'rooms:read',
  'rooms:write',
  'murals:read',
  'murals:write',
  'templates:read',
  'templates:write',
  'identity:read',
];

function call(name: string, client: Record<string, unknown>) {
  return callTool(utilityTools, name, {}, toolContext(client));
}

describe('test-connection', () => {
  it.each([
    [true, 'Successfully connected to Mural API'],
    [false, 'Failed to connect to Mural API'],
  ])('reports connected: %s', async (connected, message) => {
    const testConnection = vi.fn().mockResolvedValue(connected);

    await expect(call('test-connection', { testConnection })).resolves.toEqual({
      connected,
      message,
    });
  });
});

describe('clear-auth', () => {
  it('clears the stored tokens', async () => {
    const context = toolContext({});

    const payload = await callTool(utilityTools, 'clear-auth', {}, context);

    expect(context.clearAuthentication).toHaveBeenCalledOnce();
    expect(payload).toEqual({
      message:
        'Authentication tokens cleared. You will need to re-authenticate on the next API call.',
    });
  });
});

describe('debug-api-response', () => {
  it('returns the raw workspaces answer', async () => {
    const debugWorkspacesAPI = vi.fn().mockResolvedValue({ status: 200 });

    await expect(call('debug-api-response', { debugWorkspacesAPI })).resolves.toEqual({
      debug: { status: 200 },
      message: 'Raw API response data for troubleshooting',
    });
  });
});

describe('check-user-scopes', () => {
  const user = { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', x: 1 };

  it('names the user and finds nothing missing with every scope', async () => {
    const getUserScopes = vi.fn().mockResolvedValue(ALL_SCOPES);
    const getCurrentUser = vi.fn().mockResolvedValue(user);

    await expect(call('check-user-scopes', { getUserScopes, getCurrentUser })).resolves.toEqual({
      user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
      scopes: ALL_SCOPES,
      missing: [],
    });
  });

  it('skips the user lookup without identity:read and lists what is missing', async () => {
    const getUserScopes = vi.fn().mockResolvedValue(['murals:read']);
    const getCurrentUser = vi.fn();

    const payload = await call('check-user-scopes', { getUserScopes, getCurrentUser });

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(payload).toEqual({
      user: null,
      scopes: ['murals:read'],
      missing: ALL_SCOPES.filter((scope) => scope !== 'murals:read'),
    });
  });

  it('reports no user when the lookup fails', async () => {
    const getUserScopes = vi.fn().mockResolvedValue(ALL_SCOPES);
    const getCurrentUser = vi.fn().mockRejectedValue(new Error('403'));

    const payload = await call('check-user-scopes', { getUserScopes, getCurrentUser });

    expect(payload.user).toBeNull();
  });
});

it('rejects any argument to an argument-less tool', async () => {
  await expect(
    callTool(utilityTools, 'test-connection', { verbose: true }, toolContext({})),
  ).rejects.toThrow();
});
