/**
 * LLM-facing projections.
 *
 * The Mural API returns large objects (long URLs, duplicated user references,
 * facilitation flags, layout indexes...). MCP tool responses are injected into
 * the model's context, so every field costs tokens. These helpers trim each
 * entity down to the fields a caller actually needs, while preserving the
 * content fields that vary per widget type.
 *
 * Inputs are typed `any` on purpose: the source is the raw API payload, which
 * may carry more fields than we model. Projections never throw on missing
 * fields — absent keys are simply omitted from the compact result.
 */

export interface CompactWorkspace {
  id: string;
  name: string;
}

export interface CompactRoom {
  id: number | string;
  name?: string;
  type?: string;
  workspaceId?: string;
}

export interface CompactBoard {
  id: string;
  title: string;
  status?: string;
  roomId?: number | string;
  workspaceId?: string;
  infinite?: boolean;
  updatedOn?: number;
  // The canvas link is the actionable URL to open the mural — kept on purpose.
  _canvasLink?: string;
}

export interface CompactTemplate {
  id: string;
  name?: string;
  description?: string;
  type?: string;
}

/** Compact widget: id/type/position plus the content fields of its kind. */
export interface CompactWidget {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  shape?: string;
  title?: string;
  url?: string;
  filename?: string;
  points?: unknown;
  startWidget?: string;
  endWidget?: string;
  rows?: number;
  columns?: number;
  data?: unknown;
  parentId?: string | null;
  backgroundColor?: string;
}

/** Spread a key into an object only when its value is defined. */
function opt<T>(key: string, value: T): Record<string, T> | Record<string, never> {
  return value === undefined || value === null ? {} : { [key]: value };
}

export function toCompactWorkspace(raw: any): CompactWorkspace {
  return { id: raw.id, name: raw.name };
}

export function toCompactRoom(raw: any): CompactRoom {
  return {
    id: raw.id,
    ...opt('name', raw.name),
    ...opt('type', raw.type),
    ...opt('workspaceId', raw.workspaceId),
  };
}

export function toCompactBoard(raw: any): CompactBoard {
  return {
    id: raw.id,
    title: raw.title,
    ...opt('status', raw.status),
    ...opt('roomId', raw.roomId),
    ...opt('workspaceId', raw.workspaceId),
    ...opt('infinite', raw.infinite),
    ...opt('updatedOn', raw.updatedOn),
    ...opt('_canvasLink', raw._canvasLink),
  };
}

export function toCompactTemplate(raw: any): CompactTemplate {
  return {
    id: raw.id,
    ...opt('name', raw.name),
    ...opt('description', raw.description),
    ...opt('type', raw.type),
  };
}

export function toCompactWidget(raw: any): CompactWidget {
  const base: CompactWidget = {
    id: raw.id,
    type: raw.type,
    x: raw.x,
    y: raw.y,
    ...opt('width', raw.width),
    ...opt('height', raw.height),
    ...opt('parentId', raw.parentId),
  };

  switch (raw.type) {
    case 'sticky note':
    case 'text box':
    case 'title':
      return {
        ...base,
        ...opt('text', raw.text),
        ...opt('shape', raw.shape),
        ...opt('backgroundColor', raw.style?.backgroundColor),
      };
    case 'shape':
      return {
        ...base,
        ...opt('shape', raw.shape),
        ...opt('text', raw.text),
        ...opt('backgroundColor', raw.style?.backgroundColor),
      };
    case 'area':
      return { ...base, ...opt('title', raw.title) };
    case 'image':
    case 'file':
      return { ...base, ...opt('url', raw.url), ...opt('filename', raw.filename) };
    case 'table':
      return { ...base, ...opt('rows', raw.rows), ...opt('columns', raw.columns), ...opt('data', raw.data) };
    case 'arrow':
      return {
        ...base,
        ...opt('points', raw.points),
        ...opt('startWidget', raw.startWidget),
        ...opt('endWidget', raw.endWidget),
      };
    default:
      return base;
  }
}

export function projectWorkspaces(items: any[]): CompactWorkspace[] {
  return items.map(toCompactWorkspace);
}

export function projectRooms(items: any[]): CompactRoom[] {
  return items.map(toCompactRoom);
}

export function projectBoards(items: any[]): CompactBoard[] {
  return items.map(toCompactBoard);
}

export function projectTemplates(items: any[]): CompactTemplate[] {
  return items.map(toCompactTemplate);
}

export function projectWidgets(items: any[]): CompactWidget[] {
  return items.map(toCompactWidget);
}
