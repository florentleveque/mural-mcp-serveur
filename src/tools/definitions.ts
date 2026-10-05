// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import type { z } from 'zod';

import type { ToolResponse } from '../mcp-format.js';
import type { MuralClient } from '../mural-client.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a handler may reach. Passed per call rather than captured when the
 * definitions are built, so the same definitions can serve a client per
 * authenticated user once the server runs over HTTP.
 */
export interface ToolContext {
  client: MuralClient;
  clearAuthentication: () => Promise<void>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse>;
}

/**
 * Types `handler` against its own `inputSchema`. The cast is sound because the
 * server validates the arguments with that schema before calling the handler.
 */
export function defineTool<Schema extends z.ZodObject>(
  tool: Omit<ToolDefinition, 'inputSchema' | 'handler'> & {
    inputSchema: Schema;
    handler: (params: z.output<Schema>, context: ToolContext) => Promise<ToolResponse>;
  },
): ToolDefinition {
  return {
    ...tool,
    handler: (params, context) => tool.handler(params as z.output<Schema>, context),
  };
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Adds something new; calling twice adds it twice. */
export const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Overwrites or removes existing content; repeating the call changes nothing more. */
export const OVERWRITES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
