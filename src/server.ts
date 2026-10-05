import { McpServer } from '@modelcontextprotocol/server';

import { jsonError } from './mcp-format.js';
import type { ToolContext } from './tools/definitions.js';
import { toolDefinitions } from './tools/registry.js';

/**
 * An MCP server exposing every tool definition over `context`. The SDK
 * validates arguments against each definition's schema before the handler
 * runs; a handler failure still comes back as the `jsonError` payload, so a
 * MuralApiError keeps its status and errorCode.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'mural-mcp-serveur', version: '1.0.0' });

  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return await tool.handler(args, context);
        } catch (error) {
          return jsonError(error, tool.name);
        }
      },
    );
  }

  return server;
}
