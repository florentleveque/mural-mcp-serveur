# Live-testing a branch

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

Mural accepts only the HTTPS redirect URLs registered in its app, so a real
sign-in cannot happen on `localhost`. Real tests run on the branch's Vercel
preview deployment; local runs cover everything before the sign-in.

## The preview deployment

Every push to a branch deploys a preview. Besides the per-commit URL, Vercel
gives the branch a stable address:

```text
https://mural-mcp-serveur-git-<branch>-goku-ea72.vercel.app
```

For PR #18, that is
`https://mural-mcp-serveur-git-feature-remote-http-vercel-goku-ea72.vercel.app`.
The address exists only once a push has deployed the branch. A sign-in works
only on an address registered as a redirect URL
(`<address>/oauth/callback`) in the Mural app.

## `.mcp.json`: the preview's tools in a Claude Code session

The repository's `.mcp.json` declares one server, `mural-mcp-dev`, over HTTP
to `${MURAL_MCP_DEV_URL}/mcp`, with the header
`x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}`. Claude Code
expands both from the environment it starts in:

- `MURAL_MCP_DEV_URL`: the branch address above, without a trailing slash.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: the project's **Protection Bypass for
  Automation** secret (Vercel project settings, Deployment Protection). Keep it
  out of the repository and of any output.

Export them in the shell that launches Claude Code (for example from a file
your shell profile sources, readable only by you), then start Claude Code in
the repository. Approve `mural-mcp-dev` when asked (or list it in
`enabledMcpjsonServers` in your `.claude/settings.local.json`), run `/mcp` and
sign in. The sign-in pages are on the protected preview too: the browser must
be signed in to Vercel as a member of the project.

Not verified yet: whether Claude Code sends the `.mcp.json` headers on its
OAuth requests (discovery, registration, token), and not only on MCP requests.
If the sign-in fails on one of those with a Vercel 401, that is the cause.

## Locally, before the sign-in

```bash
pnpm dev:http     # builds, then serves on http://localhost:3000 (PORT overrides it)
pnpm test:smoke   # health, OAuth discovery and the 401 of /mcp, with dummy credentials
```

`pnpm dev:http` loads `.env` when present (see `.env.example`). The whole OAuth
flow, Mural included, is covered by the integration tests against a mocked
Mural (`tests/unit/http/app.test.ts`, `tests/unit/msw.ts`).
