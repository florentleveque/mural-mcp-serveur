import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import { projectWidgets, toCompactWidget } from '../projections.js';
import { defineTool, READ_ONLY, type ToolDefinition } from './definitions.js';

const muralId = z.string().min(1).describe('The unique identifier of the mural');
const widgetId = z.string().min(1).describe('The unique identifier of the widget');

export const widgetTools: ToolDefinition[] = [
  defineTool({
    name: 'get-mural-widgets',
    title: 'Get Mural Widgets',
    description:
      'Get all widgets from a mural. Compact view keeps: id, type, x, y, width, height, parentId plus per-type content (text, shape, backgroundColor, title, url, filename, points, ...). Pass verbose=true for the full raw widget objects (full style, rotation, authorship, flags, ...).',
    inputSchema: z.strictObject({
      muralId,
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, return the full raw widget objects instead of the compact view (optional, defaults to false)',
        ),
    }),
    annotations: READ_ONLY,
    handler: async ({ muralId, verbose }, { client }) => {
      const widgets = await client.getMuralWidgets(muralId);
      return jsonResult({
        widgets: verbose ? widgets : projectWidgets(widgets),
        count: widgets.length,
        muralId,
      });
    },
  }),
  defineTool({
    name: 'get-mural-widget',
    title: 'Get Mural Widget',
    description:
      'Get details of a specific widget by its ID (requires both the mural id and the widget id). Compact view keeps: id, type, x, y, width, height, parentId plus per-type content (text, shape, backgroundColor, title, url, filename, points, ...). Pass verbose=true for the full raw widget object (full style, rotation, authorship, flags, ...).',
    inputSchema: z.strictObject({
      muralId,
      widgetId,
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If true, return the full raw widget object instead of the compact view (optional, defaults to false)',
        ),
    }),
    annotations: READ_ONLY,
    handler: async ({ muralId, widgetId, verbose }, { client }) => {
      const widget = await client.getMuralWidget(muralId, widgetId);
      return jsonResult({
        widget: verbose ? widget : toCompactWidget(widget),
        muralId,
        widgetId,
      });
    },
  }),
];
