// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// server.json is the MCP Registry entry, version-controlled: a release only
// syncs its `version` (scripts/sync-server-json-version.mjs).
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const serverJson = read('server.json');

describe('server.json (the MCP Registry entry)', () => {
  it('pins the registry schema', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
  });

  it('is named in the GitHub namespace the release workflow authenticates for', () => {
    expect(serverJson.name).toBe('io.github.florentleveque/mural-mcp-serveur');
  });

  it('keeps its version with package.json', () => {
    expect(serverJson.version).toBe(pkg.version);
  });

  it('lists the hosted server only, over Streamable HTTP', () => {
    expect(serverJson.remotes).toEqual([
      { type: 'streamable-http', url: 'https://mural-mcp-serveur.vercel.app/mcp' },
    ]);
    expect(serverJson.packages).toBeUndefined();
  });

  it('points at the repository and its README', () => {
    expect(serverJson.repository).toEqual({
      url: 'https://github.com/florentleveque/mural-mcp-serveur',
      source: 'github',
      // The numeric id keeps the entry valid across a rename.
      id: '1253465642',
    });
    expect(serverJson.websiteUrl).toBe(pkg.homepage);
  });

  it('keeps the description within the registry limit', () => {
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
