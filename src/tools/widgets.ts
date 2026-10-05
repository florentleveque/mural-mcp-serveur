import { z } from 'zod';

import { jsonResult } from '../mcp-format.js';
import type { MuralClient } from '../mural-client.js';
import { projectWidgets, toCompactWidget } from '../projections.js';
import { CREATES, defineTool, OVERWRITES, READ_ONLY, type ToolDefinition } from './definitions.js';

const muralId = z.string().min(1).describe('The unique identifier of the mural');
const widgetId = z.string().min(1).describe('The unique identifier of the widget');

const stickyNoteStyle = z.strictObject({
  backgroundColor: z.string().optional().describe('Background color'),
  textColor: z.string().optional().describe('Text color'),
  fontSize: z.number().optional().describe('Font size'),
});
const textAlign = z.enum(['left', 'center', 'right']).optional();
const lineStyle = z.enum(['solid', 'dashed', 'dotted']).optional();

const widgetKinds = ['sticky-note', 'shape', 'arrow', 'text-box', 'title', 'area'] as const;

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

// Mural answers a batch with an array, but `createWidgetsOfKind` passes any
// other body through: count only what was created, and show the rest raw.
function reportCreated(created: unknown, muralId: string, kind: string) {
  const count = Array.isArray(created) ? created.length : 0;
  return jsonResult({
    widgets: Array.isArray(created) ? projectWidgets(created) : created,
    count,
    muralId,
    message: `Created ${count} ${kind} widget(s)`,
  });
}

function updateWidgetOfKind(
  client: MuralClient,
  kind: (typeof widgetKinds)[number],
  muralId: string,
  widgetId: string,
  updates: Record<string, unknown>,
) {
  switch (kind) {
    case 'sticky-note':
      return client.updateStickyNote(muralId, widgetId, updates);
    case 'shape':
      return client.updateShape(muralId, widgetId, updates);
    case 'arrow':
      return client.updateArrow(muralId, widgetId, updates);
    case 'text-box':
      return client.updateTextBox(muralId, widgetId, updates);
    case 'title':
      return client.updateTitle(muralId, widgetId, updates);
    case 'area':
      return client.updateArea(muralId, widgetId, updates);
  }
}

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
  defineTool({
    name: 'delete-widget',
    title: 'Delete Widget',
    description: 'Permanently delete a widget from a mural by its ID (irreversible)',
    inputSchema: z.strictObject({
      muralId,
      widgetId: z.string().min(1).describe('The unique identifier of the widget to delete'),
    }),
    annotations: OVERWRITES,
    handler: async ({ muralId, widgetId }, { client }) => {
      await client.deleteWidget(muralId, widgetId);
      return jsonResult({
        muralId,
        widgetId,
        deleted: true,
        message: `Successfully deleted widget ${widgetId} from mural ${muralId}`,
      });
    },
  }),
  defineTool({
    name: 'create-sticky-notes',
    title: 'Create Sticky Notes',
    description: 'Create sticky notes on a mural (max 1000 per request)',
    inputSchema: z.strictObject({
      muralId,
      stickyNotes: z
        .array(
          z.strictObject({
            x: z.number().describe('X coordinate position'),
            y: z.number().describe('Y coordinate position'),
            text: z.string().min(1).describe('Text content of the sticky note'),
            width: z.number().optional().describe('Width in pixels (optional)'),
            height: z.number().optional().describe('Height in pixels (optional)'),
            style: stickyNoteStyle.optional().describe('Visual styling properties (optional)'),
          }),
        )
        .min(1)
        .max(1000)
        .describe('Array of sticky notes to create'),
    }),
    annotations: CREATES,
    handler: async ({ muralId, stickyNotes }, { client }) => {
      // Add required shape field and calculate dimensions for each sticky note
      const stickyNotesWithShape = stickyNotes.map((note) => {
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

      const createdWidgets = await client.createStickyNotes(muralId, stickyNotesWithShape);

      return jsonResult({
        widgets: projectWidgets(createdWidgets),
        count: createdWidgets.length,
        muralId,
        message: `Successfully created ${createdWidgets.length} sticky note${createdWidgets.length === 1 ? '' : 's'} in mural ${muralId}`,
      });
    },
  }),
  defineTool({
    name: 'create-shapes',
    title: 'Create Shapes',
    description:
      'Create shape widgets (rectangle, circle, triangle, diamond) on a mural. Each shape supports fill, border, and optional text.',
    inputSchema: z.strictObject({
      muralId,
      shapes: z
        .array(
          z.looseObject({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            shape: z
              .enum(['rectangle', 'circle', 'triangle', 'diamond'])
              .describe('Shape geometry'),
            text: z.string().optional().describe('Optional text content rendered inside the shape'),
            rotation: z.number().optional(),
            style: z
              .looseObject({
                backgroundColor: z.string().optional(),
                borderColor: z.string().optional(),
                borderWidth: z.number().optional(),
                borderStyle: lineStyle,
                fontColor: z.string().optional(),
                fontSize: z.number().optional(),
                fontFamily: z.string().optional(),
                bold: z.boolean().optional(),
                italic: z.boolean().optional(),
                textAlign,
              })
              .optional(),
          }),
        )
        .min(1)
        .describe('Array of shape widgets to create'),
    }),
    annotations: CREATES,
    handler: async ({ muralId, shapes }, { client }) =>
      reportCreated(await client.createShapes(muralId, shapes), muralId, 'shape'),
  }),
  defineTool({
    name: 'create-arrows',
    title: 'Create Arrows',
    description:
      'Create arrow (connector) widgets on a mural. Arrows can anchor to other widgets via startRefId/endRefId or use absolute start/end points in the points array.',
    inputSchema: z.strictObject({
      muralId,
      arrows: z
        .array(
          z.looseObject({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            points: z
              .array(z.strictObject({ x: z.number(), y: z.number() }))
              .min(2)
              .describe(
                'Two or more {x,y} points defining the arrow path. Coordinates are relative to x/y or absolute depending on Mural API version.',
              ),
            arrowType: z.enum(['straight', 'curved', 'orthogonal']).optional(),
            tip: z.enum(['no tip', 'single', 'double']).optional(),
            startRefId: z
              .string()
              .optional()
              .describe('Widget ID that the arrow starts at (anchors to widget)'),
            endRefId: z
              .string()
              .optional()
              .describe('Widget ID that the arrow ends at (anchors to widget)'),
            label: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Optional label attached to the arrow'),
            style: z
              .looseObject({
                color: z.string().optional(),
                width: z.number().optional(),
                arrowheadType: z.string().optional(),
                strokeStyle: lineStyle,
              })
              .optional(),
          }),
        )
        .min(1)
        .describe('Array of arrow widgets to create'),
    }),
    annotations: CREATES,
    handler: async ({ muralId, arrows }, { client }) =>
      reportCreated(await client.createArrows(muralId, arrows), muralId, 'arrow'),
  }),
  defineTool({
    name: 'create-text-boxes',
    title: 'Create Text Boxes',
    description:
      'Create text box widgets on a mural. Unlike sticky notes, text boxes support full font color, font size, and alignment.',
    inputSchema: z.strictObject({
      muralId,
      textBoxes: z
        .array(
          z.looseObject({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            text: z.string(),
            rotation: z.number().optional(),
            style: z
              .looseObject({
                backgroundColor: z.string().optional(),
                fontColor: z.string().optional(),
                fontSize: z.number().optional(),
                fontFamily: z.string().optional(),
                bold: z.boolean().optional(),
                italic: z.boolean().optional(),
                textAlign,
                border: z.boolean().optional(),
                borderColor: z.string().optional(),
                borderWidth: z.number().optional(),
              })
              .optional(),
          }),
        )
        .min(1),
    }),
    annotations: CREATES,
    handler: async ({ muralId, textBoxes }, { client }) =>
      reportCreated(await client.createTextBoxes(muralId, textBoxes), muralId, 'text-box'),
  }),
  defineTool({
    name: 'create-titles',
    title: 'Create Titles',
    description: 'Create title widgets (large heading text) on a mural.',
    inputSchema: z.strictObject({
      muralId,
      titles: z
        .array(
          z.looseObject({
            x: z.number(),
            y: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            text: z.string(),
            style: z
              .looseObject({
                fontColor: z.string().optional(),
                fontSize: z.number().optional(),
                fontFamily: z.string().optional(),
                bold: z.boolean().optional(),
                italic: z.boolean().optional(),
                textAlign,
              })
              .optional(),
          }),
        )
        .min(1),
    }),
    annotations: CREATES,
    handler: async ({ muralId, titles }, { client }) =>
      reportCreated(await client.createTitles(muralId, titles), muralId, 'title'),
  }),
  defineTool({
    name: 'create-areas',
    title: 'Create Areas',
    description: 'Create area widgets (grouping containers) on a mural.',
    inputSchema: z.strictObject({
      muralId,
      areas: z
        .array(
          z.looseObject({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            title: z.string().optional(),
            style: z
              .looseObject({
                backgroundColor: z.string().optional(),
                borderColor: z.string().optional(),
                borderWidth: z.number().optional(),
                fontColor: z.string().optional(),
                fontSize: z.number().optional(),
              })
              .optional(),
          }),
        )
        .min(1),
    }),
    annotations: CREATES,
    handler: async ({ muralId, areas }, { client }) =>
      reportCreated(await client.createAreas(muralId, areas), muralId, 'area'),
  }),
  defineTool({
    name: 'update-widget',
    title: 'Update Widget',
    description:
      'Update any widget by kind and ID (sticky-note, shape, arrow, text-box, title, area). Accepts arbitrary field updates.',
    inputSchema: z.strictObject({
      muralId,
      kind: z.enum(widgetKinds),
      widgetId,
      updates: z.record(z.string(), z.unknown()),
    }),
    annotations: OVERWRITES,
    handler: async ({ muralId, kind, widgetId, updates }, { client }) => {
      const updated = await updateWidgetOfKind(client, kind, muralId, widgetId, updates);
      return jsonResult({
        widget: toCompactWidget(updated),
        muralId,
        widgetId,
        kind,
        message: `Updated ${kind} ${widgetId}`,
      });
    },
  }),
  defineTool({
    name: 'update-sticky-note',
    title: 'Update Sticky Note',
    description: 'Update a sticky note widget in a mural',
    inputSchema: z.strictObject({
      muralId,
      widgetId: z
        .string()
        .min(1)
        .describe('The unique identifier of the sticky note widget to update'),
      updates: z
        .strictObject({
          x: z.number().optional().describe('X coordinate position'),
          y: z.number().optional().describe('Y coordinate position'),
          text: z.string().min(1).optional().describe('Text content of the sticky note'),
          width: z.number().optional().describe('Width in pixels'),
          height: z.number().optional().describe('Height in pixels'),
          style: stickyNoteStyle.optional().describe('Visual styling properties'),
        })
        .describe('The properties to update'),
    }),
    annotations: OVERWRITES,
    handler: async ({ muralId, widgetId, updates }, { client }) => {
      const updatedWidget = await client.updateStickyNote(muralId, widgetId, updates);
      return jsonResult({
        widget: toCompactWidget(updatedWidget),
        muralId,
        widgetId,
        message: `Successfully updated sticky note ${widgetId} in mural ${muralId}`,
      });
    },
  }),
];
