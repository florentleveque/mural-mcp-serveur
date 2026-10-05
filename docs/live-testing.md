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

The repository's `.mcp.json` declares one server, `mural-mcp-dev`, over HTTP to
the branch address above followed by `/mcp`, written out in full: a new branch
changes it.

Vercel protects previews with Vercel Authentication, and Claude Code does not
send the `.mcp.json` headers on its OAuth requests (discovery, registration,
token): a protected preview cannot be signed in to, even with the Protection
Bypass for Automation header. The branch address is therefore exempt from the
protection, with a Deployment Protection Exception on that alias only;
per-deployment URLs stay protected. For a new branch, add the exception in the
project's Deployment Protection settings, or through
`PATCH /aliases/{id}/protection-bypass` with
`{"override": {"scope": "alias-protection-override", "action": "create"}}`
(`"revoke"` removes it).

Start Claude Code in the repository, approve `mural-mcp-dev` when asked (or list
it in `enabledMcpjsonServers` in your `.claude/settings.local.json`), run `/mcp`
and sign in.

## Locally, before the sign-in

```bash
pnpm dev:http     # builds, then serves on http://localhost:3000 (PORT overrides it)
pnpm test:smoke   # health, OAuth discovery and the 401 of /mcp, with dummy credentials
```

`pnpm dev:http` loads `.env` when present (see `.env.example`). The whole OAuth
flow, Mural included, is covered by the integration tests against a mocked
Mural (`tests/unit/http/app.test.ts`, `tests/unit/msw.ts`).
