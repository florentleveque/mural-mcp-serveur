/** Operational events of the authorization server. */
export interface Logger {
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

// One JSON line per event, which Vercel's runtime logs keep searchable by field.
export const consoleLogger: Logger = {
  warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
};
