/**
 * Shared helpers for unit tests.
 * All HTTP traffic is mocked through the global fetch stub, and all
 * filesystem access is mocked through vi.mock('fs/promises').
 */

/**
 * Build a fetch Response. Pass `null` as body for empty-body responses
 * (e.g. 204 No Content).
 */
export function mockFetchResponse(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** OAuth tokens fixture, as persisted in ~/.mural-mcp-tokens.json. */
export function mockOAuthTokens(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
    scope: 'workspaces:read murals:read murals:write rooms:read rooms:write templates:read templates:write identity:read',
    ...overrides,
  };
}
