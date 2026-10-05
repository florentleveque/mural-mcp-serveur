# Mural MCP Serveur

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A remote Model Context Protocol (MCP) server for the Mural visual collaboration
platform. It lets an AI assistant read and write your workspaces, rooms,
templates, murals and widgets, on your behalf.

The server is hosted: there is nothing to install and no secret on your
machine. Your MCP client connects to one URL and signs you in to Mural in your
browser.

```text
https://mural-mcp-serveur.vercel.app/mcp
```

## Features

- **Workspaces and rooms**: list workspaces and rooms (open rooms included), create rooms
- **Templates**: list or search a workspace's templates, create a mural from a template
- **Murals**: create (blank or from a template), read, update, archive, delete, duplicate, export and get the export's download URL
- **Widgets**: read, create and update sticky notes, shapes, arrows, text boxes, titles and areas; delete widgets
- **Pagination**: list tools follow the API cursor and return every item
- **Compact responses**: read tools return a trimmed projection of each object to save context; pass `verbose: true` for the full raw payload
- **OAuth sign-in**: the server is its own authorization server, with client registration (CIMD and DCR) and PKCE; Mural is the identity provider behind it

## Connect an MCP client

Any MCP client that supports remote servers over Streamable HTTP with OAuth can
connect. Give it the server URL; it registers itself and opens the sign-in page
in your browser.

Before the first connection, the Mural app of this server must be enabled in
your Mural workspace: see [Mural access](#mural-access-an-unlisted-app).

### Claude Code

```bash
claude mcp add --transport http --scope user mural https://mural-mcp-serveur.vercel.app/mcp
```

Then run `/mcp` in Claude Code, pick `mural` and sign in.

### Claude (web and desktop) and other clients

Add a custom connector (or remote MCP server) and paste
`https://mural-mcp-serveur.vercel.app/mcp` as its URL. No client ID or secret
is needed: the client registers itself.

### What the sign-in does

1. Your browser opens this server's sign-in page, which sends you to Mural.
2. You sign in to Mural and approve the scopes the tools need.
3. Unless your client is claude.ai or ChatGPT, this server asks you to confirm
   which application gets access. It remembers your answer for 90 days.
4. Your client receives its tokens and the tools appear.

The client's access token lasts 10 minutes and is renewed silently. A
connection lasts up to 90 days from sign-in, as long as Mural keeps accepting
it; then your client asks you to sign in again. The `clear-auth` tool signs the
connection out.

## Mural access: an Unlisted app

The server signs in to Mural through one Mural OAuth app, published as
**Unlisted**. Unlisted means:

- The app is not in Mural's public app directory. Only people who have its
  listing link can see it.
- A **workspace admin** must enable the app once in each workspace, from that
  link. Mural then lists it in the workspace settings, under Apps.
- In a workspace where the app is not enabled, Mural refuses the sign-in and
  the connection fails.

**Listing link:** _not published yet_ (placeholder: the Mural "App Link" goes
here once the app is published as Unlisted).

Not a workspace admin? Send the listing link to an admin of your workspace and
ask them to enable the app.

## Tools Available

**Authentication and utilities**

- `test-connection`: Test the connection to the Mural API and verify authentication
- `clear-auth`: Sign this connection out (revokes its tokens and the Mural tokens behind them; the client must sign in again)
- `check-user-scopes`: Show the Mural scopes granted to this connection, and those the tools miss
- `debug-api-response`: Raw workspaces API response (troubleshooting)

**Workspaces**

- `list-workspaces`: List all workspaces the authenticated user has access to
- `get-workspace`: Get detailed information about a specific workspace

**Rooms**

- `list-workspace-rooms`: List a workspace's rooms (option `openOnly`)
- `list-room-boards`: List the murals within a room
- `create-room`: Create a room (`open`/`private`)

**Templates**

- `list-workspace-templates`: List a workspace's templates (default and custom), or search them by name
- `create-mural-from-template`: Create a mural in a room from a template

**Murals**

- `list-workspace-boards`: List a workspace's murals
- `get-board`: Get details of a specific mural
- `create-mural`: Create a blank mural in a room
- `update-mural`: Update a mural (title, status `active`/`archived`, dimensions, sharing...)
- `delete-mural`: Permanently delete a mural (irreversible)
- `duplicate-mural`: Duplicate a mural into a room
- `export-mural`: Start an asynchronous export of a mural in a given format (returns an `exportId`)
- `download-export`: Get the signed download URL of an export (no authentication needed to fetch it); returns `ready:false` while the export is not ready, so call it again until ready

**Widgets**

- `get-mural-widgets`: Get all widgets of a mural (paginated)
- `get-mural-widget`: Get a specific widget by id
- `create-sticky-notes`: Create sticky notes (up to 1000 per request)
- `update-sticky-note`: Update a sticky note
- `create-shapes` / `create-arrows` / `create-text-boxes` / `create-titles` / `create-areas`: Create the corresponding widgets
- `update-widget`: Update any widget by kind and id
- `delete-widget`: Permanently delete a widget by id

> Write tools need the matching Mural scopes (`rooms:write`, `murals:write`,
> `templates:write`). The sign-in asks for all of them.

## Privacy and security

- The Mural client secret lives on the server only. MCP clients never see a
  Mural token: they get this server's own tokens, encrypted, bound to its
  `/mcp` endpoint and valid 10 minutes.
- Your Mural tokens are kept server-side, encrypted, in an Upstash Redis
  database in Frankfurt. The server functions also run in Frankfurt (Vercel
  region `fra1`).
- The server stores no mural content: each tool call goes to the Mural API
  with your own Mural token, and the answer goes back to your client.

Design and rationale:
[`docs/decisions/oauth-authorization-server.md`](docs/decisions/oauth-authorization-server.md).

## Troubleshooting

- **Mural refuses the sign-in**: the app is probably not enabled in your
  workspace. See [Mural access](#mural-access-an-unlisted-app).
- **"Sign in again" or HTTP 401**: the connection expired, was signed out with
  `clear-auth`, or Mural revoked it. Reconnect from your client (`/mcp` in
  Claude Code).
- **HTTP 403 on a write**: check the granted scopes with `check-user-scopes`.
  Mural's free plan also limits what you can create (for example 3 murals per
  workspace, open rooms only); its error message says so.

## Self-hosting and development

- Deploy your own instance on Vercel: [`docs/http-deployment.md`](docs/http-deployment.md).
- Try a branch on its preview deployment: [`docs/live-testing.md`](docs/live-testing.md).
- Contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## Inspired by

This project is inspired by [cogell/mural-mcp](https://github.com/cogell/mural-mcp).

## License

MIT License, see [LICENSE](LICENSE).
