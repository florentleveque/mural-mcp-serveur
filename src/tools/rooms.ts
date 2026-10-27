import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { projectRooms, toCompactRoom } from '../projections.js';
import { CREATES, defineTool, READ_ONLY, type ToolDefinition } from './definitions.js';
import { verboseList, workspaceId } from './fields.js';

export const roomTools: ToolDefinition[] = [
  defineTool({
    name: 'list-workspace-rooms',
    title: 'List Workspace Rooms',
    description:
      'List all rooms within a specific workspace (use a room id with list-room-boards). Returns all pages. Compact view keeps: id, name, type, workspaceId. Pass verbose=true for the full raw objects (confidential, isMember, description, favorite, createdBy, ...).',
    inputSchema: z.strictObject({
      workspaceId,
      openOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, list only open (discoverable) rooms instead of all rooms (optional, defaults to false)',
        ),
      verbose: verboseList,
    }),
    annotations: READ_ONLY,
    handler: async ({ workspaceId, openOnly, verbose }, { client }) => {
      const rooms = await client.getWorkspaceRooms(workspaceId, openOnly);
      return jsonResult({
        rooms: verbose ? rooms : projectRooms(rooms),
        count: rooms.length,
        workspaceId,
        openOnly,
      });
    },
  }),
  defineTool({
    name: 'create-room',
    title: 'Create Room',
    description: 'Create a new room in a workspace',
    inputSchema: z.strictObject({
      workspaceId,
      name: z.string().min(1).describe('Name of the new room'),
      type: z
        .enum(['open', 'private'])
        .describe('Room visibility: "open" (discoverable by workspace members) or "private"'),
      description: z.string().optional().describe('Optional description of the room'),
      confidential: z
        .boolean()
        .optional()
        .describe('Optional. Mark the room as confidential (defaults to false)'),
    }),
    annotations: CREATES,
    handler: async ({ workspaceId, name, type, description, confidential }, { client }) => {
      const room = await client.createRoom(workspaceId, name, type, description, confidential);
      return jsonResult({
        room: toCompactRoom(room),
        message: `Created ${type} room "${name}" in workspace ${workspaceId}`,
      });
    },
  }),
];
