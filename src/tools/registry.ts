import type { ToolDefinition } from './definitions.js';
import { roomTools } from './rooms.js';
import { templateTools } from './templates.js';
import { workspaceTools } from './workspaces.js';

/** Every tool the server exposes, in the order tools/list returns them. */
export const toolDefinitions: ToolDefinition[] = [
  ...workspaceTools,
  ...roomTools,
  ...templateTools,
];
