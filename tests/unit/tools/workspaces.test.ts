import { describe, expect, it, vi } from 'vitest';

import { workspaceTools } from '../../../src/tools/workspaces.js';
import { callTool, toolContext } from '../helpers.js';

const workspace = { id: 'w1', name: 'Alpha', description: 'Team space', locked: false };

describe('list-workspaces', () => {
  it('returns the compact view of every workspace by default', async () => {
    const getWorkspaces = vi.fn().mockResolvedValue([workspace]);

    const payload = await callTool(
      workspaceTools,
      'list-workspaces',
      {},
      toolContext({ getWorkspaces }),
    );

    expect(getWorkspaces).toHaveBeenCalledWith(undefined, undefined);
    expect(payload).toEqual({ workspaces: [{ id: 'w1', name: 'Alpha' }], count: 1 });
  });

  it('passes the page bounds and returns raw objects when verbose', async () => {
    const getWorkspaces = vi.fn().mockResolvedValue([workspace]);

    const payload = await callTool(
      workspaceTools,
      'list-workspaces',
      { limit: 10, offset: 20, verbose: true },
      toolContext({ getWorkspaces }),
    );

    expect(getWorkspaces).toHaveBeenCalledWith(10, 20);
    expect(payload).toEqual({ workspaces: [workspace], count: 1 });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { offset: -1 }, { unknown: true }])(
    'rejects %o',
    async (args) => {
      await expect(
        callTool(workspaceTools, 'list-workspaces', args, toolContext({})),
      ).rejects.toThrow();
    },
  );
});

describe('get-workspace', () => {
  it('returns the compact view by default', async () => {
    const getWorkspace = vi.fn().mockResolvedValue(workspace);

    const payload = await callTool(
      workspaceTools,
      'get-workspace',
      { workspaceId: 'w1' },
      toolContext({ getWorkspace }),
    );

    expect(getWorkspace).toHaveBeenCalledWith('w1');
    expect(payload).toEqual({ workspace: { id: 'w1', name: 'Alpha' } });
  });

  it('returns the raw object when verbose', async () => {
    const getWorkspace = vi.fn().mockResolvedValue(workspace);

    const payload = await callTool(
      workspaceTools,
      'get-workspace',
      { workspaceId: 'w1', verbose: true },
      toolContext({ getWorkspace }),
    );

    expect(payload).toEqual({ workspace });
  });

  it.each([{}, { workspaceId: '' }])('rejects %o', async (args) => {
    await expect(
      callTool(workspaceTools, 'get-workspace', args, toolContext({})),
    ).rejects.toThrow();
  });
});
