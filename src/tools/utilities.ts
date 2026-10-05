import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { defineTool, READ_ONLY, type ToolDefinition } from './definitions.js';

const EXPECTED_SCOPES = [
  'workspaces:read',
  'rooms:read',
  'rooms:write',
  'murals:read',
  'murals:write',
  'templates:read',
  'templates:write',
  'identity:read',
];

export const utilityTools: ToolDefinition[] = [
  defineTool({
    name: 'test-connection',
    title: 'Test Connection',
    description: 'Test the connection to Mural API and verify authentication',
    inputSchema: z.strictObject({}),
    annotations: READ_ONLY,
    handler: async (_params, { client }) => {
      const isConnected = await client.testConnection();
      return jsonResult({
        connected: isConnected,
        message: isConnected
          ? 'Successfully connected to Mural API'
          : 'Failed to connect to Mural API',
      });
    },
  }),
  defineTool({
    name: 'clear-auth',
    title: 'Clear Authentication',
    description:
      'Sign this MCP connection out: revoke the access and refresh tokens it holds and the Mural tokens behind them (requires re-authentication)',
    inputSchema: z.strictObject({}),
    // Ends the caller's grant, which only signing in again brings back; it
    // touches this server's own records, not Mural.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_params, { clearAuthentication }) => {
      await clearAuthentication();
      return jsonResult({
        message: 'Authorization revoked. Your MCP client must sign in again before the next call.',
      });
    },
  }),
  defineTool({
    name: 'debug-api-response',
    title: 'Debug API Response',
    description: 'Debug tool: Show raw API response from workspaces endpoint for troubleshooting',
    inputSchema: z.strictObject({}),
    annotations: READ_ONLY,
    handler: async (_params, { client }) => {
      const debugInfo = await client.debugWorkspacesAPI();
      return jsonResult({
        debug: debugInfo,
        message: 'Raw API response data for troubleshooting',
      });
    },
  }),
  defineTool({
    name: 'check-user-scopes',
    title: 'Check User Scopes',
    description: "Check the current user's OAuth scopes and permissions",
    inputSchema: z.strictObject({}),
    annotations: READ_ONLY,
    handler: async (_params, { client }) => {
      const scopes = await client.getUserScopes();

      // Only try to get user info if we have identity:read scope
      const user = scopes.includes('identity:read')
        ? // Stryker disable next-line ArrowFunction: undefined and null both end up as user: null below.
          await client.getCurrentUser().catch(() => null)
        : null;

      return jsonResult({
        user: user
          ? {
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              email: user.email,
            }
          : null,
        scopes,
        missing: EXPECTED_SCOPES.filter((scope) => !scopes.includes(scope)),
      });
    },
  }),
];
