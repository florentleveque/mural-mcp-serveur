#!/usr/bin/env node

import 'dotenv/config';

import { type ListToolsResult, Server, type Tool } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { jsonError, jsonResult } from './mcp-format.js';
import { MuralClient } from './mural-client.js';
import { MuralOAuth } from './oauth.js';
import type { ToolContext, ToolDefinition } from './tools/definitions.js';
import { toolDefinitions } from './tools/registry.js';

const REQUIRED_ENV_VARS = ['MURAL_CLIENT_ID', 'MURAL_CLIENT_SECRET'] as const;

const definitions = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

// Lists a definition the way McpServer.registerTool will, so the exposed
// surface does not move again when the legacy dispatcher goes.
function toListedTool(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: 'object',
      ...tool.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    },
    annotations: tool.annotations,
  };
}

// Shared Zod field for the `verbose` escape hatch exposed by every read tool.
const verboseFlag = z.boolean().optional().default(false);

function validateEnvironment(): { clientId: string; clientSecret: string; redirectUri?: string } {
  const clientId = process.env.MURAL_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_ID. ' +
        'Please set this in your environment or .env file.',
    );
  }

  const clientSecret = process.env.MURAL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_SECRET. ' +
        'Mural requires client authentication (the client secret) for the OAuth token exchange. ' +
        'Copy it from your Mural app (Basic Information page) and set it in your environment or .env file.',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.MURAL_REDIRECT_URI,
  };
}

async function main() {
  const { clientId, clientSecret, redirectUri } = validateEnvironment();

  const oauth = new MuralOAuth(clientId, clientSecret, redirectUri);
  const muralClient = new MuralClient(oauth);
  const context: ToolContext = {
    client: muralClient,
    clearAuthentication: () => oauth.clearTokens(),
  };

  const server = new Server(
    {
      name: 'mural-mcp-serveur',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(
    'tools/list',
    async (): Promise<ListToolsResult> => ({
      tools: [
        ...toolDefinitions.map(toListedTool),
        {
          name: 'test-connection',
          description: 'Test the connection to Mural API and verify authentication',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'clear-auth',
          description: 'Clear stored authentication tokens (requires re-authentication)',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'debug-api-response',
          description:
            'Debug tool: Show raw API response from workspaces endpoint for troubleshooting',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'check-user-scopes',
          description: "Check the current user's OAuth scopes and permissions",
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    }),
  );

  // Handle tool calls
  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const tool = definitions.get(name);
      if (tool) {
        return await tool.handler(tool.inputSchema.parse(args ?? {}), context);
      }

      switch (name) {
        case 'test-connection': {
          const isConnected = await muralClient.testConnection();

          return jsonResult({
            connected: isConnected,
            message: isConnected
              ? 'Successfully connected to Mural API'
              : 'Failed to connect to Mural API',
          });
        }

        case 'clear-auth': {
          await oauth.clearTokens();

          return jsonResult({
            message:
              'Authentication tokens cleared. You will need to re-authenticate on the next API call.',
          });
        }

        case 'debug-api-response': {
          const debugInfo = await muralClient.debugWorkspacesAPI();

          return jsonResult({
            debug: debugInfo,
            message: 'Raw API response data for troubleshooting',
          });
        }

        case 'check-user-scopes': {
          const scopes = await muralClient.getUserScopes();

          // Only try to get user info if we have identity:read scope
          let user = null;
          if (scopes.includes('identity:read')) {
            user = await muralClient.getCurrentUser().catch(() => null);
          }

          const expectedScopes = [
            'workspaces:read',
            'rooms:read',
            'rooms:write',
            'murals:read',
            'murals:write',
            'templates:read',
            'templates:write',
            'identity:read',
          ];
          const missing = expectedScopes.filter((scope) => !scopes.includes(scope));

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
            missing,
          });
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return jsonError(error, name);
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Mural MCP Server running on stdio');
  console.error(`Required environment variables: ${REQUIRED_ENV_VARS.join(', ')}`);
  console.error('Server ready to accept requests...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
