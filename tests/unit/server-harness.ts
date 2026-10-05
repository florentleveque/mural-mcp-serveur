/**
 * In-process MCP session against src/index.ts.
 * The test file mocks the stdio transport module so that src/index.ts connects
 * to a LoopbackTransport instead of process stdio. Messages are raw JSON-RPC, so
 * what a test sees is exactly what the server sends, whatever the SDK version.
 */

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

/** Load src/index.ts (its main() connects to `transport`) and run the MCP handshake. */
export async function openSession(transport: LoopbackTransport): Promise<void> {
  await import('../../src/index.js');
  while (!transport.onmessage) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await initialize(transport);
}
