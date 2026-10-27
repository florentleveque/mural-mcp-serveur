// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * release.yml pushes the `chore(release)` commit with a GitHub App token, and
 * an App's pushes do start workflow runs: only `[skip ci]` in the commit
 * message keeps each release from starting Release again. Nothing else would
 * catch its removal. Why the App: docs/release-automation.md.
 */
const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')) as {
  plugins: unknown[];
};

const pluginConfig = (name: string) =>
  rc.plugins.find(
    (p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === name,
  )?.[1];

describe('.releaserc.json', () => {
  it('keeps [skip ci] in the literal part of the release commit message', () => {
    const message = pluginConfig('@semantic-release/git')?.['message'];
    expect(typeof message).toBe('string');
    // Only the text before the notes is authored here; the notes vary per release.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal semantic-release placeholder.
    const literalPrefix = (message as string).split('${nextRelease.notes}')[0];
    expect(literalPrefix).toContain('[skip ci]');
  });

  it('commits the synced server.json with the release, once synced', () => {
    const names = rc.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(names.indexOf('@semantic-release/exec')).toBeGreaterThan(-1);
    expect(names.indexOf('@semantic-release/exec')).toBeLessThan(
      names.indexOf('@semantic-release/git'),
    );
    expect(pluginConfig('@semantic-release/git')?.['assets']).toEqual([
      'CHANGELOG.md',
      'package.json',
      'server.json',
    ]);
    expect(pluginConfig('@semantic-release/exec')?.['prepareCmd']).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal semantic-release placeholder.
      'node scripts/sync-server-json-version.mjs ${nextRelease.version}',
    );
  });

  it('never publishes to npm', () => {
    expect(pluginConfig('@semantic-release/npm')?.['npmPublish']).toBe(false);
  });
});
