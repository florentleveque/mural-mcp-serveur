import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { projectTemplates, toCompactBoard } from '../projections.js';
import { CREATES, defineTool, READ_ONLY, type ToolDefinition } from './definitions.js';
import { verboseList, workspaceId } from './fields.js';

export const templateTools: ToolDefinition[] = [
  defineTool({
    name: 'list-workspace-templates',
    title: 'List Workspace Templates',
    description:
      "List a workspace's templates (default + custom), or search them by name. Returns all pages. Compact view keeps: id, name, description, type. Pass verbose=true for the full raw objects (thumbUrl, viewLink, createdBy, updatedOn, ...).",
    inputSchema: z.strictObject({
      workspaceId,
      searchQuery: z
        .string()
        .optional()
        .describe('Optional. If provided, search templates by name instead of listing all'),
      withoutDefault: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, exclude Mural default templates and return only custom ones (optional, ignored when searchQuery is set)',
        ),
      verbose: verboseList,
    }),
    annotations: READ_ONLY,
    handler: async ({ workspaceId, searchQuery, withoutDefault, verbose }, { client }) => {
      const templates = await client.getWorkspaceTemplates(
        workspaceId,
        searchQuery,
        withoutDefault,
      );
      return jsonResult({
        templates: verbose ? templates : projectTemplates(templates),
        count: templates.length,
        workspaceId,
        searchQuery: searchQuery ?? null,
      });
    },
  }),
  defineTool({
    name: 'create-mural-from-template',
    title: 'Create Mural from Template',
    description: 'Create a new mural in a room from a template',
    inputSchema: z.strictObject({
      templateId: z
        .string()
        .min(1)
        .describe('The unique identifier of the template to instantiate'),
      title: z.string().min(1).describe('Title of the new mural'),
      roomId: z.number().describe('The numeric identifier of the destination room'),
      folderId: z.string().optional().describe('Optional destination folder id within the room'),
    }),
    annotations: CREATES,
    handler: async ({ templateId, title, roomId, folderId }, { client }) => {
      const mural = await client.createMuralFromTemplate(templateId, title, roomId, folderId);
      return jsonResult({
        mural: toCompactBoard(mural),
        message: `Created mural "${title}" from template ${templateId} in room ${roomId}`,
      });
    },
  }),
];
