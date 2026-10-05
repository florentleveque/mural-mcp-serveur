/**
 * Shared helpers for unit tests.
 * All HTTP traffic is mocked through the global fetch stub, and all
 * filesystem access is mocked through vi.mock('fs/promises').
 */

import { vi } from 'vitest';

import type { MuralClient } from '../../src/mural-client.js';
import type { ToolContext, ToolDefinition } from '../../src/tools/definitions.js';

/**
 * Build a fetch Response. Pass `null` as body for empty-body responses
 * (e.g. 204 No Content).
 */
export function mockFetchResponse(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A ToolContext over a stub client that only has the methods a test gives it. */
export function toolContext(client: Record<string, unknown>): ToolContext {
  return { client: client as unknown as MuralClient, clearAuthentication: vi.fn() };
}

/** Validate `args` the way the server does, run the handler and parse its JSON payload. */
export async function callTool(
  tools: ToolDefinition[],
  name: string,
  args: unknown,
  context: ToolContext,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  const response = await tool.handler(tool.inputSchema.parse(args), context);
  return JSON.parse(response.content[0]?.text ?? 'null');
}
