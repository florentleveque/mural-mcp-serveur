import { z } from 'zod';

// Schema fields several tools share, so one wording reaches every tool.

export const verboseList = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'If true, return the full raw objects instead of the compact view (optional, defaults to false)',
  );

export const verboseItem = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'If true, return the full raw object instead of the compact view (optional, defaults to false)',
  );

export const workspaceId = z.string().min(1).describe('The unique identifier of the workspace');
