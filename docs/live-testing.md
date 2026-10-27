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

Vercel shortens it when the part before `.vercel.app` passes 63 characters, so
take the exact address from the **Preview** link of the Vercel comment on the
PR. The address exists only once a push has deployed the branch. A sign-in works
only on an address registered as a redirect URL
(`<address>/oauth/callback`) in the Mural app.

## `.mcp.json`: the server's tools in a Claude Code session

The repository's `.mcp.json` declares one server, `mural-mcp-dev`, over HTTP to
`${MURAL_MCP_DEV_URL}/mcp`. `MURAL_MCP_DEV_URL` is the address of the instance
to test, without `/mcp`, and has no default: start Claude Code with it set,
either for one session, from the shell:

```bash
MURAL_MCP_DEV_URL=https://mural-mcp-serveur-git-<branch>-goku-ea72.vercel.app claude
```

or for every session in the repository, in the `env` key of your
`.claude/settings.local.json` (Claude Code applies it once you trust the
folder):

```json
{
  "env": {
    "MURAL_MCP_DEV_URL": "https://mural-mcp-serveur-git-<branch>-goku-ea72.vercel.app"
  }
}
```

That file is personal: never commit it. The repository's `.gitignore` does not
list it; Claude Code adds it to your global git excludes only when it writes the
file itself. The address stays there from one branch to the next: update it
when you switch.

- Without it, Claude Code reports `Missing environment variables` for
  `.mcp.json`, and `mural-mcp-dev` fails to connect.
- Claude Code reads it once, at start: to change the address, restart Claude
  Code.
- In the session, `printenv MURAL_MCP_DEV_URL` shows the address in use;
  `claude mcp get mural-mcp-dev` prints it unexpanded.
- A `mural-mcp-dev` you declared in your local scope takes precedence over
  `.mcp.json`, whatever the variable says: `claude mcp get mural-mcp-dev` must
  show `Scope: Project config`.
- Any instance of the server works: a branch preview of this project (the
  repository owner registers its redirect URL in the Mural app and exempts its
  address, below), production (`https://mural-mcp-serveur.vercel.app`), or
  your own deployment ([`docs/http-deployment.md`](http-deployment.md)).

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

Start Claude Code in the repository with `MURAL_MCP_DEV_URL` set, approve
`mural-mcp-dev` when asked (or list
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
