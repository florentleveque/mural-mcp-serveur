---
name: mural-preview
description: Connect this session's `mural-mcp-dev` MCP server to the current branch's Vercel preview, which Vercel Authentication protects. Use when `mural-mcp-dev` is missing from `.mcp.json` or points at another branch, fails to connect, asks to authenticate, or answers 401, and before any test on a PR's preview (`/run-validation-plan`, `/functional-testing`), even when the skill isn't named.
---

# Connect `mural-mcp-dev` to the branch preview

Previews are behind Vercel Authentication. Claude Code sends the `.mcp.json`
`headers` on MCP requests but **not** on its OAuth requests (discovery,
registration, token), so its own sign-in to a preview always ends in a Vercel
401. This skill replaces that sign-in for the preview only: the `mural-mcp-dev`
entry declares a `headersHelper` (`scripts/headers.mjs`) that hands Claude Code
the Vercel bypass header **and** a bearer token for the preview, and renews the
token itself. With an `Authorization` header from the helper, Claude Code skips
its OAuth flow. Production is public and needs none of this.

Run every command from the repository root. Never print the bypass secret or a
token.

## Steps

1. **Sync the declaration and the secret.**

   ```bash
   node .claude/skills/mural-preview/scripts/sync-mcp-json.mjs
   ```

   It asks the Vercel API (through the Vercel CLI session) for the latest ready
   preview of the current branch, and writes its stable address (the `-git-`
   alias) into the `mural-mcp-dev` entry of `.mcp.json`, with the
   `headersHelper`. When this machine has no bypass secret, it creates one in
   the project and stores it in `~/.config/mural-mcp-serveur/dev.env`
   (owner-only). It ends with one line on the sign-in state.
   - `now points at ...`: `.mcp.json` changed. Commit it on this branch.
   - `no ready Vercel preview`: the branch is not pushed or not deployed yet.
     Push, wait for the Vercel check, run it again.
   - `no valid Vercel CLI session`: the user runs `vercel login`. Only a member
     of the project's Vercel team can use this skill.
   `--check` reports the same lines without changing anything.

2. **Sign in, when step 1 ends with `sign-in: needed`.** Start it in the
   background: it waits up to 5 minutes for the browser.

   ```bash
   node .claude/skills/mural-preview/scripts/sign-in.mjs
   ```

   It registers a client, prints `Sign in at: <address>` and opens that address
   in the default browser. If the user drives a Chrome through CDP
   (`agent-browser`), pass `--no-open` and open the printed address there in a
   new tab. The pages are on the protected preview: the browser must be signed
   in to Vercel as a project member. The user signs in to Mural (or Mural
   redirects at once), then answers this server's consent page; granting access
   to their account is their decision, never click it for them. The script then
   stores the tokens in `~/.config/mural-mcp-serveur/preview-auth/<host>.json`
   (owner-only), checks `/mcp`, and prints `Signed in to ...`.

3. **Reconnect.** Ask the user to run `/mcp` and reconnect `mural-mcp-dev` (or
   start a new session). Confirm with `claude mcp get mural-mcp-dev`:
   `Connected`. From then on the helper renews the 10-minute token by itself, up
   to the grant's 90 days.

## When something fails

- `claude mcp get mural-mcp-dev` says `Needs authentication`: the helper sent no
  token. Run `headers.mjs` the way Claude Code does and read only its stderr:
  `CLAUDE_CODE_MCP_SERVER_URL=<url>/mcp node .claude/skills/mural-preview/scripts/headers.mjs >/dev/null`.
  `not signed in` or `token renewal failed`: run step 2 again.
- `Failed to connect`: the bypass secret is missing or revoked. Remove its line
  from `dev.env` if revoked, then run step 1.
- The helper runs only once the folder is trusted in Claude Code, and it never
  sees variables named `*SECRET*`, `*TOKEN*`, `*KEY*` or `*AUTH*`: it reads the
  secret from `dev.env`, not from the environment.
- `clear-auth` revokes the preview grant: run step 2 again afterwards.
