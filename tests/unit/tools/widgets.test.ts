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
