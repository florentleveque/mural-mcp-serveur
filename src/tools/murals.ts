import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { projectBoards, toCompactBoard } from '../projections.js';
import { CREATES, defineTool, OVERWRITES, READ_ONLY, type ToolDefinition } from './definitions.js';
import { verboseItem, verboseList, workspaceId } from './fields.js';

const destinationRoomId = z.number().describe('The numeric identifier of the destination room');
const infinite = z.boolean().optional().describe('Optional. Whether the canvas is infinite');
const permission = z.enum(['read', 'write', 'none']).optional();

export const muralTools: ToolDefinition[] = [
  defineTool({
    name: 'list-workspace-boards',
    title: 'List Workspace Murals',
    description:
      'List all boards (murals) within a specific workspace. Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw objects (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
    inputSchema: z.strictObject({ workspaceId, verbose: verboseList }),
    annotations: READ_ONLY,
    handler: async ({ workspaceId, verbose }, { client }) => {
      const boards = await client.getWorkspaceMurals(workspaceId);
      return jsonResult({
        boards: verbose ? boards : projectBoards(boards),
        count: boards.length,
        workspaceId,
      });
    },
  }),
  defineTool({
    name: 'list-room-boards',
    title: 'List Room Murals',
    description:
      'List all boards (murals) within a specific room. Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw objects (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
    inputSchema: z.strictObject({
      roomId: z.string().min(1).describe('The unique identifier of the room'),
      verbose: verboseList,
    }),
    annotations: READ_ONLY,
    handler: async ({ roomId, verbose }, { client }) => {
      const boards = await client.getRoomMurals(roomId);
      return jsonResult({
        boards: verbose ? boards : projectBoards(boards),
        count: boards.length,
        roomId,
      });
    },
  }),
  defineTool({
    name: 'get-board',
    title: 'Get Mural',
    description:
      'Get detailed information about a specific board (mural). Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw object (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
    inputSchema: z.strictObject({
      boardId: z.string().min(1).describe('The unique identifier of the board/mural'),
      verbose: verboseItem,
    }),
    annotations: READ_ONLY,
    handler: async ({ boardId, verbose }, { client }) => {
      const board = await client.getMural(boardId);
      return jsonResult({ board: verbose ? board : toCompactBoard(board) });
    },
  }),
  defineTool({
    name: 'create-mural',
    title: 'Create Mural',
    description: 'Create a new blank mural in a room (requires murals:write)',
    inputSchema: z.strictObject({
      roomId: destinationRoomId,
      title: z.string().optional().describe('Optional title of the new mural'),
      backgroundColor: z
        .string()
        .optional()
        .describe('Optional background color (hex, e.g. #FFFFFFFF)'),
      width: z.number().optional().describe('Optional canvas width in pixels'),
      height: z.number().optional().describe('Optional canvas height in pixels'),
      infinite,
      folderId: z.string().optional().describe('Optional destination folder id within the room'),
    }),
    annotations: CREATES,
    handler: async ({ roomId, ...options }, { client }) => {
      const mural = await client.createMural(roomId, options);
      return jsonResult({
        mural: toCompactBoard(mural),
        message: `Created mural in room ${roomId}`,
      });
    },
  }),
  defineTool({
    name: 'update-mural',
    title: 'Update Mural',
    description:
      "Update a mural's properties by id (title, status, dimensions, sharing permissions...). Provide at least one field (requires murals:write)",
    inputSchema: z.strictObject({
      muralId: z.string().min(1).describe('The unique identifier of the mural to update'),
      title: z.string().optional(),
      backgroundColor: z.string().optional().describe('Hex background color'),
      favorite: z.boolean().optional(),
      status: z
        .enum(['active', 'archived'])
        .optional()
        .describe('Set to "archived" to archive the mural (non-destructive alternative to delete)'),
      width: z.number().optional().describe('Canvas width (3000-60000)'),
      height: z.number().optional().describe('Canvas height (3000-60000)'),
      infinite: z.boolean().optional(),
      visitorsPermission: permission,
      workspaceMembersPermission: permission,
      folderId: z.string().optional(),
    }),
    annotations: OVERWRITES,
    handler: async ({ muralId, ...updates }, { client }) => {
      if (Object.keys(updates).length === 0) {
        throw new Error('update-mural requires at least one field to update');
      }
      const mural = await client.updateMural(muralId, updates);
      return jsonResult({ mural: toCompactBoard(mural), message: `Updated mural ${muralId}` });
    },
  }),
  defineTool({
    name: 'delete-mural',
    title: 'Delete Mural',
    description:
      'Permanently delete a mural by its id (irreversible; requires murals:write). For a non-destructive alternative, use update-mural with status "archived"',
    inputSchema: z.strictObject({
      muralId: z.string().min(1).describe('The unique identifier of the mural to delete'),
    }),
    annotations: OVERWRITES,
    handler: async ({ muralId }, { client }) => {
      await client.deleteMural(muralId);
      return jsonResult({ message: `Deleted mural ${muralId}` });
    },
  }),
  defineTool({
    name: 'duplicate-mural',
    title: 'Duplicate Mural',
    description: 'Duplicate an existing mural into a room (requires murals:write)',
    inputSchema: z.strictObject({
      muralId: z.string().min(1).describe('The unique identifier of the mural to duplicate'),
      roomId: destinationRoomId,
      title: z.string().min(1).describe('Title of the duplicated mural'),
      folderId: z.string().optional().describe('Optional destination folder id'),
      infinite,
    }),
    annotations: CREATES,
    handler: async ({ muralId, roomId, title, ...options }, { client }) => {
      const mural = await client.duplicateMural(muralId, roomId, title, options);
      return jsonResult({
        mural: toCompactBoard(mural),
        message: `Duplicated mural ${muralId} into room ${roomId}`,
      });
    },
  }),
  defineTool({
    name: 'export-mural',
    title: 'Export Mural',
    description:
      'Start an ASYNCHRONOUS mural export (requires murals:read). Returns an exportId; it does NOT return the file. To get the file, call download-export with this exportId (retry until ready:true). Accepted downloadFormat values are defined by the Mural API',
    inputSchema: z.strictObject({
      muralId: z.string().min(1).describe('The unique identifier of the mural to export'),
      downloadFormat: z
        .string()
        .min(1)
        .describe('The export format (e.g. pdf, png, zip; values defined by the Mural API)'),
    }),
    annotations: CREATES,
    handler: async ({ muralId, downloadFormat }, { client }) => {
      const result = await client.exportMural(muralId, downloadFormat);
      return jsonResult({
        export: result,
        message: `Started export of mural ${muralId} as ${downloadFormat}. Call download-export with the returned exportId, retrying while it returns ready:false until ready:true`,
      });
    },
  }),
  defineTool({
    name: 'download-export',
    title: 'Download Mural Export',
    description:
      'Get the download URL of a mural export (requires murals:read). Single-shot: if the export is not ready yet it returns ready:false and no url. Normal usage: call this with the exportId returned by export-mural and, while it returns ready:false, wait a few seconds and call it again until ready:true. The url is a signed link that needs no authentication; status.expireOn is when Mural expires the export, so fetch the file soon',
    inputSchema: z.strictObject({
      muralId: z.string().min(1).describe('The unique identifier of the mural being exported'),
      exportId: z.string().min(1).describe('The export job identifier returned by export-mural'),
    }),
    annotations: READ_ONLY,
    handler: async ({ muralId, exportId }, { client }) => {
      const result = await client.getExportUrl(muralId, exportId);
      return jsonResult({
        ...result,
        muralId,
        exportId,
        message: result.ready
          ? `Export ${exportId} is ready: fetch url, a signed link that needs no authentication; status.expireOn is when Mural expires the export`
          : `Export ${exportId} is not ready yet: call download-export again in a few seconds`,
      });
    },
  }),
];
