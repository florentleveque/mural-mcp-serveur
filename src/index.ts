#!/usr/bin/env node

import 'dotenv/config';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { jsonError, jsonResult } from './mcp-format.js';
import { MuralClient } from './mural-client.js';
import {
  projectBoards,
  projectRooms,
  projectTemplates,
  projectWidgets,
  projectWorkspaces,
  toCompactBoard,
  toCompactRoom,
  toCompactWidget,
  toCompactWorkspace,
} from './projections.js';

const REQUIRED_ENV_VARS = ['MURAL_CLIENT_ID', 'MURAL_CLIENT_SECRET'] as const;

// Shared Zod field for the `verbose` escape hatch exposed by every read tool.
const verboseFlag = z.boolean().optional().default(false);

function validateEnvironment(): { clientId: string; clientSecret: string; redirectUri?: string } {
  const clientId = process.env.MURAL_CLIENT_ID;
  if (!clientId) {
    throw new Error('Missing required environment variable: MURAL_CLIENT_ID. ' + 'Please set this in your environment or .env file.');
  }

  const clientSecret = process.env.MURAL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_SECRET. ' +
        'Mural requires client authentication (the client secret) for the OAuth token exchange. ' +
        'Copy it from your Mural app (Basic Information page) and set it in your environment or .env file.',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.MURAL_REDIRECT_URI,
  };
}

async function main() {
  const { clientId, clientSecret, redirectUri } = validateEnvironment();

  const muralClient = new MuralClient(clientId, clientSecret, redirectUri);

  const server = new Server(
    {
      name: 'mural-mcp-serveur',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list-workspaces',
          description:
            'List all workspaces the authenticated user has access to. Compact view keeps: id, name. Pass verbose=true for the full raw objects (description, image, locked, suspended, createdOn, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of workspaces to return (optional)',
                minimum: 1,
                maximum: 100,
              },
              offset: {
                type: 'number',
                description: 'Number of workspaces to skip for pagination (optional)',
                minimum: 0,
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get-workspace',
          description:
            'Get detailed information about a specific workspace. Compact view keeps: id, name. Pass verbose=true for the full raw object (description, image, locked, suspended, createdOn, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw object instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
        {
          name: 'test-connection',
          description: 'Test the connection to Mural API and verify authentication',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'clear-auth',
          description: 'Clear stored authentication tokens (requires re-authentication)',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'debug-api-response',
          description: 'Debug tool: Show raw API response from workspaces endpoint for troubleshooting',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'get-rate-limit-status',
          description: 'Get current rate limiting status including remaining tokens and refresh times',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'list-workspace-boards',
          description:
            'List all boards (murals) within a specific workspace. Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw objects (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
        {
          name: 'list-room-boards',
          description:
            'List all boards (murals) within a specific room. Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw objects (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              roomId: {
                type: 'string',
                description: 'The unique identifier of the room',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['roomId'],
            additionalProperties: false,
          },
        },
        {
          name: 'list-workspace-rooms',
          description:
            'List all rooms within a specific workspace (use a room id with list-room-boards). Returns all pages. Compact view keeps: id, name, type, workspaceId. Pass verbose=true for the full raw objects (confidential, isMember, description, favorite, createdBy, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace',
              },
              openOnly: {
                type: 'boolean',
                description: 'If true, list only open (discoverable) rooms instead of all rooms (optional, defaults to false)',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
        {
          name: 'list-workspace-templates',
          description:
            "List a workspace's templates (default + custom), or search them by name. Returns all pages. Compact view keeps: id, name, description, type. Pass verbose=true for the full raw objects (thumbUrl, viewLink, createdBy, updatedOn, ...).",
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace',
              },
              searchQuery: {
                type: 'string',
                description: 'Optional. If provided, search templates by name instead of listing all',
              },
              withoutDefault: {
                type: 'boolean',
                description: 'If true, exclude Mural default templates and return only custom ones (optional, ignored when searchQuery is set)',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['workspaceId'],
            additionalProperties: false,
          },
        },
        {
          name: 'create-mural-from-template',
          description: 'Create a new mural in a room from a template',
          inputSchema: {
            type: 'object',
            properties: {
              templateId: {
                type: 'string',
                description: 'The unique identifier of the template to instantiate',
              },
              title: {
                type: 'string',
                description: 'Title of the new mural',
              },
              roomId: {
                type: 'number',
                description: 'The numeric identifier of the destination room',
              },
              folderId: {
                type: 'string',
                description: 'Optional destination folder id within the room',
              },
            },
            required: ['templateId', 'title', 'roomId'],
            additionalProperties: false,
          },
        },
        {
          name: 'create-room',
          description: 'Create a new room in a workspace',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace',
              },
              name: {
                type: 'string',
                description: 'Name of the new room',
              },
              type: {
                type: 'string',
                enum: ['open', 'private'],
                description: 'Room visibility: "open" (discoverable by workspace members) or "private"',
              },
              description: {
                type: 'string',
                description: 'Optional description of the room',
              },
              confidential: {
                type: 'boolean',
                description: 'Optional. Mark the room as confidential (defaults to false)',
              },
            },
            required: ['workspaceId', 'name', 'type'],
            additionalProperties: false,
          },
        },
        {
          name: 'create-mural',
          description: 'Create a new blank mural in a room (requires murals:write)',
          inputSchema: {
            type: 'object',
            properties: {
              roomId: { type: 'number', description: 'The numeric identifier of the destination room' },
              title: { type: 'string', description: 'Optional title of the new mural' },
              backgroundColor: { type: 'string', description: 'Optional background color (hex, e.g. #FFFFFFFF)' },
              width: { type: 'number', description: 'Optional canvas width in pixels' },
              height: { type: 'number', description: 'Optional canvas height in pixels' },
              infinite: { type: 'boolean', description: 'Optional. Whether the canvas is infinite' },
              folderId: { type: 'string', description: 'Optional destination folder id within the room' },
            },
            required: ['roomId'],
            additionalProperties: false,
          },
        },
        {
          name: 'update-mural',
          description:
            "Update a mural's properties by id (title, status, dimensions, sharing permissions...). Provide at least one field (requires murals:write)",
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to update' },
              title: { type: 'string' },
              backgroundColor: { type: 'string', description: 'Hex background color' },
              favorite: { type: 'boolean' },
              status: {
                type: 'string',
                enum: ['active', 'archived'],
                description: 'Set to "archived" to archive the mural (non-destructive alternative to delete)',
              },
              width: { type: 'number', description: 'Canvas width (3000-60000)' },
              height: { type: 'number', description: 'Canvas height (3000-60000)' },
              infinite: { type: 'boolean' },
              visitorsPermission: { type: 'string', enum: ['read', 'write', 'none'] },
              workspaceMembersPermission: { type: 'string', enum: ['read', 'write', 'none'] },
              folderId: { type: 'string' },
            },
            required: ['muralId'],
            additionalProperties: false,
          },
        },
        {
          name: 'delete-mural',
          description:
            'Permanently delete a mural by its id (irreversible; requires murals:write). For a non-destructive alternative, use update-mural with status "archived"',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to delete' },
            },
            required: ['muralId'],
            additionalProperties: false,
          },
        },
        {
          name: 'duplicate-mural',
          description: 'Duplicate an existing mural into a room (requires murals:write)',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to duplicate' },
              roomId: { type: 'number', description: 'The numeric identifier of the destination room' },
              title: { type: 'string', description: 'Title of the duplicated mural' },
              folderId: { type: 'string', description: 'Optional destination folder id' },
              infinite: { type: 'boolean', description: 'Optional. Whether the canvas is infinite' },
            },
            required: ['muralId', 'roomId', 'title'],
            additionalProperties: false,
          },
        },
        {
          name: 'export-mural',
          description: 'Export a mural in a given format (requires murals:read). Accepted downloadFormat values are defined by the Mural API',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to export' },
              downloadFormat: { type: 'string', description: 'The export format (e.g. pdf, png, zip — values defined by the Mural API)' },
            },
            required: ['muralId', 'downloadFormat'],
            additionalProperties: false,
          },
        },
        {
          name: 'get-export-status',
          description:
            'Check the status of an async mural export (requires murals:read). Optional/observability-only: returns ready:true plus the download URL when the file is available, ready:false while still processing. To actually fetch the file you do not need this — call download-export directly (it resolves the URL itself). Use this only to report progress to the user',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural being exported' },
              exportId: { type: 'string', description: 'The export job identifier returned by export-mural' },
            },
            required: ['muralId', 'exportId'],
            additionalProperties: false,
          },
        },
        {
          name: 'download-export',
          description:
            'Download a ready mural export to a local file (requires murals:read). Resolves the export URL itself then writes the file to outputPath. Single-shot: if the export is not ready yet it returns ready:false without writing. Normal usage: call this directly (no need for get-export-status first) and, while it returns ready:false, wait a few seconds and call it again until ready:true',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural being exported' },
              exportId: { type: 'string', description: 'The export job identifier returned by export-mural' },
              outputPath: { type: 'string', description: 'Absolute path of the local file to write the export to (parent directory is created if missing)' },
            },
            required: ['muralId', 'exportId', 'outputPath'],
            additionalProperties: false,
          },
        },
        {
          name: 'get-board',
          description:
            'Get detailed information about a specific board (mural). Compact view keeps: id, title, status, roomId, workspaceId, infinite, updatedOn, _canvasLink. Pass verbose=true for the full raw object (thumbnailUrl, sharing/visitor links, state, createdBy, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              boardId: {
                type: 'string',
                description: 'The unique identifier of the board/mural',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw object instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['boardId'],
            additionalProperties: false,
          },
        },
        {
          name: 'check-user-scopes',
          description: "Check the current user's OAuth scopes and permissions",
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        // Content reading tools
        {
          name: 'get-mural-widgets',
          description:
            'Get all widgets from a mural. Compact view keeps: id, type, x, y, width, height, parentId plus per-type content (text, shape, backgroundColor, title, url, filename, points, ...). Pass verbose=true for the full raw widget objects (full style, rotation, authorship, flags, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw widget objects instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['muralId'],
            additionalProperties: false,
          },
        },
        {
          name: 'get-mural-widget',
          description:
            'Get details of a specific widget by its ID (requires both the mural id and the widget id). Compact view keeps: id, type, x, y, width, height, parentId plus per-type content (text, shape, backgroundColor, title, url, filename, points, ...). Pass verbose=true for the full raw widget object (full style, rotation, authorship, flags, ...).',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural',
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the widget',
              },
              verbose: {
                type: 'boolean',
                description: 'If true, return the full raw widget object instead of the compact view (optional, defaults to false)',
              },
            },
            required: ['muralId', 'widgetId'],
            additionalProperties: false,
          },
        },
        {
          name: 'delete-widget',
          description: 'Permanently delete a widget from a mural by its ID (irreversible)',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural',
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the widget to delete',
              },
            },
            required: ['muralId', 'widgetId'],
            additionalProperties: false,
          },
        },
        // Widget creation tools
        {
          name: 'create-sticky-notes',
          description: 'Create sticky notes on a mural (max 1000 per request)',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural',
              },
              stickyNotes: {
                type: 'array',
                description: 'Array of sticky notes to create',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number', description: 'X coordinate position' },
                    y: { type: 'number', description: 'Y coordinate position' },
                    text: { type: 'string', description: 'Text content of the sticky note' },
                    width: { type: 'number', description: 'Width in pixels (optional)' },
                    height: { type: 'number', description: 'Height in pixels (optional)' },
                    style: {
                      type: 'object',
                      description: 'Visual styling properties (optional)',
                      properties: {
                        backgroundColor: { type: 'string', description: 'Background color' },
                        textColor: { type: 'string', description: 'Text color' },
                        fontSize: { type: 'number', description: 'Font size' },
                      },
                      additionalProperties: false,
                    },
                  },
                  required: ['x', 'y', 'text'],
                  additionalProperties: false,
                },
                maxItems: 1000,
                minItems: 1,
              },
            },
            required: ['muralId', 'stickyNotes'],
            additionalProperties: false,
          },
        },
        // Shape widget
        {
          name: 'create-shapes',
          description: 'Create shape widgets (rectangle, circle, triangle, diamond) on a mural. Each shape supports fill, border, and optional text.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural' },
              shapes: {
                type: 'array',
                description: 'Array of shape widgets to create',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    shape: { type: 'string', enum: ['rectangle', 'circle', 'triangle', 'diamond'], description: 'Shape geometry' },
                    text: { type: 'string', description: 'Optional text content rendered inside the shape' },
                    rotation: { type: 'number' },
                    style: {
                      type: 'object',
                      properties: {
                        backgroundColor: { type: 'string' },
                        borderColor: { type: 'string' },
                        borderWidth: { type: 'number' },
                        borderStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
                        fontColor: { type: 'string' },
                        fontSize: { type: 'number' },
                        fontFamily: { type: 'string' },
                        bold: { type: 'boolean' },
                        italic: { type: 'boolean' },
                        textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ['x', 'y', 'width', 'height', 'shape'],
                  additionalProperties: true,
                },
                minItems: 1,
              },
            },
            required: ['muralId', 'shapes'],
            additionalProperties: false,
          },
        },
        // Arrow / connector widget
        {
          name: 'create-arrows',
          description:
            'Create arrow (connector) widgets on a mural. Arrows can anchor to other widgets via startRefId/endRefId or use absolute start/end points in the points array.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural' },
              arrows: {
                type: 'array',
                description: 'Array of arrow widgets to create',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    points: {
                      type: 'array',
                      description:
                        'Two or more {x,y} points defining the arrow path. Coordinates are relative to x/y or absolute depending on Mural API version.',
                      items: {
                        type: 'object',
                        properties: { x: { type: 'number' }, y: { type: 'number' } },
                        required: ['x', 'y'],
                        additionalProperties: false,
                      },
                      minItems: 2,
                    },
                    arrowType: { type: 'string', enum: ['straight', 'curved', 'orthogonal'] },
                    tip: { type: 'string', enum: ['no tip', 'single', 'double'] },
                    startRefId: { type: 'string', description: 'Widget ID that the arrow starts at (anchors to widget)' },
                    endRefId: { type: 'string', description: 'Widget ID that the arrow ends at (anchors to widget)' },
                    label: { type: 'object', description: 'Optional label attached to the arrow' },
                    style: {
                      type: 'object',
                      properties: {
                        color: { type: 'string' },
                        width: { type: 'number' },
                        arrowheadType: { type: 'string' },
                        strokeStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ['x', 'y', 'width', 'height', 'points'],
                  additionalProperties: true,
                },
                minItems: 1,
              },
            },
            required: ['muralId', 'arrows'],
            additionalProperties: false,
          },
        },
        // Text box widget
        {
          name: 'create-text-boxes',
          description: 'Create text box widgets on a mural. Unlike sticky notes, text boxes support full font color, font size, and alignment.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string' },
              textBoxes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    text: { type: 'string' },
                    rotation: { type: 'number' },
                    style: {
                      type: 'object',
                      properties: {
                        backgroundColor: { type: 'string' },
                        fontColor: { type: 'string' },
                        fontSize: { type: 'number' },
                        fontFamily: { type: 'string' },
                        bold: { type: 'boolean' },
                        italic: { type: 'boolean' },
                        textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
                        border: { type: 'boolean' },
                        borderColor: { type: 'string' },
                        borderWidth: { type: 'number' },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ['x', 'y', 'width', 'height', 'text'],
                  additionalProperties: true,
                },
                minItems: 1,
              },
            },
            required: ['muralId', 'textBoxes'],
            additionalProperties: false,
          },
        },
        // Title widget
        {
          name: 'create-titles',
          description: 'Create title widgets (large heading text) on a mural.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string' },
              titles: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    text: { type: 'string' },
                    style: {
                      type: 'object',
                      properties: {
                        fontColor: { type: 'string' },
                        fontSize: { type: 'number' },
                        fontFamily: { type: 'string' },
                        bold: { type: 'boolean' },
                        italic: { type: 'boolean' },
                        textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ['x', 'y', 'text'],
                  additionalProperties: true,
                },
                minItems: 1,
              },
            },
            required: ['muralId', 'titles'],
            additionalProperties: false,
          },
        },
        // Area widget (grouping container)
        {
          name: 'create-areas',
          description: 'Create area widgets (grouping containers) on a mural.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string' },
              areas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    title: { type: 'string' },
                    style: {
                      type: 'object',
                      properties: {
                        backgroundColor: { type: 'string' },
                        borderColor: { type: 'string' },
                        borderWidth: { type: 'number' },
                        fontColor: { type: 'string' },
                        fontSize: { type: 'number' },
                      },
                      additionalProperties: true,
                    },
                  },
                  required: ['x', 'y', 'width', 'height'],
                  additionalProperties: true,
                },
                minItems: 1,
              },
            },
            required: ['muralId', 'areas'],
            additionalProperties: false,
          },
        },
        // Generic update tool — works for any widget kind
        {
          name: 'update-widget',
          description: 'Update any widget by kind and ID (sticky-note, shape, arrow, text-box, title, area). Accepts arbitrary field updates.',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string' },
              kind: { type: 'string', enum: ['sticky-note', 'shape', 'arrow', 'text-box', 'title', 'area'] },
              widgetId: { type: 'string' },
              updates: { type: 'object', additionalProperties: true },
            },
            required: ['muralId', 'kind', 'widgetId', 'updates'],
            additionalProperties: false,
          },
        },
        // PATCH/Update tools
        {
          name: 'update-sticky-note',
          description: 'Update a sticky note widget in a mural',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural',
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the sticky note widget to update',
              },
              updates: {
                type: 'object',
                description: 'The properties to update',
                properties: {
                  x: { type: 'number', description: 'X coordinate position' },
                  y: { type: 'number', description: 'Y coordinate position' },
                  text: { type: 'string', description: 'Text content of the sticky note' },
                  width: { type: 'number', description: 'Width in pixels' },
                  height: { type: 'number', description: 'Height in pixels' },
                  style: {
                    type: 'object',
                    description: 'Visual styling properties',
                    properties: {
                      backgroundColor: { type: 'string', description: 'Background color' },
                      textColor: { type: 'string', description: 'Text color' },
                      fontSize: { type: 'number', description: 'Font size' },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
            required: ['muralId', 'widgetId', 'updates'],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'list-workspaces': {
          const schema = z.object({
            limit: z.number().min(1).max(100).optional(),
            offset: z.number().min(0).optional(),
            verbose: verboseFlag,
          });

          const { limit, offset, verbose } = schema.parse(args || {});
          const workspaces = await muralClient.getWorkspaces(limit, offset);

          return jsonResult({ workspaces: verbose ? workspaces : projectWorkspaces(workspaces), count: workspaces.length });
        }

        case 'get-workspace': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { workspaceId, verbose } = schema.parse(args);
          const workspace = await muralClient.getWorkspace(workspaceId);

          return jsonResult({ workspace: verbose ? workspace : toCompactWorkspace(workspace) });
        }

        case 'test-connection': {
          const isConnected = await muralClient.testConnection();

          return jsonResult({
            connected: isConnected,
            message: isConnected ? 'Successfully connected to Mural API' : 'Failed to connect to Mural API',
          });
        }

        case 'clear-auth': {
          await muralClient.clearAuthentication();

          return jsonResult({ message: 'Authentication tokens cleared. You will need to re-authenticate on the next API call.' });
        }

        case 'debug-api-response': {
          const debugInfo = await muralClient.debugWorkspacesAPI();

          return jsonResult({ debug: debugInfo, message: 'Raw API response data for troubleshooting' });
        }

        case 'get-rate-limit-status': {
          const rateLimitStatus = await muralClient.getRateLimitStatus();

          return jsonResult({
            rateLimits: rateLimitStatus,
            explanation: {
              user: `${rateLimitStatus.user.tokensRemaining}/${rateLimitStatus.user.capacity} requests available (${rateLimitStatus.user.refillRate}/second)`,
              app: `${rateLimitStatus.app.tokensRemaining}/${rateLimitStatus.app.capacity} requests available (${rateLimitStatus.app.refillRate}/minute)`,
            },
          });
        }

        case 'list-workspace-boards': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { workspaceId, verbose } = schema.parse(args);
          const boards = await muralClient.getWorkspaceMurals(workspaceId);

          return jsonResult({ boards: verbose ? boards : projectBoards(boards), count: boards.length, workspaceId });
        }

        case 'list-room-boards': {
          const schema = z.object({
            roomId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { roomId, verbose } = schema.parse(args);
          const boards = await muralClient.getRoomMurals(roomId);

          return jsonResult({ boards: verbose ? boards : projectBoards(boards), count: boards.length, roomId });
        }

        case 'list-workspace-rooms': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            openOnly: z.boolean().optional().default(false),
            verbose: verboseFlag,
          });

          const { workspaceId, openOnly, verbose } = schema.parse(args);
          const rooms = await muralClient.getWorkspaceRooms(workspaceId, openOnly);

          return jsonResult({ rooms: verbose ? rooms : projectRooms(rooms), count: rooms.length, workspaceId, openOnly });
        }

        case 'list-workspace-templates': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            searchQuery: z.string().optional(),
            withoutDefault: z.boolean().optional().default(false),
            verbose: verboseFlag,
          });

          const { workspaceId, searchQuery, withoutDefault, verbose } = schema.parse(args);
          const templates = await muralClient.getWorkspaceTemplates(workspaceId, searchQuery, withoutDefault);

          return jsonResult({
            templates: verbose ? templates : projectTemplates(templates),
            count: templates.length,
            workspaceId,
            searchQuery: searchQuery ?? null,
          });
        }

        case 'create-mural-from-template': {
          const schema = z.object({
            templateId: z.string().min(1),
            title: z.string().min(1),
            roomId: z.number(),
            folderId: z.string().optional(),
          });

          const { templateId, title, roomId, folderId } = schema.parse(args);
          const mural = await muralClient.createMuralFromTemplate(templateId, title, roomId, folderId);

          return jsonResult({ mural: toCompactBoard(mural), message: `Created mural "${title}" from template ${templateId} in room ${roomId}` });
        }

        case 'create-room': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            name: z.string().min(1),
            type: z.enum(['open', 'private']),
            description: z.string().optional(),
            confidential: z.boolean().optional(),
          });

          const { workspaceId, name, type, description, confidential } = schema.parse(args);
          const room = await muralClient.createRoom(workspaceId, name, type, description, confidential);

          return jsonResult({ room: toCompactRoom(room), message: `Created ${type} room "${name}" in workspace ${workspaceId}` });
        }

        case 'create-mural': {
          const schema = z.object({
            roomId: z.number(),
            title: z.string().optional(),
            backgroundColor: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            infinite: z.boolean().optional(),
            folderId: z.string().optional(),
          });
          const { roomId, ...options } = schema.parse(args);
          const mural = await muralClient.createMural(roomId, options);
          return jsonResult({ mural: toCompactBoard(mural), message: `Created mural in room ${roomId}` });
        }

        case 'update-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
            title: z.string().optional(),
            backgroundColor: z.string().optional(),
            favorite: z.boolean().optional(),
            status: z.enum(['active', 'archived']).optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            infinite: z.boolean().optional(),
            visitorsPermission: z.enum(['read', 'write', 'none']).optional(),
            workspaceMembersPermission: z.enum(['read', 'write', 'none']).optional(),
            folderId: z.string().optional(),
          });
          const { muralId, ...updates } = schema.parse(args);
          if (Object.keys(updates).length === 0) {
            throw new Error('update-mural requires at least one field to update');
          }
          const mural = await muralClient.updateMural(muralId, updates);
          return jsonResult({ mural: toCompactBoard(mural), message: `Updated mural ${muralId}` });
        }

        case 'delete-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
          });
          const { muralId } = schema.parse(args);
          await muralClient.deleteMural(muralId);
          return jsonResult({ message: `Deleted mural ${muralId}` });
        }

        case 'duplicate-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
            roomId: z.number(),
            title: z.string().min(1),
            folderId: z.string().optional(),
            infinite: z.boolean().optional(),
          });
          const { muralId, roomId, title, ...options } = schema.parse(args);
          const mural = await muralClient.duplicateMural(muralId, roomId, title, options);
          return jsonResult({ mural: toCompactBoard(mural), message: `Duplicated mural ${muralId} into room ${roomId}` });
        }

        case 'export-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
            downloadFormat: z.string().min(1),
          });
          const { muralId, downloadFormat } = schema.parse(args);
          const result = await muralClient.exportMural(muralId, downloadFormat);
          return jsonResult({
            export: result,
            message: `Started export of mural ${muralId} as ${downloadFormat}. Poll get-export-status with the returned exportId, then download-export once ready`,
          });
        }

        case 'get-export-status': {
          const schema = z.object({
            muralId: z.string().min(1),
            exportId: z.string().min(1),
          });
          const { muralId, exportId } = schema.parse(args);
          const status = await muralClient.getExportStatus(muralId, exportId);
          const ready = typeof status?.url === 'string';
          return jsonResult({ status, ready, message: ready ? `Export ${exportId} is ready` : `Export ${exportId} is still processing` });
        }

        case 'download-export': {
          const schema = z.object({
            muralId: z.string().min(1),
            exportId: z.string().min(1),
            outputPath: z.string().min(1),
          });
          const { muralId, exportId, outputPath } = schema.parse(args);
          const result = await muralClient.downloadExport(muralId, exportId, outputPath);
          return jsonResult({
            ...result,
            muralId,
            exportId,
            message: result.ready ? `Saved export to ${result.path}` : `Export ${exportId} not ready yet — retry later`,
          });
        }

        case 'get-board': {
          const schema = z.object({
            boardId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { boardId, verbose } = schema.parse(args);
          const board = await muralClient.getMural(boardId);

          return jsonResult({ board: verbose ? board : toCompactBoard(board) });
        }

        case 'check-user-scopes': {
          const scopes = await muralClient.getUserScopes();

          // Only try to get user info if we have identity:read scope
          let user = null;
          if (scopes.includes('identity:read')) {
            user = await muralClient.getCurrentUser().catch(() => null);
          }

          const expectedScopes = [
            'workspaces:read',
            'rooms:read',
            'rooms:write',
            'murals:read',
            'murals:write',
            'templates:read',
            'templates:write',
            'identity:read',
          ];
          const missing = expectedScopes.filter(scope => !scopes.includes(scope));

          return jsonResult({
            user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } : null,
            scopes,
            missing,
          });
        }

        // Content reading tools
        case 'get-mural-widgets': {
          const schema = z.object({
            muralId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { muralId, verbose } = schema.parse(args);
          const widgets = await muralClient.getMuralWidgets(muralId);

          return jsonResult({ widgets: verbose ? widgets : projectWidgets(widgets), count: widgets.length, muralId });
        }

        case 'get-mural-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            widgetId: z.string().min(1),
            verbose: verboseFlag,
          });

          const { muralId, widgetId, verbose } = schema.parse(args);
          const widget = await muralClient.getMuralWidget(muralId, widgetId);

          return jsonResult({ widget: verbose ? widget : toCompactWidget(widget), muralId, widgetId });
        }

        // Widget creation tools
        case 'create-sticky-notes': {
          const schema = z.object({
            muralId: z.string().min(1),
            stickyNotes: z
              .array(
                z.object({
                  x: z.number(),
                  y: z.number(),
                  text: z.string().min(1),
                  width: z.number().optional(),
                  height: z.number().optional(),
                  style: z
                    .object({
                      backgroundColor: z.string().optional(),
                      textColor: z.string().optional(),
                      fontSize: z.number().optional(),
                    })
                    .optional(),
                }),
              )
              .min(1)
              .max(1000),
          });

          const { muralId, stickyNotes } = schema.parse(args);

          // Helper function to calculate text-based dimensions
          function calculateTextDimensions(text: string, fontSize = 14) {
            const charWidth = fontSize * 0.6; // Approximate character width
            const lineHeight = fontSize * 1.4; // Standard line height
            const padding = 20; // Padding for sticky note
            const minWidth = 120; // Minimum sticky note width
            const maxWidth = 400; // Maximum sticky note width

            // Estimate text width and wrap to calculate height
            const words = text.split(' ');
            let currentLineWidth = 0;
            let lines = 1;

            for (const word of words) {
              const wordWidth = (word.length + 1) * charWidth; // +1 for space

              if (currentLineWidth + wordWidth > maxWidth - padding) {
                // Word doesn't fit, start new line
                lines++;
                currentLineWidth = word.length * charWidth;
              } else {
                currentLineWidth += wordWidth;
              }
            }

            const calculatedWidth = Math.min(Math.max(currentLineWidth + padding, minWidth), maxWidth);
            const calculatedHeight = Math.max(lines * lineHeight + padding, 60); // Minimum height of 60

            return { width: calculatedWidth, height: calculatedHeight };
          }

          // Add required shape field and calculate dimensions for each sticky note
          const stickyNotesWithShape = stickyNotes.map(note => {
            const fontSize = note.style?.fontSize || 14;
            const dimensions = calculateTextDimensions(note.text, fontSize);

            return {
              ...note,
              shape: 'rectangle' as const,
              // Use provided dimensions if available, otherwise use calculated ones
              width: note.width || dimensions.width,
              height: note.height || dimensions.height,
            };
          });

          const createdWidgets = await muralClient.createStickyNotes(muralId, stickyNotesWithShape);

          return jsonResult({
            widgets: projectWidgets(createdWidgets),
            count: createdWidgets.length,
            muralId,
            message: `Successfully created ${createdWidgets.length} sticky note${createdWidgets.length === 1 ? '' : 's'} in mural ${muralId}`,
          });
        }

        // PATCH/Update tool handlers
        case 'update-sticky-note': {
          const schema = z.object({
            muralId: z.string().min(1),
            widgetId: z.string().min(1),
            updates: z.object({
              x: z.number().optional(),
              y: z.number().optional(),
              text: z.string().min(1).optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              style: z
                .object({
                  backgroundColor: z.string().optional(),
                  textColor: z.string().optional(),
                  fontSize: z.number().optional(),
                })
                .optional(),
            }),
          });

          const { muralId, widgetId, updates } = schema.parse(args);
          const updatedWidget = await muralClient.updateStickyNote(muralId, widgetId, updates);

          return jsonResult({
            widget: toCompactWidget(updatedWidget),
            muralId,
            widgetId,
            message: `Successfully updated sticky note ${widgetId} in mural ${muralId}`,
          });
        }

        case 'delete-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            widgetId: z.string().min(1),
          });
          const { muralId, widgetId } = schema.parse(args);
          await muralClient.deleteWidget(muralId, widgetId);
          return jsonResult({ muralId, widgetId, deleted: true, message: `Successfully deleted widget ${widgetId} from mural ${muralId}` });
        }

        case 'create-shapes': {
          const schema = z.object({
            muralId: z.string().min(1),
            shapes: z.array(z.record(z.string(), z.unknown())).min(1),
          });
          const { muralId, shapes } = schema.parse(args);
          const createdWidgets = await muralClient.createShapes(muralId, shapes);
          const count = Array.isArray(createdWidgets) ? createdWidgets.length : 0;
          return jsonResult({
            widgets: Array.isArray(createdWidgets) ? projectWidgets(createdWidgets) : createdWidgets,
            count,
            muralId,
            message: `Created ${count} shape widget(s)`,
          });
        }

        case 'create-arrows': {
          const schema = z.object({
            muralId: z.string().min(1),
            arrows: z.array(z.record(z.string(), z.unknown())).min(1),
          });
          const { muralId, arrows } = schema.parse(args);
          const createdWidgets = await muralClient.createArrows(muralId, arrows);
          const count = Array.isArray(createdWidgets) ? createdWidgets.length : 0;
          return jsonResult({
            widgets: Array.isArray(createdWidgets) ? projectWidgets(createdWidgets) : createdWidgets,
            count,
            muralId,
            message: `Created ${count} arrow widget(s)`,
          });
        }

        case 'create-text-boxes': {
          const schema = z.object({
            muralId: z.string().min(1),
            textBoxes: z.array(z.record(z.string(), z.unknown())).min(1),
          });
          const { muralId, textBoxes } = schema.parse(args);
          const createdWidgets = await muralClient.createTextBoxes(muralId, textBoxes);
          const count = Array.isArray(createdWidgets) ? createdWidgets.length : 0;
          return jsonResult({
            widgets: Array.isArray(createdWidgets) ? projectWidgets(createdWidgets) : createdWidgets,
            count,
            muralId,
            message: `Created ${count} text-box widget(s)`,
          });
        }

        case 'create-titles': {
          const schema = z.object({
            muralId: z.string().min(1),
            titles: z.array(z.record(z.string(), z.unknown())).min(1),
          });
          const { muralId, titles } = schema.parse(args);
          const createdWidgets = await muralClient.createTitles(muralId, titles);
          const count = Array.isArray(createdWidgets) ? createdWidgets.length : 0;
          return jsonResult({
            widgets: Array.isArray(createdWidgets) ? projectWidgets(createdWidgets) : createdWidgets,
            count,
            muralId,
            message: `Created ${count} title widget(s)`,
          });
        }

        case 'create-areas': {
          const schema = z.object({
            muralId: z.string().min(1),
            areas: z.array(z.record(z.string(), z.unknown())).min(1),
          });
          const { muralId, areas } = schema.parse(args);
          const createdWidgets = await muralClient.createAreas(muralId, areas);
          const count = Array.isArray(createdWidgets) ? createdWidgets.length : 0;
          return jsonResult({
            widgets: Array.isArray(createdWidgets) ? projectWidgets(createdWidgets) : createdWidgets,
            count,
            muralId,
            message: `Created ${count} area widget(s)`,
          });
        }

        case 'update-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            kind: z.enum(['sticky-note', 'shape', 'arrow', 'text-box', 'title', 'area']),
            widgetId: z.string().min(1),
            updates: z.record(z.string(), z.unknown()),
          });
          const { muralId, kind, widgetId, updates } = schema.parse(args);
          let updated: any;
          switch (kind) {
            case 'sticky-note':
              updated = await muralClient.updateStickyNote(muralId, widgetId, updates);
              break;
            case 'shape':
              updated = await muralClient.updateShape(muralId, widgetId, updates);
              break;
            case 'arrow':
              updated = await muralClient.updateArrow(muralId, widgetId, updates);
              break;
            case 'text-box':
              updated = await muralClient.updateTextBox(muralId, widgetId, updates);
              break;
            case 'title':
              updated = await muralClient.updateTitle(muralId, widgetId, updates);
              break;
            case 'area':
              updated = await muralClient.updateArea(muralId, widgetId, updates);
              break;
          }
          return jsonResult({ widget: toCompactWidget(updated), muralId, widgetId, kind, message: `Updated ${kind} ${widgetId}` });
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return jsonError(error, name);
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Mural MCP Server running on stdio');
  console.error(`Required environment variables: ${REQUIRED_ENV_VARS.join(', ')}`);
  console.error('Server ready to accept requests...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server
main().catch(error => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
