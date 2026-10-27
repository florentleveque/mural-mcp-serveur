import { beforeAll, describe, expect, it, vi } from 'vitest';

import { MuralApiError } from '../../src/mural-client.js';
import { createMcpServer } from '../../src/server.js';
import { toolContext } from './helpers.js';
import { initialize, LoopbackTransport } from './server-harness.js';

describe('createMcpServer', () => {
  const transport = new LoopbackTransport();
  const getWorkspace = vi.fn();
  let serverInfo: unknown;

  beforeAll(async () => {
    await createMcpServer(toolContext({ getWorkspace })).connect(transport);
    serverInfo = (await initialize(transport))?.serverInfo;
  });

  function callTool(name: string, args: Record<string, unknown>) {
    return transport.request('tools/call', { name, arguments: args });
  }

  it('introduces itself as the Mural MCP server', () => {
    expect(serverInfo).toEqual({ name: 'mural-mcp-serveur', version: '1.0.0' });
  });

  it('runs the handler with the validated arguments', async () => {
    getWorkspace.mockResolvedValue({ id: 'w1', name: 'Alpha', locked: false });

    const response = await callTool('get-workspace', { workspaceId: 'w1' });

    expect(getWorkspace).toHaveBeenCalledWith('w1');
    expect(response.result).toEqual({
      content: [{ type: 'text', text: '{"workspace":{"id":"w1","name":"Alpha"}}' }],
    });
  });

  it('reports a handler failure with the Mural error details', async () => {
    getWorkspace.mockRejectedValue(new MuralApiError(404, 'Not Found', 'MURAL_NOT_FOUND'));

    const response = await callTool('get-workspace', { workspaceId: 'w1' });

    expect(response.result?.isError).toBe(true);
    const content = response.result?.content as { text: string }[];
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual({
      error: true,
      message: 'Mural API request failed: HTTP 404: Not Found',
      tool: 'get-workspace',
      status: 404,
      errorCode: 'MURAL_NOT_FOUND',
    });
  });

  it('refuses arguments outside the schema before reaching the handler', async () => {
    getWorkspace.mockClear();

    const response = await callTool('get-workspace', { workspaceId: 'w1', extra: true });

    expect(response.result?.isError).toBe(true);
    const content = response.result?.content as { text: string }[];
    expect(content[0]?.text).toMatch(
      /^Input validation error: Invalid arguments for tool get-workspace/,
    );
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it('answers an unknown tool with a protocol error', async () => {
    const response = await callTool('no-such-tool', {});

    expect(response.error?.message).toMatch(/no-such-tool/);
  });
});
