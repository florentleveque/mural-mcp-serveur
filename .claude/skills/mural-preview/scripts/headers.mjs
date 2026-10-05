// headersHelper of the mural-mcp-dev entry in .mcp.json. Claude Code's own OAuth
// requests cannot carry the Vercel bypass header, so this helper hands it the
// header and a bearer token for the preview, renewing the token itself. Claude
// Code runs it at each connection and again after a 401. See ../SKILL.md.
import { BYPASS_HEADER, currentAccessToken, readBypassSecret } from './lib.mjs';

const origin = new URL(process.env['CLAUDE_CODE_MCP_SERVER_URL'] ?? '').origin;
const secret = await readBypassSecret();
const headers = secret ? { [BYPASS_HEADER]: secret } : {};

try {
  const token = await currentAccessToken(origin, secret);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  else console.error('mural-preview: not signed in to this preview, run the mural-preview skill');
} catch (err) {
  console.error(`mural-preview: ${err.message}`);
}

process.stdout.write(JSON.stringify(headers));
