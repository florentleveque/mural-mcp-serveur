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

The repository's `.mcp.json` declares one server, `mural-mcp-dev`: the stable
address of the branch preview, the bypass header
`x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}`, and a
`headersHelper`.

Claude Code sends the `.mcp.json` headers on MCP requests but not on its OAuth
requests (discovery, registration, token): its own sign-in to a preview ends in
a Vercel 401 at the client registration. The `mural-preview` skill
(`.claude/skills/mural-preview/`) works around it. It points `mural-mcp-dev` at
the current branch's preview, keeps a bypass secret in
`~/.config/mural-mcp-serveur/dev.env`, and signs in once through the browser;
its helper then hands Claude Code the bypass header and a bearer token it
renews by itself. The sign-in pages are on the protected preview too: the
browser must be signed in to Vercel as a member of the project. Only members of
the project's Vercel team can use it, and the Hobby plan has no team
collaboration. Run `/mural-preview`, or follow its `SKILL.md`.

## Locally, before the sign-in

```bash
pnpm dev:http     # builds, then serves on http://localhost:3000 (PORT overrides it)
pnpm test:smoke   # health, OAuth discovery and the 401 of /mcp, with dummy credentials
```

`pnpm dev:http` loads `.env` when present (see `.env.example`). The whole OAuth
flow, Mural included, is covered by the integration tests against a mocked
Mural (`tests/unit/http/app.test.ts`, `tests/unit/msw.ts`).
