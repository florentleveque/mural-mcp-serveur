import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoopbackTransport, openSession } from './server-harness.js';

const harness = vi.hoisted(() => ({ transport: undefined as unknown, getExportUrl: vi.fn() }));

vi.mock('dotenv/config', () => ({}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: hands src/index.ts the loopback transport.
      return harness.transport;
    }
  },
}));
vi.mock('../../src/mural-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mural-client.js')>()),
  MuralClient: class {
    getExportUrl = harness.getExportUrl;
  },
}));

describe('download-export tool', () => {
  const transport = new LoopbackTransport();

  async function callTool(args: Record<string, unknown>) {
    const response = await transport.request('tools/call', {
      name: 'download-export',
      arguments: args,
    });
    const content = response.result?.content as { text: string }[];
    return JSON.parse(content[0]?.text ?? 'null');
  }

  beforeAll(async () => {
    harness.transport = transport;
    vi.stubEnv('MURAL_CLIENT_ID', 'client-id');
    vi.stubEnv('MURAL_CLIENT_SECRET', 'client-secret');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openSession(transport);
  });

  beforeEach(() => {
    harness.getExportUrl.mockReset();
  });

  it('returns the signed URL of a finished export', async () => {
    const status = {
      url: 'https://s3.example/export.pdf?signature=abc',
      expireOn: 1_780_000_000_000,
    };
    harness.getExportUrl.mockResolvedValue({ ready: true, url: status.url, status });

    await expect(callTool({ muralId: 'm1', exportId: 'e1' })).resolves.toEqual({
      ready: true,
      url: status.url,
      status,
      muralId: 'm1',
      exportId: 'e1',
      message:
        'Export e1 is ready: fetch url, a signed link that needs no authentication; status.expireOn is when Mural expires the export',
    });
    expect(harness.getExportUrl).toHaveBeenCalledWith('m1', 'e1');
  });

  it('asks to call again while the export is not ready', async () => {
    harness.getExportUrl.mockResolvedValue({ ready: false, status: {} });

    await expect(callTool({ muralId: 'm1', exportId: 'e1' })).resolves.toEqual({
      ready: false,
      status: {},
      muralId: 'm1',
      exportId: 'e1',
      message: 'Export e1 is not ready yet: call download-export again in a few seconds',
    });
  });
});
