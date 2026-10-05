// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
// Sets only the `version` of the committed server.json, so the release commit
// carries a one-line diff. Run by @semantic-release/exec with the release
// version; without one, package.json's (already bumped by then).
//
//   node scripts/sync-server-json-version.mjs [version]
import { readFileSync, writeFileSync } from 'node:fs';

const serverJsonUrl = new URL('../server.json', import.meta.url);
const version =
  process.argv[2] ??
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
if (!version) throw new Error('No version to sync: pass one, or set package.json#version.');

const serverJson = JSON.parse(readFileSync(serverJsonUrl, 'utf8'));
serverJson.version = version;
writeFileSync(serverJsonUrl, `${JSON.stringify(serverJson, null, 2)}\n`);
console.error(`server.json version set to ${version}`);
