/**
 * MCP response formatting.
 *
 * Centralizes how tool handlers serialize their payloads so the format stays
 * consistent and compact. Notably: no pretty-printing (`JSON.stringify(x, null, 2)`
 * inflated every response with indentation tokens for no benefit to the model).
 */

import { MuralApiError } from './mural-client.js';

export type ToolResponse = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Wrap a payload as a compact (non-pretty-printed) MCP text result. */
export function jsonResult(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Format a thrown error as an MCP error result. Mirrors the previous inline
 * error envelope: { error, message, tool } plus the typed MuralApiError details
 * (status, errorCode) when available, so callers can branch on them.
 */
export function jsonError(error: unknown, tool: string): ToolResponse {
  const payload: Record<string, unknown> = {
    error: true,
    message: error instanceof Error ? error.message : 'Unknown error occurred',
    tool,
  };

  if (error instanceof MuralApiError) {
    payload.status = error.status;
    if (error.errorCode) {
      payload.errorCode = error.errorCode;
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}
