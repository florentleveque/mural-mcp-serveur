import { describe, expect, it, vi } from 'vitest';

import { widgetTools } from '../../../src/tools/widgets.js';
import { callTool, toolContext } from '../helpers.js';

const note = { id: 'n1', type: 'sticky note', x: 1, y: 2, text: 'Idea', rotation: 0 };
const compactNote = { id: 'n1', type: 'sticky note', x: 1, y: 2, text: 'Idea' };

function call(name: string, args: unknown, client: Record<string, unknown> = {}) {
  return callTool(widgetTools, name, args, toolContext(client));
}

describe('get-mural-widgets', () => {
  it('returns the compact view by default', async () => {
    const getMuralWidgets = vi.fn().mockResolvedValue([note]);

    const payload = await call('get-mural-widgets', { muralId: 'm1' }, { getMuralWidgets });

    expect(getMuralWidgets).toHaveBeenCalledWith('m1');
    expect(payload).toEqual({ widgets: [compactNote], count: 1, muralId: 'm1' });
  });

  it('returns raw widgets when verbose', async () => {
    const getMuralWidgets = vi.fn().mockResolvedValue([note]);

    const payload = await call(
      'get-mural-widgets',
      { muralId: 'm1', verbose: true },
      { getMuralWidgets },
    );

    expect(payload).toEqual({ widgets: [note], count: 1, muralId: 'm1' });
  });

  it.each([{}, { muralId: '' }, { muralId: 'm1', widgetId: 'n1' }])('rejects %o', async (args) => {
    await expect(call('get-mural-widgets', args)).rejects.toThrow();
  });
});

describe('get-mural-widget', () => {
  it('returns the compact view by default', async () => {
    const getMuralWidget = vi.fn().mockResolvedValue(note);

    const payload = await call(
      'get-mural-widget',
      { muralId: 'm1', widgetId: 'n1' },
      { getMuralWidget },
    );

    expect(getMuralWidget).toHaveBeenCalledWith('m1', 'n1');
    expect(payload).toEqual({ widget: compactNote, muralId: 'm1', widgetId: 'n1' });
  });

  it('returns the raw widget when verbose', async () => {
    const getMuralWidget = vi.fn().mockResolvedValue(note);

    const payload = await call(
      'get-mural-widget',
      { muralId: 'm1', widgetId: 'n1', verbose: true },
      { getMuralWidget },
    );

    expect(payload).toEqual({ widget: note, muralId: 'm1', widgetId: 'n1' });
  });

  it('rejects an empty widget id', async () => {
    await expect(call('get-mural-widget', { muralId: 'm1', widgetId: '' })).rejects.toThrow();
  });
});

describe('delete-widget', () => {
  it('deletes the widget and confirms it', async () => {
    const deleteWidget = vi.fn().mockResolvedValue(undefined);

    const payload = await call(
      'delete-widget',
      { muralId: 'm1', widgetId: 'n1' },
      { deleteWidget },
    );

    expect(deleteWidget).toHaveBeenCalledWith('m1', 'n1');
    expect(payload).toEqual({
      muralId: 'm1',
      widgetId: 'n1',
      deleted: true,
      message: 'Successfully deleted widget n1 from mural m1',
    });
  });
});

describe('create-sticky-notes', () => {
  async function sentNote(note: Record<string, unknown>) {
    const createStickyNotes = vi.fn().mockResolvedValue([note]);
    await call(
      'create-sticky-notes',
      { muralId: 'm1', stickyNotes: [note] },
      { createStickyNotes },
    );
    return createStickyNotes.mock.calls[0]?.[1][0];
  }

  it('adds the rectangle shape and sizes a short note to the minimum', async () => {
    const createStickyNotes = vi.fn().mockResolvedValue([note]);

    const payload = await call(
      'create-sticky-notes',
      { muralId: 'm1', stickyNotes: [{ x: 1, y: 2, text: 'Idea' }] },
      { createStickyNotes },
    );

    expect(createStickyNotes).toHaveBeenCalledWith('m1', [
      { x: 1, y: 2, text: 'Idea', shape: 'rectangle', width: 120, height: 60 },
    ]);
    expect(payload).toEqual({
      widgets: [compactNote],
      count: 1,
      muralId: 'm1',
      message: 'Successfully created 1 sticky note in mural m1',
    });
  });

  it('widens a note to fit one line of text', async () => {
    const sent = await sentNote({ x: 0, y: 0, text: 'lorem ipsum dolor sit amet consectetur' });

    expect(sent.width).toBeCloseTo(347.6);
    expect(sent.height).toBe(60);
  });

  it('wraps long text onto more lines and grows the note', async () => {
    const sent = await sentNote({ x: 0, y: 0, text: new Array(25).fill('word').join(' ') });

    expect(sent.width).toBeCloseTo(305.6);
    expect(sent.height).toBeCloseTo(78.8);
  });

  it('keeps a word that exactly fills the line on that line, at the style font size', async () => {
    // 20 characters (19 plus the space) of 19 px each fill the 380 px line.
    const fontSize = 380 / (0.6 * 20);
    const sent = await sentNote({ x: 0, y: 0, text: 'a'.repeat(19), style: { fontSize } });

    expect(sent.width).toBe(400);
    expect(sent.height).toBeCloseTo(fontSize * 1.4 + 20);
  });

  it('keeps the dimensions it is given', async () => {
    const sent = await sentNote({ x: 0, y: 0, text: 'Idea', width: 200, height: 150 });

    expect(sent).toMatchObject({ width: 200, height: 150 });
  });

  it('counts several created notes in the message', async () => {
    const createStickyNotes = vi.fn().mockResolvedValue([note, { ...note, id: 'n2' }]);

    const payload = await call(
      'create-sticky-notes',
      { muralId: 'm1', stickyNotes: [{ x: 0, y: 0, text: 'A' }] },
      { createStickyNotes },
    );

    expect(payload.message).toBe('Successfully created 2 sticky notes in mural m1');
  });

  it.each([
    { muralId: 'm1', stickyNotes: [] },
    { muralId: 'm1', stickyNotes: new Array(1001).fill({ x: 0, y: 0, text: 'A' }) },
    { muralId: 'm1', stickyNotes: [{ x: 0, y: 0, text: '' }] },
    { muralId: 'm1', stickyNotes: [{ x: 0, y: 0, text: 'A', shape: 'circle' }] },
    { muralId: 'm1', stickyNotes: [{ x: 0, y: 0, text: 'A', style: { color: 'red' } }] },
  ])('rejects $stickyNotes.length note(s) outside the schema', async (args) => {
    await expect(call('create-sticky-notes', args)).rejects.toThrow();
  });
});

describe('create-shapes, create-arrows, create-text-boxes, create-titles and create-areas', () => {
  const cases = [
    {
      tool: 'create-shapes',
      field: 'shapes',
      method: 'createShapes',
      kind: 'shape',
      item: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        shape: 'circle',
        style: { borderStyle: 'dashed' },
      },
    },
    {
      tool: 'create-arrows',
      field: 'arrows',
      method: 'createArrows',
      kind: 'arrow',
      item: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        label: { text: 'next' },
      },
    },
    {
      tool: 'create-text-boxes',
      field: 'textBoxes',
      method: 'createTextBoxes',
      kind: 'text-box',
      item: { x: 0, y: 0, width: 10, height: 10, text: 'Note', style: { textAlign: 'center' } },
    },
    {
      tool: 'create-titles',
      field: 'titles',
      method: 'createTitles',
      kind: 'title',
      item: { x: 0, y: 0, text: 'Heading' },
    },
    {
      tool: 'create-areas',
      field: 'areas',
      method: 'createAreas',
      kind: 'area',
      item: { x: 0, y: 0, width: 10, height: 10 },
    },
  ];

  it.each(cases)('$tool sends the items as given, extra fields included', async (c) => {
    const item = { ...c.item, zIndex: 3 };
    const create = vi.fn().mockResolvedValue([note]);

    const payload = await call(
      c.tool,
      { muralId: 'm1', [c.field]: [item] },
      { [c.method]: create },
    );

    expect(create).toHaveBeenCalledWith('m1', [item]);
    expect(payload).toEqual({
      widgets: [compactNote],
      count: 1,
      muralId: 'm1',
      message: `Created 1 ${c.kind} widget(s)`,
    });
  });

  it.each(cases)('$tool shows a non-array answer raw and counts nothing', async (c) => {
    const create = vi.fn().mockResolvedValue({ id: 'w9' });

    const payload = await call(
      c.tool,
      { muralId: 'm1', [c.field]: [c.item] },
      { [c.method]: create },
    );

    expect(payload).toEqual({
      widgets: { id: 'w9' },
      count: 0,
      muralId: 'm1',
      message: `Created 0 ${c.kind} widget(s)`,
    });
  });

  it.each([
    ['create-shapes', { shapes: [] }],
    ['create-shapes', { shapes: [{ x: 0, y: 0, width: 1, height: 1 }] }],
    ['create-shapes', { shapes: [{ x: 0, y: 0, width: 1, height: 1, shape: 'star' }] }],
    [
      'create-shapes',
      {
        shapes: [
          { x: 0, y: 0, width: 1, height: 1, shape: 'circle', style: { borderStyle: 'wavy' } },
        ],
      },
    ],
    ['create-arrows', { arrows: [{ x: 0, y: 0, width: 1, height: 1, points: [{ x: 0, y: 0 }] }] }],
    [
      'create-arrows',
      {
        arrows: [
          {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1, z: 1 },
            ],
          },
        ],
      },
    ],
    ['create-text-boxes', { textBoxes: [{ x: 0, y: 0, width: 1, height: 1 }] }],
    ['create-titles', { titles: [{ x: 0, y: 0 }] }],
    ['create-areas', { areas: [{ x: 0, y: 0, width: 1 }] }],
  ])('%s rejects %o', async (tool, args) => {
    await expect(call(tool, { muralId: 'm1', ...args })).rejects.toThrow();
  });
});

describe('update-widget', () => {
  it.each([
    ['sticky-note', 'updateStickyNote'],
    ['shape', 'updateShape'],
    ['arrow', 'updateArrow'],
    ['text-box', 'updateTextBox'],
    ['title', 'updateTitle'],
    ['area', 'updateArea'],
  ])('sends a %s update through %s', async (kind, method) => {
    const update = vi.fn().mockResolvedValue(note);
    const updates = { x: 5, anything: true };

    const payload = await call(
      'update-widget',
      { muralId: 'm1', kind, widgetId: 'n1', updates },
      { [method]: update },
    );

    expect(update).toHaveBeenCalledWith('m1', 'n1', updates);
    expect(payload).toEqual({
      widget: compactNote,
      muralId: 'm1',
      widgetId: 'n1',
      kind,
      message: `Updated ${kind} n1`,
    });
  });

  it('rejects an unknown kind', async () => {
    await expect(
      call('update-widget', { muralId: 'm1', kind: 'image', widgetId: 'n1', updates: {} }),
    ).rejects.toThrow();
  });
});

describe('update-sticky-note', () => {
  it('sends the updates and reports the widget', async () => {
    const updateStickyNote = vi.fn().mockResolvedValue(note);
    const updates = { text: 'Idea', style: { backgroundColor: '#FFF' } };

    const payload = await call(
      'update-sticky-note',
      { muralId: 'm1', widgetId: 'n1', updates },
      { updateStickyNote },
    );

    expect(updateStickyNote).toHaveBeenCalledWith('m1', 'n1', updates);
    expect(payload).toEqual({
      widget: compactNote,
      muralId: 'm1',
      widgetId: 'n1',
      message: 'Successfully updated sticky note n1 in mural m1',
    });
  });

  it.each([{ text: '' }, { shape: 'circle' }, { style: { color: 'red' } }])(
    'rejects the updates %o',
    async (updates) => {
      await expect(
        call('update-sticky-note', { muralId: 'm1', widgetId: 'n1', updates }),
      ).rejects.toThrow();
    },
  );
});
