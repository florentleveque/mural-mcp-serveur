import { describe, expect, it, vi } from 'vitest';

import { templateTools } from '../../../src/tools/templates.js';
import { callTool, toolContext } from '../helpers.js';

const template = {
  id: 't1',
  name: 'Retro',
  description: 'Sprint retro',
  type: 'custom',
  thumbUrl: 'x',
};
const compactTemplate = { id: 't1', name: 'Retro', description: 'Sprint retro', type: 'custom' };

describe('list-workspace-templates', () => {
  it('lists every template in the compact view by default', async () => {
    const getWorkspaceTemplates = vi.fn().mockResolvedValue([template]);

    const payload = await callTool(
      templateTools,
      'list-workspace-templates',
      { workspaceId: 'w1' },
      toolContext({ getWorkspaceTemplates }),
    );

    expect(getWorkspaceTemplates).toHaveBeenCalledWith('w1', undefined, false);
    expect(payload).toEqual({
      templates: [compactTemplate],
      count: 1,
      workspaceId: 'w1',
      searchQuery: null,
    });
  });

  it('passes the search and filter and returns raw objects when verbose', async () => {
    const getWorkspaceTemplates = vi.fn().mockResolvedValue([template]);

    const payload = await callTool(
      templateTools,
      'list-workspace-templates',
      { workspaceId: 'w1', searchQuery: 'retro', withoutDefault: true, verbose: true },
      toolContext({ getWorkspaceTemplates }),
    );

    expect(getWorkspaceTemplates).toHaveBeenCalledWith('w1', 'retro', true);
    expect(payload).toEqual({
      templates: [template],
      count: 1,
      workspaceId: 'w1',
      searchQuery: 'retro',
    });
  });

  it.each([{}, { workspaceId: '' }, { workspaceId: 'w1', query: 'x' }])(
    'rejects %o',
    async (args) => {
      await expect(
        callTool(templateTools, 'list-workspace-templates', args, toolContext({})),
      ).rejects.toThrow();
    },
  );
});

describe('create-mural-from-template', () => {
  const mural = { id: 'm1', title: 'Retro', roomId: 7, thumbnailUrl: 'x' };

  it('creates the mural and reports it', async () => {
    const createMuralFromTemplate = vi.fn().mockResolvedValue(mural);

    const payload = await callTool(
      templateTools,
      'create-mural-from-template',
      { templateId: 't1', title: 'Retro', roomId: 7, folderId: 'f1' },
      toolContext({ createMuralFromTemplate }),
    );

    expect(createMuralFromTemplate).toHaveBeenCalledWith('t1', 'Retro', 7, 'f1');
    expect(payload).toEqual({
      mural: { id: 'm1', title: 'Retro', roomId: 7 },
      message: 'Created mural "Retro" from template t1 in room 7',
    });
  });

  it.each([
    { templateId: 't1', title: 'Retro', roomId: '7' },
    { templateId: '', title: 'Retro', roomId: 7 },
    { templateId: 't1', title: '', roomId: 7 },
  ])('rejects %o', async (args) => {
    await expect(
      callTool(templateTools, 'create-mural-from-template', args, toolContext({})),
    ).rejects.toThrow();
  });
});
