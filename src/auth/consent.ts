// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
/** Escape for HTML text and attribute context: every interpolated value is attacker-controllable. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface ConsentView {
  readonly uid: string;
  readonly clientName?: string | undefined;
  readonly clientId: string;
  readonly redirectUri: string;
}

const hostOf = (uri: string): string => (URL.canParse(uri) ? new URL(uri).host : uri);

/** What each Mural scope the server asks for (`MURAL_SCOPES`) lets a client do, in the user's terms. */
export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  'workspaces:read': 'See your workspaces',
  'rooms:read': 'See your rooms',
  'rooms:write': 'Create and change rooms',
  'murals:read': 'See your murals and their content',
  'murals:write': 'Create, change and delete murals and their content',
  'templates:read': 'See templates',
  'templates:write': 'Create and change templates',
  'identity:read': 'See your name and email address',
};

// Plain document structure, nothing visual carries meaning: one main landmark,
// one heading, a list, and buttons whose names say what they do out of context.
const page = (title: string, body: string): string =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    '<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}',
    'code{word-break:break-all}form{display:inline}button{font:inherit;padding:.5rem 1.25rem;margin:0 .5rem .5rem 0}</style>',
    `</head><body><main>${body}</main></body></html>`,
  ].join('');

/**
 * The MCP consent screen, shown to a client that is not trusted (DCR, unknown
 * CIMD, loopback redirects). Names the client, the Mural permissions and where
 * the code goes, per the MCP authorization spec's consent requirements.
 */
export const renderConsentPage = (view: ConsentView): string => {
  const name = escapeHtml(view.clientName ?? view.clientId);
  const permissions = Object.values(SCOPE_LABELS)
    .map((label) => `<li>${label}</li>`)
    .join('');
  const action = `/interaction/${encodeURIComponent(view.uid)}`;
  return page(
    `Allow ${name} to use your Mural account?`,
    [
      `<h1>Allow ${name} to use your Mural account?</h1>`,
      `<p>${name} is asking to act as you on Mural, with these permissions:</p>`,
      `<ul>${permissions}</ul>`,
      `<p>If you allow it, you are sent back to ${escapeHtml(hostOf(view.redirectUri))}`,
      ` (<code>${escapeHtml(view.redirectUri)}</code>). Only continue if you started this connection yourself.</p>`,
      `<p>Client id: <code>${escapeHtml(view.clientId)}</code></p>`,
      `<form method="post" action="${action}/confirm"><button type="submit">Allow ${name}</button></form>`,
      `<form method="post" action="${action}/abort"><button type="submit">Deny access</button></form>`,
    ].join(''),
  );
};

/** Plain error page for a failed sign-in. */
export const renderErrorPage = (title: string, detail: string): string =>
  page(escapeHtml(title), `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`);
