import type { ToolDefinition } from './definitions.js';
import { muralTools } from './murals.js';
import { roomTools } from './rooms.js';
import { templateTools } from './templates.js';
import { utilityTools } from './utilities.js';
import { widgetTools } from './widgets.js';
import { workspaceTools } from './workspaces.js';

/** Every tool the server exposes, in the order tools/list returns them. */
export const toolDefinitions: ToolDefinition[] = [
  ...workspaceTools,
  ...roomTools,
  ...templateTools,
  ...muralTools,
  ...widgetTools,
  ...utilityTools,
];
