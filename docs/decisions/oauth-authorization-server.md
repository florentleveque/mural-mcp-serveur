# Remote OAuth: a hosted server that is its own authorization server

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

> **Build documentation, not user documentation.** This records why the server
> moved from a local stdio process to a hosted HTTP server that runs its own
> OAuth authorization server. Deployment steps belong in
> [`docs/http-deployment.md`](../http-deployment.md).

| | |
| --- | --- |
| **Status** | Decided and applied ([#18](https://github.com/florentleveque/mural-mcp-serveur/pull/18)) |
| **Date** | 2026-10-05 |
| **Applies** | [#17](https://github.com/florentleveque/mural-mcp-serveur/issues/17), as a major release |
| **Question** | How do users sign in to Mural without a Mural client secret on their machines? |
| **Answer** | One hosted server on Vercel holds the secret. It is the OAuth authorization server (AS) of its MCP clients, built on [`oidc-provider`](https://github.com/panva/node-oidc-provider), with Mural as the upstream identity provider. It issues its own tokens and keeps the Mural ones server-side, encrypted, in Upstash Redis. |

## Why the stdio design could not stay

- **Mural requires the client secret to refresh.** Tested live on 2026-10-04:
  Mural exchanges an authorization code with PKCE and no secret, but answers
  `invalid_client` to a refresh without it. Its access tokens last 900 s, so a
  public client would sign the user in again every 15 minutes.
- **The secret cannot be shared with every user.** A local server needs it in
  each user's configuration, in clear text. The OS keychain fallback was
  rejected: its support differs across Windows, WSL, Linux and macOS.

## Options considered

| Option | Outcome |
| --- | --- |
| Public PKCE client, no secret | Rejected: the refresh fails (above). |
| Local server, secret in the OS keychain | Rejected: uneven support, and the secret still sits on every machine. |
| Cloudflare Workers with `workers-oauth-provider` | Fits the free CPU budget (measured), but the server would have to move to the Workers runtime. |
| Vercel functions, Node, with `oidc-provider` | **Chosen.** The code stays Node and Express; storage comes from the Vercel Marketplace (Upstash Redis). |
| SDK v1 `mcpAuthRouter` | Rejected: SDK v2 moved it to `@modelcontextprotocol/server-legacy`, a deprecated frozen copy. |

The MCP side uses SDK v2 (`@modelcontextprotocol/server`), whose
`createMcpHandler` builds one server per HTTP request: no session state, which
suits functions that freeze between requests.

## The design

### Tokens

- Our access token is a JWE (`dir`, `A256GCM`) bound to the `/mcp` resource.
  It carries the Mural access token (`mt`), our grant id (`gid`) and the scopes
  Mural granted (`ms`). Nothing is looked up to serve a tool call.
- It lives 600 s and is minted only from a Mural token with at least 660 s
  left (600 s plus a 60 s margin), so it always dies before the Mural token it
  carries. Below that, the Mural token is refreshed first.
- A Mural refresh runs under a per-grant Redis lock: Mural may rotate its
  refresh token, and two instances must not spend the same one.
- Our refresh tokens rotate on every use; a replayed one revokes the grant. A
  grant lasts 90 days from sign-in.

### Upstream login

Every authorization signs in to Mural again, even with a live browser session,
so each grant gets its own Mural tokens. The account is `mural:<id>`, from
Mural's `/users/me` (Mural is not OIDC). Mural reports the granted scopes on its
callback (`scopes`), not in its token answer; they are stored with the tokens.

### Client registration

- **CIMD** (Client ID Metadata Documents) is what claude.ai, Claude Code and
  ChatGPT use. It is experimental in `oidc-provider` 9 (`ack: 'draft-02'`),
  hence the minor version pinned with `~`.
- **DCR** (Dynamic Client Registration) stays open to any client, without a
  lifetime or a limit on registered clients. Accepted risk for a small
  deployment: a flood of registrations could fill the free Redis database.

### Consent

claude.ai and ChatGPT, on their own HTTPS redirect URIs, skip our consent page.
Every other client sees it once per account, client and set of redirect URIs,
remembered 90 days. The page is plain HTML, usable with a screen reader.

### Storage

Every `oidc-provider` model (clients, codes, sessions, interactions, grants,
refresh tokens) and every piece of state between two browser hops lives in
Upstash Redis: the next request may reach another instance. Records are sealed
(JWE, `A256GCM`) and their keys hashed; one-time records are consumed
atomically. Keys are prefixed with `VERCEL_ENV`, so production, previews and
local runs share one database without seeing each other's records.

### Keys and secrets

One secret, `TOKEN_ENCRYPTION_KEY`, yields every key by HKDF (info
`mural-mcp/<purpose>/v1`): the token encryption key, the at-rest sealing key,
the Ed25519 signing key and the cookie key. A comma-separated list rotates it:
the first entry seals, the others still open what they sealed. Losing it signs
everyone out, nothing more.

### Revocation

`clear-auth`, a refresh-token replay, the revocation endpoint and a Mural 401
on a tool call all end the grant: its refresh tokens and Mural tokens are
deleted, and its access tokens are refused until they would have expired.

## Costs accepted

- **Vercel Hobby** is for non-commercial use.
- **Upstash free plan** quotas (256 MB, 500,000 commands a month).
- **One Mural app, Unlisted, irreversibly**: Mural accepts only HTTPS redirect
  URLs for a shared app, and once its listing link is generated the app can no
  longer go back to private or be deleted. Each workspace admin enables it.
- **No real sign-in locally**: the redirect URL must be HTTPS and registered at
  Mural, so real tests run on a preview deployment (one registered branch
  address).
- **npm publishing ends**: the package is deprecated; the MCP Registry lists
  the remote server instead.

## What would reverse this

Mural accepting a refresh without the client secret (a real public client)
would make a local, secretless server possible again.
