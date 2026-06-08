import { describe, expect, it } from 'vitest';

import { projectBoards, projectWidgets, toCompactBoard, toCompactRoom, toCompactTemplate, toCompactWidget, toCompactWorkspace } from '../../src/projections.js';

describe('projections', () => {
  describe('toCompactWorkspace', () => {
    it('keeps only id and name', () => {
      const raw = { id: 'ws1', name: 'Workspace', description: 'x', image: 'http://img', locked: false, suspended: false, createdOn: 1, sharingSettings: {} };
      expect(toCompactWorkspace(raw)).toEqual({ id: 'ws1', name: 'Workspace' });
    });
  });

  describe('toCompactRoom', () => {
    it('keeps id/name/type/workspaceId and drops user refs and timestamps', () => {
      const raw = {
        id: 42,
        name: 'Room',
        type: 'open',
        workspaceId: 'ws1',
        favorite: true,
        description: '',
        createdBy: { id: 'u1', firstName: 'A', lastName: 'B' },
        updatedBy: { id: 'u1' },
        createdOn: 1,
        updatedOn: 2,
      };
      expect(toCompactRoom(raw)).toEqual({ id: 42, name: 'Room', type: 'open', workspaceId: 'ws1' });
    });

    it('omits absent optional fields', () => {
      expect(toCompactRoom({ id: 7 })).toEqual({ id: 7 });
    });
  });

  describe('toCompactBoard', () => {
    it('keeps the canvas link but drops thumbnail, sharing links, state and user refs', () => {
      const raw = {
        id: 'ws.1',
        title: 'Retro',
        status: 'active',
        roomId: 99,
        workspaceId: 'ws',
        infinite: true,
        updatedOn: 1780826862868,
        _canvasLink: 'https://app.mural.co/a/canvas',
        thumbnailUrl: 'https://blob/thumb.png',
        state: 'abc123',
        sharingSettings: { link: 'https://invite' },
        visitorsSettings: { link: 'https://visit', visitors: 'none' },
        createdBy: { id: 'u1', firstName: 'A', lastName: 'B' },
        favorite: false,
      };
      expect(toCompactBoard(raw)).toEqual({
        id: 'ws.1',
        title: 'Retro',
        status: 'active',
        roomId: 99,
        workspaceId: 'ws',
        infinite: true,
        updatedOn: 1780826862868,
        _canvasLink: 'https://app.mural.co/a/canvas',
      });
    });

    it('projects a list of boards', () => {
      const result = projectBoards([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B', state: 'x' },
      ]);
      expect(result).toEqual([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]);
    });
  });

  describe('toCompactTemplate', () => {
    it('keeps id/name/description/type and drops urls and authorship', () => {
      const raw = {
        id: 't1',
        name: 'Profile',
        description: 'desc',
        type: 'default',
        createdBy: 'MURAL',
        updatedBy: 'MURAL',
        createdOn: 1,
        updatedOn: 2,
        thumbUrl: 'https://thumb',
        viewLink: 'https://view',
        workspaceId: 'ws',
      };
      expect(toCompactTemplate(raw)).toEqual({ id: 't1', name: 'Profile', description: 'desc', type: 'default' });
    });
  });

  describe('toCompactWidget', () => {
    it('projects a sticky note with text, shape and background color, dropping metadata', () => {
      const raw = {
        id: 'w1',
        type: 'sticky note',
        x: 10,
        y: 20,
        width: 230,
        height: 138,
        shape: 'rectangle',
        text: 'Hello',
        parentId: null,
        rotation: 0,
        stackingOrder: 2826,
        hidden: false,
        viewLink: 'https://app.mural.co/widget',
        createdBy: { alias: 'Visiting Horse', id: 'u1' },
        updatedBy: { id: 'u2' },
        style: { backgroundColor: '#B5D0F6FF', bold: false, font: 'proxima-nova', fontSize: 23 },
      };
      expect(toCompactWidget(raw)).toEqual({
        id: 'w1',
        type: 'sticky note',
        x: 10,
        y: 20,
        width: 230,
        height: 138,
        text: 'Hello',
        shape: 'rectangle',
        backgroundColor: '#B5D0F6FF',
      });
    });

    it('keeps the text of a "text" widget (API uses type "text", not "text box")', () => {
      const raw = { id: 'wt', type: 'text', x: 0, y: 0, width: 100, text: '<div><b>Titre</b></div>', style: { fontSize: 77 } };
      expect(toCompactWidget(raw)).toEqual({ id: 'wt', type: 'text', x: 0, y: 0, width: 100, text: '<div><b>Titre</b></div>' });
    });

    it('keeps shape-specific fields', () => {
      const raw = { id: 'w2', type: 'shape', x: 1, y: 2, shape: 'circle', text: 'inside', style: { backgroundColor: '#fff' } };
      expect(toCompactWidget(raw)).toEqual({ id: 'w2', type: 'shape', x: 1, y: 2, shape: 'circle', text: 'inside', backgroundColor: '#fff' });
    });

    it('keeps arrow anchors and points', () => {
      const raw = { id: 'w3', type: 'arrow', x: 0, y: 0, points: [{ x: 1, y: 1 }], startWidget: 'a', endWidget: 'b', style: {} };
      expect(toCompactWidget(raw)).toEqual({ id: 'w3', type: 'arrow', x: 0, y: 0, points: [{ x: 1, y: 1 }], startWidget: 'a', endWidget: 'b' });
    });

    it('keeps the area title', () => {
      const raw = { id: 'w4', type: 'area', x: 0, y: 0, title: 'Zone', width: 100 };
      expect(toCompactWidget(raw)).toEqual({ id: 'w4', type: 'area', x: 0, y: 0, width: 100, title: 'Zone' });
    });

    it('keeps url/filename for image and file widgets', () => {
      expect(toCompactWidget({ id: 'w5', type: 'image', x: 0, y: 0, url: 'http://img', filename: 'a.png' })).toEqual({
        id: 'w5',
        type: 'image',
        x: 0,
        y: 0,
        url: 'http://img',
        filename: 'a.png',
      });
    });

    it('preserves text/title of unknown widget types but drops unmodeled fields', () => {
      const raw = { id: 'w6', type: 'comment', x: 5, y: 6, foo: 'bar', text: 'a comment', title: 'label' };
      expect(toCompactWidget(raw)).toEqual({ id: 'w6', type: 'comment', x: 5, y: 6, text: 'a comment', title: 'label' });
    });

    it('keeps the icon untouched of content it does not carry (fallback, no text/title)', () => {
      const raw = { id: 'ic', type: 'icon', x: 1, y: 2, width: 104, height: 104, name: '321658', title: '', style: { color: '#000' } };
      expect(toCompactWidget(raw)).toEqual({ id: 'ic', type: 'icon', x: 1, y: 2, width: 104, height: 104 });
    });

    it('projects a list of widgets', () => {
      const result = projectWidgets([
        { id: 'a', type: 'sticky note', x: 0, y: 0, text: 'A' },
        { id: 'b', type: 'title', x: 1, y: 1, text: 'B' },
      ]);
      expect(result).toEqual([
        { id: 'a', type: 'sticky note', x: 0, y: 0, text: 'A' },
        { id: 'b', type: 'title', x: 1, y: 1, text: 'B' },
      ]);
    });
  });
});
