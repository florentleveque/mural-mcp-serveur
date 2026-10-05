import { describe, expect, it, vi } from 'vitest';

import { roomTools } from '../../../src/tools/rooms.js';
import { callTool, toolContext } from '../helpers.js';

const room = { id: 7, name: 'Team', type: 'private', workspaceId: 'w1', confidential: true };
const compactRoom = { id: 7, name: 'Team', type: 'private', workspaceId: 'w1' };

describe('list-workspace-rooms', () => {
  it('lists every room in the compact view by default', async () => {
    const getWorkspaceRooms = vi.fn().mockResolvedValue([room]);

    const payload = await callTool(
      roomTools,
      'list-workspace-rooms',
      { workspaceId: 'w1' },
      toolContext({ getWorkspaceRooms }),
    );

    expect(getWorkspaceRooms).toHaveBeenCalledWith('w1', false);
    expect(payload).toEqual({ rooms: [compactRoom], count: 1, workspaceId: 'w1', openOnly: false });
  });

  it('lists open rooms only and returns raw objects when asked', async () => {
    const getWorkspaceRooms = vi.fn().mockResolvedValue([room]);

    const payload = await callTool(
      roomTools,
      'list-workspace-rooms',
      { workspaceId: 'w1', openOnly: true, verbose: true },
      toolContext({ getWorkspaceRooms }),
    );

    expect(getWorkspaceRooms).toHaveBeenCalledWith('w1', true);
    expect(payload).toEqual({ rooms: [room], count: 1, workspaceId: 'w1', openOnly: true });
  });

  it.each([{}, { workspaceId: '' }, { workspaceId: 'w1', extra: 1 }])(
    'rejects %o',
    async (args) => {
      await expect(
        callTool(roomTools, 'list-workspace-rooms', args, toolContext({})),
      ).rejects.toThrow();
    },
  );
});

describe('create-room', () => {
  it('creates the room and reports it', async () => {
    const createRoom = vi.fn().mockResolvedValue(room);

    const payload = await callTool(
      roomTools,
      'create-room',
      {
        workspaceId: 'w1',
        name: 'Team',
        type: 'private',
        description: 'Planning',
        confidential: true,
      },
      toolContext({ createRoom }),
    );

    expect(createRoom).toHaveBeenCalledWith('w1', 'Team', 'private', 'Planning', true);
    expect(payload).toEqual({
      room: compactRoom,
      message: 'Created private room "Team" in workspace w1',
    });
  });

  it('leaves the optional fields to Mural', async () => {
    const createRoom = vi.fn().mockResolvedValue(room);

    await callTool(
      roomTools,
      'create-room',
      { workspaceId: 'w1', name: 'Team', type: 'open' },
      toolContext({ createRoom }),
    );

    expect(createRoom).toHaveBeenCalledWith('w1', 'Team', 'open', undefined, undefined);
  });

  it.each([
    { workspaceId: 'w1', name: 'Team', type: 'public' },
    { workspaceId: 'w1', name: '', type: 'open' },
    { workspaceId: 'w1', type: 'open' },
  ])('rejects %o', async (args) => {
    await expect(callTool(roomTools, 'create-room', args, toolContext({}))).rejects.toThrow();
  });
});
