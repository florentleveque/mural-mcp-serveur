# Mural MCP Serveur

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) server that provides integration with the Mural visual collaboration platform. This server enables AI assistants to interact with Mural workspaces through OAuth 2.0 authentication.

> Broad read/write access to the Mural public API — workspaces, rooms, templates, murals (full CRUD) and widgets — over OAuth 2.0 with PKCE.

## Features

- **OAuth 2.0 Authentication**: Secure authentication with PKCE support
- **Workspaces & Rooms**: list workspaces and rooms (incl. open rooms), create rooms
- **Templates**: list/search a workspace's templates, create a mural from a template
- **Murals**: full CRUD — create (blank or from template), read, update, delete, duplicate, export
- **Widgets**: read, create and update sticky notes, shapes, arrows, text boxes, titles and areas; delete widgets
- **Pagination**: list endpoints follow the API cursor to return all items
- **MCP Compliance**: Full Model Context Protocol compatibility
- **Token Management**: Automatic token refresh and secure storage

## Tools Available

**Authentication & utilities**
- `test-connection`: Test the connection to Mural API and verify authentication
- `clear-auth`: Clear stored authentication tokens (forces re-authentication)
- `check-user-scopes`: Show the current token's OAuth scopes
- `get-rate-limit-status`: Current rate-limiting status
- `debug-api-response`: Raw workspaces API response (troubleshooting)

**Workspaces**
- `list-workspaces`: List all workspaces the authenticated user has access to
- `get-workspace`: Get detailed information about a specific workspace

**Rooms**
- `list-workspace-rooms`: List a workspace's rooms (option `openOnly`)
- `list-room-boards`: List the murals within a room
- `create-room`: Create a room (`open`/`private`)

**Templates**
- `list-workspace-templates`: List a workspace's templates (default + custom), or search by name
- `create-mural-from-template`: Create a mural in a room from a template

**Murals**
- `list-workspace-boards`: List a workspace's murals
- `get-board`: Get details of a specific mural
- `create-mural`: Create a blank mural in a room
- `update-mural`: Update a mural (title, status `active`/`archived`, dimensions, sharing…)
- `delete-mural`: Permanently delete a mural (irreversible)
- `duplicate-mural`: Duplicate a mural into a room
- `export-mural`: Export a mural in a given format

**Widgets**
- `get-mural-widgets`: Get all widgets of a mural (paginated)
- `get-mural-widget`: Get a specific widget by id
- `create-sticky-notes`: Create sticky notes (up to 1000 per request)
- `update-sticky-note`: Update a sticky note
- `create-shapes` / `create-arrows` / `create-text-boxes` / `create-titles` / `create-areas`: Create the corresponding widgets
- `update-widget`: Update any widget by kind and id
- `delete-widget`: Permanently delete a widget by id

> Write operations require the matching OAuth scopes (`rooms:write`, `murals:write`, `templates:write`).

## Prerequisites

1. **Node.js**: Version 18 or higher
2. **Mural Account**: Access to Mural with workspace permissions
3. **Mural OAuth App**: Register an app at [Mural Developer Portal](https://app.mural.co/developer)

## Installation

### Option 1: Install from npm (Recommended)

```bash
npm install -g @florentleveque/mural-mcp-serveur
# or
pnpm add -g @florentleveque/mural-mcp-serveur
```

### Option 2: Install from source

1. Clone and install dependencies:
```bash
git clone https://github.com/florentleveque/mural-mcp-serveur.git
cd mural-mcp-serveur
pnpm install
```

2. Build the project:
```bash
pnpm run build
```

## Setup

1. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your Mural OAuth credentials
```

## Configuration

### Environment Variables

Create a `.env` file with the following variables:

```bash
# Required: Your Mural app's client ID
MURAL_CLIENT_ID=your_client_id_here

# Optional: Your Mural app's client secret (recommended)
MURAL_CLIENT_SECRET=your_client_secret_here

# Optional: OAuth redirect URI (defaults to http://localhost:3000/callback)
MURAL_REDIRECT_URI=http://localhost:3000/callback
```

### Mural OAuth App Setup

1. Visit [Mural Developer Portal](https://app.mural.co/developer)
2. Create a new application
3. Set the redirect URI to `http://localhost:3000/callback` (or your custom URI)
4. Note your Client ID and Client Secret
5. Configure the required scopes: `workspaces:read`, `rooms:read`, `rooms:write`, `murals:read`, `murals:write`, `templates:read`, `templates:write`, `identity:read` (the 8 scopes the server requests)

## Usage

### With Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mural": {
      "command": "node",
      "args": ["/absolute/path/to/mural-mcp-serveur/build/index.js"],
      "env": {
        "MURAL_CLIENT_ID": "your_client_id_here",
        "MURAL_CLIENT_SECRET": "your_client_secret_here"
      }
    }
  }
}
```

### Standalone Usage

Run the server directly:

```bash
# Set environment variables
export MURAL_CLIENT_ID=your_client_id_here
export MURAL_CLIENT_SECRET=your_client_secret_here

# Start the server
pnpm start
```

### Development

For development with hot reloading:

```bash
pnpm run dev
```

## Authentication Flow

1. **First Run**: The server will open a browser window for OAuth authentication
2. **Login**: Complete the OAuth flow in your browser
3. **Token Storage**: Tokens are securely stored locally in `~/.mural-mcp-tokens.json`
4. **Auto-Refresh**: Access tokens are automatically refreshed when needed

## API Endpoints Used

- **Authorization**: `https://app.mural.co/api/public/v1/authorization/oauth2/`
- **Token Exchange**: `https://app.mural.co/api/public/v1/authorization/oauth2/token`
- **Workspaces**: `https://app.mural.co/api/public/v1/workspaces`

## Example Usage

Once configured, you can use the tools through your MCP client:

```
Human: List my Mural workspaces
Assistant: I'll list your Mural workspaces using the list-workspaces tool.

[Tool executes and returns workspace data]
```

## Security Considerations

- **PKCE**: Uses Proof Key for Code Exchange for enhanced OAuth security
- **Token Storage**: Tokens are stored locally in the user's home directory
- **HTTPS**: All API communications use HTTPS
- **Scope Limitation**: Requests only necessary OAuth scopes

## Troubleshooting

### Authentication Issues

1. **Token Expired**: Use the `clear-auth` tool to clear tokens and re-authenticate
2. **Invalid Client ID**: Verify your `MURAL_CLIENT_ID` in the environment variables
3. **Redirect URI Mismatch**: Ensure the redirect URI matches your Mural app configuration

### Connection Issues

1. **Network**: Ensure you can reach `https://app.mural.co`
2. **Firewall**: Port 3000 must be available for OAuth callback
3. **Test Connection**: Use the `test-connection` tool to verify API access

### Common Error Messages

- `Missing required environment variable: MURAL_CLIENT_ID`: Set the required environment variable
- `OAuth token exchange failed`: Check your client credentials and redirect URI
- `Mural API request failed: HTTP 401`: Token expired or invalid, clear auth and re-authenticate
- `Mural API request failed: HTTP 403`: Insufficient permissions or invalid scope

## Development

### Project Structure

```
mural-mcp-serveur/
├── src/
│   ├── index.ts          # Main MCP server (tool definitions + handlers)
│   ├── oauth.ts          # OAuth 2.0 implementation
│   ├── mural-client.ts   # Mural API client
│   ├── rate-limiter.ts   # API rate limiting
│   └── types.ts          # TypeScript interfaces
├── build/                # Compiled output
├── spec/                 # Documentation
└── package.json
```

### Building

```bash
# Clean build
rm -rf build && pnpm run build

# Development build with watch
pnpm run dev
```

### Testing

Test the server manually:

```bash
# Build and run
pnpm run build
node build/index.js

# In another terminal, test with MCP inspector
npx @modelcontextprotocol/inspector node build/index.js
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Check the troubleshooting section above
- Review Mural API documentation
- Create an issue in the repository