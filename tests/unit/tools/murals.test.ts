import { describe, expect, it, vi } from 'vitest';

import { muralTools } from '../../../src/tools/murals.js';
import { callTool, toolContext } from '../helpers.js';

const board = { id: 'm1', title: 'Roadmap', roomId: 7, thumbnailUrl: 'x' };
const compactBoard = { id: 'm1', title: 'Roadmap', roomId: 7 };

function call(name: string, args: unknown, client: Record<string, unknown> = {}) {
  return callTool(muralTools, name, args, toolContext(client));
}

describe('list-workspace-boards', () => {
  it('lists the compact view by default', async () => {
    const getWorkspaceMurals = vi.fn().mockResolvedValue([board]);

    const payload = await call(
      'list-workspace-boards',
      { workspaceId: 'w1' },
      { getWorkspaceMurals },
    );

    expect(getWorkspaceMurals).toHaveBeenCalledWith('w1');
    expect(payload).toEqual({ boards: [compactBoard], count: 1, workspaceId: 'w1' });
  });

  it('returns raw objects when verbose', async () => {
    const getWorkspaceMurals = vi.fn().mockResolvedValue([board]);

    const payload = await call(
      'list-workspace-boards',
      { workspaceId: 'w1', verbose: true },
      { getWorkspaceMurals },
    );

    expect(payload).toEqual({ boards: [board], count: 1, workspaceId: 'w1' });
  });
});

describe('list-room-boards', () => {
  it('lists the compact view by default', async () => {
    const getRoomMurals = vi.fn().mockResolvedValue([board]);

    const payload = await call('list-room-boards', { roomId: '7' }, { getRoomMurals });

    expect(getRoomMurals).toHaveBeenCalledWith('7');
    expect(payload).toEqual({ boards: [compactBoard], count: 1, roomId: '7' });
  });

  it('returns raw objects when verbose', async () => {
    const getRoomMurals = vi.fn().mockResolvedValue([board]);

    const payload = await call(
      'list-room-boards',
      { roomId: '7', verbose: true },
      { getRoomMurals },
    );

    expect(payload).toEqual({ boards: [board], count: 1, roomId: '7' });
  });

  it('rejects a numeric room id', async () => {
    await expect(call('list-room-boards', { roomId: 7 })).rejects.toThrow();
  });
});

describe('get-board', () => {
  it('returns the compact view by default and the raw object when verbose', async () => {
    const getMural = vi.fn().mockResolvedValue(board);

    await expect(call('get-board', { boardId: 'm1' }, { getMural })).resolves.toEqual({
      board: compactBoard,
    });
    await expect(
      call('get-board', { boardId: 'm1', verbose: true }, { getMural }),
    ).resolves.toEqual({ board });
    expect(getMural).toHaveBeenCalledWith('m1');
  });
});

describe('create-mural', () => {
  it('passes every option but the room to the client', async () => {
    const createMural = vi.fn().mockResolvedValue(board);
    const options = {
      title: 'Roadmap',
      backgroundColor: '#FFFFFFFF',
      width: 4000,
      height: 3000,
      infinite: false,
      folderId: 'f1',
    };

    const payload = await call('create-mural', { roomId: 7, ...options }, { createMural });

    expect(createMural).toHaveBeenCalledWith(7, options);
    expect(payload).toEqual({ mural: compactBoard, message: 'Created mural in room 7' });
  });

  it('rejects a missing room', async () => {
    await expect(call('create-mural', { title: 'Roadmap' })).rejects.toThrow();
  });
});

describe('update-mural', () => {
  it('sends only the given fields', async () => {
    const updateMural = vi.fn().mockResolvedValue(board);

    const payload = await call(
      'update-mural',
      { muralId: 'm1', status: 'archived', visitorsPermission: 'read' },
      { updateMural },
    );

    expect(updateMural).toHaveBeenCalledWith('m1', {
      status: 'archived',
      visitorsPermission: 'read',
    });
    expect(payload).toEqual({ mural: compactBoard, message: 'Updated mural m1' });
  });

  it('refuses an update with no field', async () => {
    const updateMural = vi.fn();

    await expect(call('update-mural', { muralId: 'm1' }, { updateMural })).rejects.toThrow(
      'update-mural requires at least one field to update',
    );
    expect(updateMural).not.toHaveBeenCalled();
  });

  it.each([
    { muralId: 'm1', status: 'deleted' },
    { muralId: 'm1', workspaceMembersPermission: 'admin' },
  ])('rejects %o', async (args) => {
    await expect(call('update-mural', args)).rejects.toThrow();
  });
});

describe('delete-mural', () => {
  it('deletes the mural', async () => {
    const deleteMural = vi.fn().mockResolvedValue(undefined);

    await expect(call('delete-mural', { muralId: 'm1' }, { deleteMural })).resolves.toEqual({
      message: 'Deleted mural m1',
    });
    expect(deleteMural).toHaveBeenCalledWith('m1');
  });
});

describe('duplicate-mural', () => {
  it('duplicates into the room with the options', async () => {
    const duplicateMural = vi.fn().mockResolvedValue(board);

    const payload = await call(
      'duplicate-mural',
      { muralId: 'm0', roomId: 7, title: 'Copy', folderId: 'f1', infinite: true },
      { duplicateMural },
    );

    expect(duplicateMural).toHaveBeenCalledWith('m0', 7, 'Copy', {
      folderId: 'f1',
      infinite: true,
    });
    expect(payload).toEqual({ mural: compactBoard, message: 'Duplicated mural m0 into room 7' });
  });

  it('rejects an empty title', async () => {
    await expect(
      call('duplicate-mural', { muralId: 'm0', roomId: 7, title: '' }),
    ).rejects.toThrow();
  });
});

describe('export-mural', () => {
  it('starts the export and says how to collect it', async () => {
    const exportMural = vi.fn().mockResolvedValue({ exportId: 'e1' });

    const payload = await call(
      'export-mural',
      { muralId: 'm1', downloadFormat: 'pdf' },
      { exportMural },
    );

    expect(exportMural).toHaveBeenCalledWith('m1', 'pdf');
    expect(payload).toEqual({
      export: { exportId: 'e1' },
      message:
        'Started export of mural m1 as pdf. Call download-export with the returned exportId, retrying while it returns ready:false until ready:true',
    });
  });

  it('rejects an empty format', async () => {
    await expect(call('export-mural', { muralId: 'm1', downloadFormat: '' })).rejects.toThrow();
  });
});
