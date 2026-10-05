import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { LoopbackTransport, openSession } from './server-harness.js';

const harness = vi.hoisted(() => ({ transport: undefined as unknown }));

vi.mock('dotenv/config', () => ({}));
vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: hands src/index.ts the loopback transport.
      return harness.transport;
    }
  },
}));
vi.mock('../../src/mural-client.js', () => ({ MuralClient: class {} }));

// The tools/list answer is the contract agents depend on (AGENTS.md, "Tool
// schemas: never weakened"). Any change to it must show up as an edit of the
// reference file, reviewed like code.
const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/tools-list.json', import.meta.url), 'utf8'),
);

describe('exposed tool schemas', () => {
  const transport = new LoopbackTransport();

  beforeAll(async () => {
    harness.transport = transport;
    vi.stubEnv('MURAL_CLIENT_ID', 'client-id');
    vi.stubEnv('MURAL_CLIENT_SECRET', 'client-secret');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await openSession(transport);
  });

  it('tools/list matches the reference file', async () => {
    const response = await transport.request('tools/list');

    expect(response.result?.tools).toEqual(baseline);
  });
});
