# Deploying the server on Vercel

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

How to run your own instance. The design and its trade-offs are in
[`docs/decisions/oauth-authorization-server.md`](decisions/oauth-authorization-server.md).

## What gets deployed

`src/app.ts` exports an Express app as its default export, which Vercel's
Express preset deploys as one function. `vercel.json` sets the preset
(`"framework": "express"`) and the function region (`fra1`, Frankfurt). The
project uses Node 24 (`engines.node` is `24.x`).

Routes:

- `/mcp`: the MCP endpoint, behind this server's bearer tokens
- `/.well-known/oauth-protected-resource/mcp`: protected resource metadata
- `/.well-known/oauth-authorization-server`: authorization server metadata
- `/healthz`: a liveness check
- every other path: the authorization server (`/auth`, `/token`, `/reg`,
  `/jwks`, the sign-in pages, and `/oauth/callback` for Mural)

## 1. The Mural OAuth app

1. Sign in at [app.mural.co](https://app.mural.co) and open **Create and manage
   apps** (account menu), then **New app**.
2. Set the **Redirect URL** to `https://<your host>/oauth/callback`, one per
   address that must sign users in (the production domain, and the stable
   address of a preview branch if you test there). Mural compares it exactly.
3. Tick the scopes the tools use: `workspaces:read`, `rooms:read`,
   `rooms:write`, `murals:read`, `murals:write`, `templates:read`,
   `templates:write`, `identity:read`.
4. Copy the **Client ID** and **Client secret**. The secret is shown only once
   (**Reset** makes a new one).

A new app is **Private**: only its owner can sign in. To let other people in,
publish it as **Unlisted** from the app's sharing page: fill in the listing
(description, image, links) and generate the app link. Mural requires every
redirect URL to be HTTPS for that, and the step is **irreversible**: the app can
no longer go back to Private or be deleted. Each workspace admin then enables
the app from the link.

## 2. The Vercel project and its storage

1. Import the GitHub repository as a Vercel project. Production follows `main`;
   every other branch gets preview deployments.
2. Add **Upstash for Redis** from the Vercel Marketplace and connect it to the
   project. It provides `KV_REST_API_URL` and `KV_REST_API_TOKEN` (the server
   uses these two). One database can serve every environment: keys are
   prefixed with `VERCEL_ENV`.
3. Declare the environment variables below, as sensitive variables, for
   Production and Preview.

| Variable | Value |
| --- | --- |
| `MURAL_CLIENT_ID` | The Mural app's client ID |
| `MURAL_CLIENT_SECRET` | The Mural app's client secret |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`; a different one per environment |
| `PUBLIC_URL` | Optional: the public base URL, when it is not the Vercel one |

Without `PUBLIC_URL`, the issuer is `https://$VERCEL_PROJECT_PRODUCTION_URL` in
production and `https://$VERCEL_BRANCH_URL` on a preview: the address clients
are given, which must match the Mural redirect URL.

Never run `vercel link` or `vercel env pull` inside the repository: they write
`.vercel/` and `.env.local`, with the secrets in clear, into the working tree.

## 3. Check the deployment

```bash
curl -s https://<your host>/healthz
# {"status":"ok"}
curl -s https://<your host>/.well-known/oauth-protected-resource/mcp
# {"resource":"https://<your host>/mcp","authorization_servers":["https://<your host>"],...}
curl -s https://<your host>/.well-known/oauth-authorization-server
# issuer, registration_endpoint, client_id_metadata_document_supported: true, ...
```

`/mcp` without a token answers 401 with a `WWW-Authenticate` header that names
the protected resource metadata: that is what starts a client's sign-in.

`pnpm test:smoke` runs these checks against a local build, with dummy
credentials.

## Preview protection

Vercel protects preview deployments with Vercel Authentication. A browser
signed in to Vercel as a project member passes, an MCP client does not: Claude
Code does not send configured headers on its OAuth requests, so the
**Protection Bypass for Automation** header cannot get its sign-in through.
Exempt the branch address you test on instead, as
[`docs/live-testing.md`](live-testing.md) describes. Production must stay
public: check that `https://<your host>/healthz` answers without a Vercel
session.

## Rotating `TOKEN_ENCRYPTION_KEY`

Set the variable to `<new>,<old>` and redeploy: new tokens and records are
sealed with the new secret, and the old one still opens what it sealed. Drop
the old one once nothing sealed under it matters any more (Mural tokens are
kept up to 90 days). Removing it earlier, or losing the secret, signs every
user out; nothing else is lost.

## Consent and CORS

- claude.ai and ChatGPT skip this server's consent page on their own HTTPS
  redirect URIs (`src/auth/trusted-clients.ts`); every other client sees it.
- Browser origins allowed by CORS: the mainstream browser MCP clients and
  localhost (`src/http/cors.ts`).

## Limits to keep in mind

- Vercel Hobby is for non-commercial use.
- Upstash's free plan: 256 MB and 500,000 commands a month. Client
  registration (DCR) is open and registered clients do not expire.
