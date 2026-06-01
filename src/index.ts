#!/usr/bin/env node

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MuralClient } from './mural-client.js';

const REQUIRED_ENV_VARS = ['MURAL_CLIENT_ID', 'MURAL_CLIENT_SECRET'] as const;

function validateEnvironment(): { clientId: string; clientSecret: string; redirectUri?: string } {
  const clientId = process.env.MURAL_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_ID. ' +
      'Please set this in your environment or .env file.'
    );
  }

  const clientSecret = process.env.MURAL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_SECRET. ' +
      'Mural requires client authentication (the client secret) for the OAuth token exchange. ' +
      'Copy it from your Mural app (Basic Information page) and set it in your environment or .env file.'
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.MURAL_REDIRECT_URI
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
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list-workspaces',
          description: 'List all workspaces the authenticated user has access to',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of workspaces to return (optional)',
                minimum: 1,
                maximum: 100
              },
              offset: {
                type: 'number',
                description: 'Number of workspaces to skip for pagination (optional)',
                minimum: 0
              }
            },
            additionalProperties: false
          },
        },
        {
          name: 'get-workspace',
          description: 'Get detailed information about a specific workspace',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace'
              }
            },
            required: ['workspaceId'],
            additionalProperties: false
          },
        },
        {
          name: 'test-connection',
          description: 'Test the connection to Mural API and verify authentication',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
        },
        {
          name: 'clear-auth',
          description: 'Clear stored authentication tokens (requires re-authentication)',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
        },
        {
          name: 'debug-api-response',
          description: 'Debug tool: Show raw API response from workspaces endpoint for troubleshooting',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
        },
        {
          name: 'get-rate-limit-status',
          description: 'Get current rate limiting status including remaining tokens and refresh times',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
        },
        {
          name: 'list-workspace-boards',
          description: 'List all boards (murals) within a specific workspace',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace'
              }
            },
            required: ['workspaceId'],
            additionalProperties: false
          },
        },
        {
          name: 'list-room-boards',
          description: 'List all boards (murals) within a specific room',
          inputSchema: {
            type: 'object',
            properties: {
              roomId: {
                type: 'string',
                description: 'The unique identifier of the room'
              }
            },
            required: ['roomId'],
            additionalProperties: false
          },
        },
        {
          name: 'list-workspace-rooms',
          description: 'List all rooms within a specific workspace (use a room id with list-room-boards). Returns all pages.',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace'
              },
              openOnly: {
                type: 'boolean',
                description: 'If true, list only open (discoverable) rooms instead of all rooms (optional, defaults to false)'
              }
            },
            required: ['workspaceId'],
            additionalProperties: false
          },
        },
        {
          name: 'list-workspace-templates',
          description: 'List a workspace\'s templates (default + custom), or search them by name. Returns all pages.',
          inputSchema: {
            type: 'object',
            properties: {
              workspaceId: {
                type: 'string',
                description: 'The unique identifier of the workspace'
              },
              searchQuery: {
                type: 'string',
                description: 'Optional. If provided, search templates by name instead of listing all'
              },
              withoutDefault: {
                type: 'boolean',
                description: 'If true, exclude Mural default templates and return only custom ones (optional, ignored when searchQuery is set)'
              }
            },
            required: ['workspaceId'],
            additionalProperties: false
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
                description: 'The unique identifier of the template to instantiate'
              },
              title: {
                type: 'string',
                description: 'Title of the new mural'
              },
              roomId: {
                type: 'number',
                description: 'The numeric identifier of the destination room'
              },
              folderId: {
                type: 'string',
                description: 'Optional destination folder id within the room'
              }
            },
            required: ['templateId', 'title', 'roomId'],
            additionalProperties: false
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
                description: 'The unique identifier of the workspace'
              },
              name: {
                type: 'string',
                description: 'Name of the new room'
              },
              type: {
                type: 'string',
                enum: ['open', 'private'],
                description: 'Room visibility: "open" (discoverable by workspace members) or "private"'
              },
              description: {
                type: 'string',
                description: 'Optional description of the room'
              },
              confidential: {
                type: 'boolean',
                description: 'Optional. Mark the room as confidential (defaults to false)'
              }
            },
            required: ['workspaceId', 'name', 'type'],
            additionalProperties: false
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
              folderId: { type: 'string', description: 'Optional destination folder id within the room' }
            },
            required: ['roomId'],
            additionalProperties: false
          },
        },
        {
          name: 'update-mural',
          description: 'Update a mural\'s properties by id (title, status, dimensions, sharing permissions...). Provide at least one field (requires murals:write)',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to update' },
              title: { type: 'string' },
              backgroundColor: { type: 'string', description: 'Hex background color' },
              favorite: { type: 'boolean' },
              status: { type: 'string', enum: ['active', 'archived'], description: 'Set to "archived" to archive the mural (non-destructive alternative to delete)' },
              width: { type: 'number', description: 'Canvas width (3000-60000)' },
              height: { type: 'number', description: 'Canvas height (3000-60000)' },
              infinite: { type: 'boolean' },
              visitorsPermission: { type: 'string', enum: ['read', 'write', 'none'] },
              workspaceMembersPermission: { type: 'string', enum: ['read', 'write', 'none'] },
              folderId: { type: 'string' }
            },
            required: ['muralId'],
            additionalProperties: false
          },
        },
        {
          name: 'delete-mural',
          description: 'Permanently delete a mural by its id (irreversible; requires murals:write). For a non-destructive alternative, use update-mural with status "archived"',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to delete' }
            },
            required: ['muralId'],
            additionalProperties: false
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
              infinite: { type: 'boolean', description: 'Optional. Whether the canvas is infinite' }
            },
            required: ['muralId', 'roomId', 'title'],
            additionalProperties: false
          },
        },
        {
          name: 'export-mural',
          description: 'Export a mural in a given format (requires murals:read). Accepted downloadFormat values are defined by the Mural API',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: { type: 'string', description: 'The unique identifier of the mural to export' },
              downloadFormat: { type: 'string', description: 'The export format (e.g. pdf, png, zip — values defined by the Mural API)' }
            },
            required: ['muralId', 'downloadFormat'],
            additionalProperties: false
          },
        },
        {
          name: 'get-board',
          description: 'Get detailed information about a specific board (mural)',
          inputSchema: {
            type: 'object',
            properties: {
              boardId: {
                type: 'string',
                description: 'The unique identifier of the board/mural'
              }
            },
            required: ['boardId'],
            additionalProperties: false
          },
        },
        {
          name: 'check-user-scopes',
          description: 'Check the current user\'s OAuth scopes and permissions',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
        },
        // Content reading tools
        {
          name: 'get-mural-widgets',
          description: 'Get all widgets from a mural',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural'
              }
            },
            required: ['muralId'],
            additionalProperties: false
          },
        },
        {
          name: 'get-mural-widget',
          description: 'Get details of a specific widget by its ID (requires both the mural id and the widget id)',
          inputSchema: {
            type: 'object',
            properties: {
              muralId: {
                type: 'string',
                description: 'The unique identifier of the mural'
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the widget'
              }
            },
            required: ['muralId', 'widgetId'],
            additionalProperties: false
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
                description: 'The unique identifier of the mural'
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the widget to delete'
              }
            },
            required: ['muralId', 'widgetId'],
            additionalProperties: false
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
                description: 'The unique identifier of the mural'
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
                        fontSize: { type: 'number', description: 'Font size' }
                      },
                      additionalProperties: false
                    }
                  },
                  required: ['x', 'y', 'text'],
                  additionalProperties: false
                },
                maxItems: 1000,
                minItems: 1
              }
            },
            required: ['muralId', 'stickyNotes'],
            additionalProperties: false
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
                        textAlign: { type: 'string', enum: ['left', 'center', 'right'] }
                      },
                      additionalProperties: true
                    }
                  },
                  required: ['x', 'y', 'width', 'height', 'shape'],
                  additionalProperties: true
                },
                minItems: 1
              }
            },
            required: ['muralId', 'shapes'],
            additionalProperties: false
          }
        },
        // Arrow / connector widget
        {
          name: 'create-arrows',
          description: 'Create arrow (connector) widgets on a mural. Arrows can anchor to other widgets via startRefId/endRefId or use absolute start/end points in the points array.',
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
                      description: 'Two or more {x,y} points defining the arrow path. Coordinates are relative to x/y or absolute depending on Mural API version.',
                      items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
                      minItems: 2
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
                        strokeStyle: { type: 'string', enum: ['solid', 'dashed', 'dotted'] }
                      },
                      additionalProperties: true
                    }
                  },
                  required: ['x', 'y', 'width', 'height', 'points'],
                  additionalProperties: true
                },
                minItems: 1
              }
            },
            required: ['muralId', 'arrows'],
            additionalProperties: false
          }
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
                        borderWidth: { type: 'number' }
                      },
                      additionalProperties: true
                    }
                  },
                  required: ['x', 'y', 'width', 'height', 'text'],
                  additionalProperties: true
                },
                minItems: 1
              }
            },
            required: ['muralId', 'textBoxes'],
            additionalProperties: false
          }
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
                        textAlign: { type: 'string', enum: ['left', 'center', 'right'] }
                      },
                      additionalProperties: true
                    }
                  },
                  required: ['x', 'y', 'text'],
                  additionalProperties: true
                },
                minItems: 1
              }
            },
            required: ['muralId', 'titles'],
            additionalProperties: false
          }
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
                        fontSize: { type: 'number' }
                      },
                      additionalProperties: true
                    }
                  },
                  required: ['x', 'y', 'width', 'height'],
                  additionalProperties: true
                },
                minItems: 1
              }
            },
            required: ['muralId', 'areas'],
            additionalProperties: false
          }
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
              updates: { type: 'object', additionalProperties: true }
            },
            required: ['muralId', 'kind', 'widgetId', 'updates'],
            additionalProperties: false
          }
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
                description: 'The unique identifier of the mural'
              },
              widgetId: {
                type: 'string',
                description: 'The unique identifier of the sticky note widget to update'
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
                      fontSize: { type: 'number', description: 'Font size' }
                    },
                    additionalProperties: false
                  }
                },
                additionalProperties: false
              }
            },
            required: ['muralId', 'widgetId', 'updates'],
            additionalProperties: false
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'list-workspaces': {
          const schema = z.object({
            limit: z.number().min(1).max(100).optional(),
            offset: z.number().min(0).optional()
          });

          const { limit, offset } = schema.parse(args || {});
          const workspaces = await muralClient.getWorkspaces(limit, offset);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  workspaces,
                  count: workspaces.length,
                  message: workspaces.length === 0
                    ? 'No workspaces found'
                    : `Found ${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}`
                }, null, 2)
              }
            ],
          };
        }

        case 'get-workspace': {
          const schema = z.object({
            workspaceId: z.string().min(1)
          });

          const { workspaceId } = schema.parse(args);
          const workspace = await muralClient.getWorkspace(workspaceId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(workspace, null, 2)
              }
            ],
          };
        }

        case 'test-connection': {
          const isConnected = await muralClient.testConnection();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  connected: isConnected,
                  message: isConnected
                    ? 'Successfully connected to Mural API'
                    : 'Failed to connect to Mural API'
                }, null, 2)
              }
            ],
          };
        }

        case 'clear-auth': {
          await muralClient.clearAuthentication();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message: 'Authentication tokens cleared. You will need to re-authenticate on the next API call.'
                }, null, 2)
              }
            ],
          };
        }

        case 'debug-api-response': {
          const debugInfo = await muralClient.debugWorkspacesAPI();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  debug: debugInfo,
                  message: 'Raw API response data for troubleshooting'
                }, null, 2)
              }
            ],
          };
        }

        case 'get-rate-limit-status': {
          const rateLimitStatus = await muralClient.getRateLimitStatus();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  rateLimits: rateLimitStatus,
                  message: 'Current rate limiting status',
                  explanation: {
                    user: `${rateLimitStatus.user.tokensRemaining}/${rateLimitStatus.user.capacity} requests available (${rateLimitStatus.user.refillRate}/second)`,
                    app: `${rateLimitStatus.app.tokensRemaining}/${rateLimitStatus.app.capacity} requests available (${rateLimitStatus.app.refillRate}/minute)`
                  }
                }, null, 2)
              }
            ],
          };
        }

        case 'list-workspace-boards': {
          const schema = z.object({
            workspaceId: z.string().min(1)
          });

          const { workspaceId } = schema.parse(args);
          const boards = await muralClient.getWorkspaceMurals(workspaceId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  boards,
                  count: boards.length,
                  workspaceId,
                  message: boards.length === 0
                    ? `No boards found in workspace ${workspaceId}`
                    : `Found ${boards.length} board${boards.length === 1 ? '' : 's'} in workspace`
                }, null, 2)
              }
            ],
          };
        }

        case 'list-room-boards': {
          const schema = z.object({
            roomId: z.string().min(1)
          });

          const { roomId } = schema.parse(args);
          const boards = await muralClient.getRoomMurals(roomId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  boards,
                  count: boards.length,
                  roomId,
                  message: boards.length === 0
                    ? `No boards found in room ${roomId}`
                    : `Found ${boards.length} board${boards.length === 1 ? '' : 's'} in room`
                }, null, 2)
              }
            ],
          };
        }

        case 'list-workspace-rooms': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            openOnly: z.boolean().optional().default(false)
          });

          const { workspaceId, openOnly } = schema.parse(args);
          const rooms = await muralClient.getWorkspaceRooms(workspaceId, openOnly);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  rooms,
                  count: rooms.length,
                  workspaceId,
                  openOnly,
                  message: rooms.length === 0
                    ? `No rooms found in workspace ${workspaceId}`
                    : `Found ${rooms.length} room${rooms.length === 1 ? '' : 's'} in workspace`
                }, null, 2)
              }
            ],
          };
        }

        case 'list-workspace-templates': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            searchQuery: z.string().optional(),
            withoutDefault: z.boolean().optional().default(false)
          });

          const { workspaceId, searchQuery, withoutDefault } = schema.parse(args);
          const templates = await muralClient.getWorkspaceTemplates(workspaceId, searchQuery, withoutDefault);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  templates,
                  count: templates.length,
                  workspaceId,
                  searchQuery: searchQuery ?? null,
                  message: templates.length === 0
                    ? `No templates found in workspace ${workspaceId}${searchQuery ? ` matching "${searchQuery}"` : ''}`
                    : `Found ${templates.length} template${templates.length === 1 ? '' : 's'}`
                }, null, 2)
              }
            ],
          };
        }

        case 'create-mural-from-template': {
          const schema = z.object({
            templateId: z.string().min(1),
            title: z.string().min(1),
            roomId: z.number(),
            folderId: z.string().optional()
          });

          const { templateId, title, roomId, folderId } = schema.parse(args);
          const mural = await muralClient.createMuralFromTemplate(templateId, title, roomId, folderId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  mural,
                  message: `Created mural "${title}" from template ${templateId} in room ${roomId}`
                }, null, 2)
              }
            ],
          };
        }

        case 'create-room': {
          const schema = z.object({
            workspaceId: z.string().min(1),
            name: z.string().min(1),
            type: z.enum(['open', 'private']),
            description: z.string().optional(),
            confidential: z.boolean().optional()
          });

          const { workspaceId, name, type, description, confidential } = schema.parse(args);
          const room = await muralClient.createRoom(workspaceId, name, type, description, confidential);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  room,
                  message: `Created ${type} room "${name}" in workspace ${workspaceId}`
                }, null, 2)
              }
            ],
          };
        }

        case 'create-mural': {
          const schema = z.object({
            roomId: z.number(),
            title: z.string().optional(),
            backgroundColor: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            infinite: z.boolean().optional(),
            folderId: z.string().optional()
          });
          const { roomId, ...options } = schema.parse(args);
          const mural = await muralClient.createMural(roomId, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ mural, message: `Created mural in room ${roomId}` }, null, 2)
              }
            ],
          };
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
            folderId: z.string().optional()
          });
          const { muralId, ...updates } = schema.parse(args);
          if (Object.keys(updates).length === 0) {
            throw new Error('update-mural requires at least one field to update');
          }
          const mural = await muralClient.updateMural(muralId, updates);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ mural, message: `Updated mural ${muralId}` }, null, 2)
              }
            ],
          };
        }

        case 'delete-mural': {
          const schema = z.object({
            muralId: z.string().min(1)
          });
          const { muralId } = schema.parse(args);
          await muralClient.deleteMural(muralId);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ message: `Deleted mural ${muralId}` }, null, 2)
              }
            ],
          };
        }

        case 'duplicate-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
            roomId: z.number(),
            title: z.string().min(1),
            folderId: z.string().optional(),
            infinite: z.boolean().optional()
          });
          const { muralId, roomId, title, ...options } = schema.parse(args);
          const mural = await muralClient.duplicateMural(muralId, roomId, title, options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ mural, message: `Duplicated mural ${muralId} into room ${roomId}` }, null, 2)
              }
            ],
          };
        }

        case 'export-mural': {
          const schema = z.object({
            muralId: z.string().min(1),
            downloadFormat: z.string().min(1)
          });
          const { muralId, downloadFormat } = schema.parse(args);
          const result = await muralClient.exportMural(muralId, downloadFormat);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ export: result, message: `Exported mural ${muralId} as ${downloadFormat}` }, null, 2)
              }
            ],
          };
        }

        case 'get-board': {
          const schema = z.object({
            boardId: z.string().min(1)
          });

          const { boardId } = schema.parse(args);
          const board = await muralClient.getMural(boardId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(board, null, 2)
              }
            ],
          };
        }

        case 'check-user-scopes': {
          const scopes = await muralClient.getUserScopes();

          // Only try to get user info if we have identity:read scope
          let user = null;
          if (scopes.includes('identity:read')) {
            user = await muralClient.getCurrentUser().catch(() => null);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } : 'User info unavailable (requires identity:read scope)',
                  scopes,
                  scopeCount: scopes.length,
                  message: scopes.length === 0
                    ? 'No OAuth scopes available. Please re-authenticate or check your Mural app configuration.'
                    : `User has ${scopes.length} OAuth scope${scopes.length === 1 ? '' : 's'}`,
                  recommendations: {
                    'workspaces:read': scopes.includes('workspaces:read') ? 'Required for listing workspaces (✓ available)' : 'Required for listing workspaces (✗ missing)',
                    'rooms:read': scopes.includes('rooms:read') ? 'Required for listing rooms (✓ available)' : 'Required for listing rooms (✗ missing)',
                    'rooms:write': scopes.includes('rooms:write') ? 'Required for creating/modifying rooms (✓ available)' : 'Required for creating/modifying rooms (✗ missing)',
                    'murals:read': scopes.includes('murals:read') ? 'Required for reading boards/murals (✓ available)' : 'Required for reading boards/murals (✗ missing)',
                    'murals:write': scopes.includes('murals:write') ? 'Required for creating/modifying boards/murals (✓ available)' : 'Required for creating/modifying boards/murals (✗ missing)',
                    'templates:read': scopes.includes('templates:read') ? 'Required for reading templates (✓ available)' : 'Required for reading templates (✗ missing)',
                    'templates:write': scopes.includes('templates:write') ? 'Required for creating/modifying templates (✓ available)' : 'Required for creating/modifying templates (✗ missing)',
                    'identity:read': scopes.includes('identity:read') ? 'Required for user info (✓ available)' : 'Required for user info (✗ missing)'
                  },
                  nextSteps: scopes.length === 0
                    ? ['Run clear-auth tool', 'Update your Mural app to include all required scopes', 'Re-authenticate when prompted']
                    : (scopes.includes('murals:read') && scopes.includes('murals:write') && scopes.includes('workspaces:read') && scopes.includes('rooms:read') && scopes.includes('rooms:write') && scopes.includes('templates:read'))
                      ? ['You have comprehensive scopes for full workspace/room/board/template operations']
                      : ['Add missing scopes to your Mural app: workspaces:read, rooms:read, rooms:write, murals:read, murals:write, templates:read, templates:write, identity:read', 'Run clear-auth tool', 'Re-authenticate to get new scopes']
                }, null, 2)
              }
            ],
          };
        }

        // Content reading tools
        case 'get-mural-widgets': {
          const schema = z.object({
            muralId: z.string().min(1)
          });

          const { muralId } = schema.parse(args);
          const widgets = await muralClient.getMuralWidgets(muralId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  widgets,
                  count: widgets.length,
                  muralId,
                  message: widgets.length === 0
                    ? `No widgets found in mural ${muralId}`
                    : `Found ${widgets.length} widget${widgets.length === 1 ? '' : 's'} in mural`
                }, null, 2)
              }
            ],
          };
        }

        case 'get-mural-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            widgetId: z.string().min(1)
          });

          const { muralId, widgetId } = schema.parse(args);
          const widget = await muralClient.getMuralWidget(muralId, widgetId);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  widget,
                  muralId,
                  widgetId,
                  message: `Widget details retrieved successfully`
                }, null, 2)
              }
            ],
          };
        }

        // Widget creation tools
        case 'create-sticky-notes': {
          const schema = z.object({
            muralId: z.string().min(1),
            stickyNotes: z.array(z.object({
              x: z.number(),
              y: z.number(),
              text: z.string().min(1),
              width: z.number().optional(),
              height: z.number().optional(),
              style: z.object({
                backgroundColor: z.string().optional(),
                textColor: z.string().optional(),
                fontSize: z.number().optional()
              }).optional()
            })).min(1).max(1000)
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
              height: note.height || dimensions.height
            };
          });

          const createdWidgets = await muralClient.createStickyNotes(muralId, stickyNotesWithShape);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  widgets: createdWidgets,
                  count: createdWidgets.length,
                  muralId,
                  message: `Successfully created ${createdWidgets.length} sticky note${createdWidgets.length === 1 ? '' : 's'} in mural ${muralId}`
                }, null, 2)
              }
            ],
          };
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
              style: z.object({
                backgroundColor: z.string().optional(),
                textColor: z.string().optional(),
                fontSize: z.number().optional()
              }).optional()
            })
          });

          const { muralId, widgetId, updates } = schema.parse(args);
          const updatedWidget = await muralClient.updateStickyNote(muralId, widgetId, updates);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  widget: updatedWidget,
                  muralId,
                  widgetId,
                  message: `Successfully updated sticky note ${widgetId} in mural ${muralId}`
                }, null, 2)
              }
            ],
          };
        }

        case 'delete-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            widgetId: z.string().min(1)
          });
          const { muralId, widgetId } = schema.parse(args);
          await muralClient.deleteWidget(muralId, widgetId);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                muralId,
                widgetId,
                deleted: true,
                message: `Successfully deleted widget ${widgetId} from mural ${muralId}`
              }, null, 2)
            }]
          };
        }

        case 'create-shapes': {
          const schema = z.object({
            muralId: z.string().min(1),
            shapes: z.array(z.record(z.string(), z.unknown())).min(1)
          });
          const { muralId, shapes } = schema.parse(args);
          const createdWidgets = await muralClient.createShapes(muralId, shapes as Record<string, unknown>[]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widgets: createdWidgets,
                count: Array.isArray(createdWidgets) ? createdWidgets.length : 0,
                muralId,
                message: `Created ${Array.isArray(createdWidgets) ? createdWidgets.length : 0} shape widget(s)`
              }, null, 2)
            }]
          };
        }

        case 'create-arrows': {
          const schema = z.object({
            muralId: z.string().min(1),
            arrows: z.array(z.record(z.string(), z.unknown())).min(1)
          });
          const { muralId, arrows } = schema.parse(args);
          const createdWidgets = await muralClient.createArrows(muralId, arrows as Record<string, unknown>[]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widgets: createdWidgets,
                count: Array.isArray(createdWidgets) ? createdWidgets.length : 0,
                muralId,
                message: `Created ${Array.isArray(createdWidgets) ? createdWidgets.length : 0} arrow widget(s)`
              }, null, 2)
            }]
          };
        }

        case 'create-text-boxes': {
          const schema = z.object({
            muralId: z.string().min(1),
            textBoxes: z.array(z.record(z.string(), z.unknown())).min(1)
          });
          const { muralId, textBoxes } = schema.parse(args);
          const createdWidgets = await muralClient.createTextBoxes(muralId, textBoxes as Record<string, unknown>[]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widgets: createdWidgets,
                count: Array.isArray(createdWidgets) ? createdWidgets.length : 0,
                muralId,
                message: `Created ${Array.isArray(createdWidgets) ? createdWidgets.length : 0} text-box widget(s)`
              }, null, 2)
            }]
          };
        }

        case 'create-titles': {
          const schema = z.object({
            muralId: z.string().min(1),
            titles: z.array(z.record(z.string(), z.unknown())).min(1)
          });
          const { muralId, titles } = schema.parse(args);
          const createdWidgets = await muralClient.createTitles(muralId, titles as Record<string, unknown>[]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widgets: createdWidgets,
                count: Array.isArray(createdWidgets) ? createdWidgets.length : 0,
                muralId,
                message: `Created ${Array.isArray(createdWidgets) ? createdWidgets.length : 0} title widget(s)`
              }, null, 2)
            }]
          };
        }

        case 'create-areas': {
          const schema = z.object({
            muralId: z.string().min(1),
            areas: z.array(z.record(z.string(), z.unknown())).min(1)
          });
          const { muralId, areas } = schema.parse(args);
          const createdWidgets = await muralClient.createAreas(muralId, areas as Record<string, unknown>[]);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widgets: createdWidgets,
                count: Array.isArray(createdWidgets) ? createdWidgets.length : 0,
                muralId,
                message: `Created ${Array.isArray(createdWidgets) ? createdWidgets.length : 0} area widget(s)`
              }, null, 2)
            }]
          };
        }

        case 'update-widget': {
          const schema = z.object({
            muralId: z.string().min(1),
            kind: z.enum(['sticky-note', 'shape', 'arrow', 'text-box', 'title', 'area']),
            widgetId: z.string().min(1),
            updates: z.record(z.string(), z.unknown())
          });
          const { muralId, kind, widgetId, updates } = schema.parse(args);
          let updated: any;
          switch (kind) {
            case 'sticky-note': updated = await muralClient.updateStickyNote(muralId, widgetId, updates as any); break;
            case 'shape':       updated = await muralClient.updateShape(muralId, widgetId, updates); break;
            case 'arrow':       updated = await muralClient.updateArrow(muralId, widgetId, updates); break;
            case 'text-box':    updated = await muralClient.updateTextBox(muralId, widgetId, updates); break;
            case 'title':       updated = await muralClient.updateTitle(muralId, widgetId, updates); break;
            case 'area':        updated = await muralClient.updateArea(muralId, widgetId, updates); break;
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                widget: updated,
                muralId,
                widgetId,
                kind,
                message: `Updated ${kind} ${widgetId}`
              }, null, 2)
            }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: errorMessage,
              tool: name
            }, null, 2)
          }
        ],
        isError: true,
      };
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
main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});