/**
 * In-process MCP session against the server src/server.ts builds, over a
 * LoopbackTransport. Messages are raw JSON-RPC, so what a test sees is exactly
 * what the server sends, whatever the SDK version.
 */

import { createMcpServer } from '../../src/server.js';
import type { ToolContext } from '../../src/tools/definitions.js';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class LoopbackTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private nextId = 1;
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined) this.pending.get(message.id)?.(message);
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.onmessage?.({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string): void {
    this.onmessage?.({ jsonrpc: '2.0', method });
  }
}

/** Run the MCP handshake over a transport a server is connected to; returns the initialize result. */
export async function initialize(transport: LoopbackTransport): Promise<JsonRpcMessage['result']> {
  const init = await transport.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '0.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  transport.notify('notifications/initialized');
  return init.result;
}

/** Connect a server over `context` to `transport` and run the MCP handshake. */
export async function openSession(
  transport: LoopbackTransport,
  context: ToolContext,
): Promise<void> {
  await createMcpServer(context).connect(transport as never);
  await initialize(transport);
}
