# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Manager

Use `pnpm` for all package management operations.

## Common Development Commands

### Building and Development

- `pnpm run build` - Compile TypeScript to JavaScript in `build/` directory
- `pnpm run dev` - Watch mode compilation with TypeScript
- `pnpm start` - Run the compiled MCP server
- `pnpm run prepublishOnly` - Pre-publish build step

### Testing and Debugging

- `pnpm test` - Run unit tests (Vitest, mocked HTTP/fs — no credentials needed)
- `pnpm test:watch` - Run unit tests in watch mode
- `pnpm test:coverage` - Run unit tests with coverage report
- Test the MCP server manually: `node build/index.js`
- Use MCP inspector: `npx @modelcontextprotocol/inspector node build/index.js`
- Test OAuth flow: Set environment variables and run `pnpm start`

## Architecture Overview

This is a Model Context Protocol (MCP) server that provides integration with the Mural visual collaboration platform through OAuth 2.0 authentication.

### Core Components

1. **MCP Server** (`src/index.ts`) - Main entry point that:
   - Uses stdio transport for MCP communication
   - Exposes ~30 tools spanning authentication/utilities, reads (workspaces, rooms, templates, boards, widgets) and writes (full CRUD on murals, async export + download, room/widget creation) — see "MCP Tools Available" below
   - Validates the required environment variables (`MURAL_CLIENT_ID`, `MURAL_CLIENT_SECRET`)
   - Uses Zod for input validation
   - Formats every tool response through `src/mcp-format.ts` (`jsonResult`/`jsonError`) and compacts read payloads through `src/projections.ts`

2. **OAuth Handler** (`src/oauth.ts`) - Manages authentication:
   - Implements OAuth 2.0 with PKCE (Proof Key for Code Exchange)
   - Stores tokens in `~/.mural-mcp-tokens.json`
   - Automatically refreshes expired tokens
   - Runs temporary HTTP server on port 3000 for OAuth callback

3. **Mural API Client** (`src/mural-client.ts`) - API interaction:
   - Makes authenticated requests to `https://app.mural.co/api/public/v1`
   - Handles token refresh automatically
   - Covers the full read/write surface (workspaces, rooms, templates, murals CRUD, widgets), paginating list endpoints via the API cursor
   - Throws a typed `MuralApiError` (carrying `status`, `errorCode`, `apiMessage`) instead of message-based errors, and derives 429 wait times from the `x-ratelimit-*-reset` headers

4. **Compact projections** (`src/projections.ts`) - Trims raw API objects down to the fields an LLM needs (`toCompact*`/`project*`), keeping responses small. Each read tool exposes a `verbose` flag to opt back into the full raw object.

5. **MCP response formatting** (`src/mcp-format.ts`) - `jsonResult`/`jsonError` build the MCP response envelope; `jsonError` surfaces `MuralApiError` fields (`status`, `errorCode`) in the error payload.

6. **TypeScript Types** (`src/types.ts`) - Type definitions for:
   - Mural API responses aligned with the real API shape (`MuralWorkspace`, `MuralRoom`, `MuralTemplate`, `MuralWidget`, ...)
   - OAuth flow data (`OAuthTokens`, `PKCEChallenge`, etc.)

### Environment Variables

Required:

- `MURAL_CLIENT_ID` - OAuth client ID from Mural Developer Portal
- `MURAL_CLIENT_SECRET` - OAuth client secret (Mural requires it for the token exchange)

Optional:

- `MURAL_REDIRECT_URI` - Defaults to `http://localhost:3000/callback`

### Authentication Flow

1. First run triggers OAuth browser authentication
2. Tokens stored locally in user's home directory
3. Automatic token refresh when expired
4. Manual token clearing available via `clear-auth` tool

### MCP Tools Available

See `README.md` for the full per-tool description. Grouped overview:

- **Auth & utilities**: `test-connection`, `clear-auth`, `check-user-scopes`, `get-rate-limit-status`, `debug-api-response`
- **Workspaces**: `list-workspaces`, `get-workspace`
- **Rooms**: `list-workspace-rooms`, `list-room-boards`, `create-room`
- **Templates**: `list-workspace-templates`, `create-mural-from-template`
- **Murals**: `list-workspace-boards`, `get-board`, `create-mural`, `update-mural`, `delete-mural`, `duplicate-mural`, `export-mural`, `get-export-status`, `download-export`
- **Widgets**: `get-mural-widgets`, `get-mural-widget`, `create-sticky-notes`, `update-sticky-note`, `create-shapes`, `create-arrows`, `create-text-boxes`, `create-titles`, `create-areas`, `update-widget`, `delete-widget`

Read tools return a compact projection by default (see `src/projections.ts`); pass `verbose: true` to get the full raw object.

### Development Notes

- Uses ES modules (`"type": "module"` in package.json)
- TypeScript compilation target: ES2022 with Node16 module resolution
- Executable shebang in compiled output (`chmod +x build/index.js`)
- Graceful shutdown handlers for SIGINT/SIGTERM
- Error responses include structured JSON with error details
