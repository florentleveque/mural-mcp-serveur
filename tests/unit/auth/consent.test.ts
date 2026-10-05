// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderConsentPage,
  renderErrorPage,
  SCOPE_LABELS,
} from '../../../src/auth/consent.js';
import { MURAL_SCOPES } from '../../../src/auth/mural-upstream.js';

describe('escapeHtml', () => {
  it('escapes every character that can open a tag or close an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderConsentPage', () => {
  const view = {
    uid: 'uid/1',
    clientName: 'Claude Code',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirectUri: 'http://127.0.0.1:53123/callback',
  };

  it('labels every Mural scope the server asks for, in order', () => {
    expect(Object.keys(SCOPE_LABELS)).toEqual(MURAL_SCOPES);
  });

  it('names the client, the permissions and the redirect target, as plain structure', () => {
    expect(renderConsentPage(view)).toMatchInlineSnapshot(
      `"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Allow Claude Code to use your Mural account?</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}form{display:inline}button{font:inherit;padding:.5rem 1.25rem;margin:0 .5rem .5rem 0}</style></head><body><main><h1>Allow Claude Code to use your Mural account?</h1><p>Claude Code is asking to act as you on Mural, with these permissions:</p><ul><li>See your workspaces</li><li>See your rooms</li><li>Create and change rooms</li><li>See your murals and their content</li><li>Create, change and delete murals and their content</li><li>See templates</li><li>Create and change templates</li><li>See your name and email address</li></ul><p>If you allow it, you are sent back to 127.0.0.1:53123 (<code>http://127.0.0.1:53123/callback</code>). Only continue if you started this connection yourself.</p><p>Client id: <code>https://claude.ai/oauth/claude-code-client-metadata</code></p><form method="post" action="/interaction/uid%2F1/confirm"><button type="submit">Allow Claude Code</button></form><form method="post" action="/interaction/uid%2F1/abort"><button type="submit">Deny access</button></form></main></body></html>"`,
    );
  });

  it('escapes a hostile client name and falls back to the client id', () => {
    const html = renderConsentPage({ ...view, clientName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('<title>Allow &lt;script&gt;alert(1)&lt;/script&gt; to use');
    const unnamed = renderConsentPage({ ...view, clientName: undefined });
    expect(unnamed).toContain(
      '<h1>Allow https://claude.ai/oauth/claude-code-client-metadata to use',
    );
  });

  it('escapes the redirect and client id, and shows an unparseable redirect as is', () => {
    const html = renderConsentPage({ ...view, clientId: 'a"b', redirectUri: '<weird>' });
    expect(html).toContain('sent back to &lt;weird&gt; (<code>&lt;weird&gt;</code>)');
    expect(html).toContain('Client id: <code>a&quot;b</code>');
  });
});

describe('renderErrorPage', () => {
  it('escapes both fields', () => {
    expect(renderErrorPage('Sign-in <failed>', 'a & b')).toMatchInlineSnapshot(
      `"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in &lt;failed&gt;</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}form{display:inline}button{font:inherit;padding:.5rem 1.25rem;margin:0 .5rem .5rem 0}</style></head><body><main><h1>Sign-in &lt;failed&gt;</h1><p>a &amp; b</p></main></body></html>"`,
    );
  });
});
