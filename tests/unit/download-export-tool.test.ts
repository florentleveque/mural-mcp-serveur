import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolContext } from './helpers.js';
import { LoopbackTransport, openSession } from './server-harness.js';

const harness = { getExportUrl: vi.fn() };

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
    await openSession(transport, toolContext({ getExportUrl: harness.getExportUrl }));
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
