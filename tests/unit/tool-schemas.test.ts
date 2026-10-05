import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { schemaWeakenings } from './schema-compat.js';
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

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// The last hand-written surface, frozen when the schemas moved to zod: the
// floor every generated schema must keep. Never edit it to make a test pass.
const handwritten: ListedTool[] = JSON.parse(
  readFileSync(new URL('./fixtures/tools-list.handwritten.json', import.meta.url), 'utf8'),
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

  it('weakens nothing the hand-written schemas promised', async () => {
    const response = await transport.request('tools/list');
    const tools = response.result?.tools as ListedTool[];

    const weakenings = handwritten.flatMap((reference) => {
      const tool = tools.find(({ name }) => name === reference.name);
      if (!tool) return [`${reference.name}: tool dropped`];
      return [
        ...(tool.description ? [] : [`${reference.name}: description dropped`]),
        ...schemaWeakenings(reference.inputSchema, tool.inputSchema, reference.name),
      ];
    });

    expect(weakenings).toEqual([]);
  });
});
