import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { projectWorkspaces, toCompactWorkspace } from '../projections.js';
import { defineTool, READ_ONLY, type ToolDefinition } from './definitions.js';
import { verboseItem, verboseList, workspaceId } from './fields.js';

export const workspaceTools: ToolDefinition[] = [
  defineTool({
    name: 'list-workspaces',
    title: 'List Workspaces',
    description:
      'List all workspaces the authenticated user has access to. Compact view keeps: id, name. Pass verbose=true for the full raw objects (description, image, locked, suspended, createdOn, ...).',
    inputSchema: z.strictObject({
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of workspaces to return (optional)'),
      offset: z
        .number()
        .min(0)
        .optional()
        .describe('Number of workspaces to skip for pagination (optional)'),
      verbose: verboseList,
    }),
    annotations: READ_ONLY,
    handler: async ({ limit, offset, verbose }, { client }) => {
      const workspaces = await client.getWorkspaces(limit, offset);
      return jsonResult({
        workspaces: verbose ? workspaces : projectWorkspaces(workspaces),
        count: workspaces.length,
      });
    },
  }),
  defineTool({
    name: 'get-workspace',
    title: 'Get Workspace',
    description:
      'Get detailed information about a specific workspace. Compact view keeps: id, name. Pass verbose=true for the full raw object (description, image, locked, suspended, createdOn, ...).',
    inputSchema: z.strictObject({ workspaceId, verbose: verboseItem }),
    annotations: READ_ONLY,
    handler: async ({ workspaceId, verbose }, { client }) => {
      const workspace = await client.getWorkspace(workspaceId);
      return jsonResult({ workspace: verbose ? workspace : toCompactWorkspace(workspace) });
    },
  }),
];
