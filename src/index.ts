#!/usr/bin/env node

import 'dotenv/config';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { MuralClient } from './mural-client.js';
import { MuralOAuth } from './oauth.js';
import { createMcpServer } from './server.js';

const REQUIRED_ENV_VARS = ['MURAL_CLIENT_ID', 'MURAL_CLIENT_SECRET'] as const;

function validateEnvironment(): { clientId: string; clientSecret: string; redirectUri?: string } {
  const clientId = process.env.MURAL_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_ID. ' +
        'Please set this in your environment or .env file.',
    );
  }

  const clientSecret = process.env.MURAL_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      'Missing required environment variable: MURAL_CLIENT_SECRET. ' +
        'Mural requires client authentication (the client secret) for the OAuth token exchange. ' +
        'Copy it from your Mural app (Basic Information page) and set it in your environment or .env file.',
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri: process.env.MURAL_REDIRECT_URI,
  };
}

async function main() {
  const { clientId, clientSecret, redirectUri } = validateEnvironment();

  const oauth = new MuralOAuth(clientId, clientSecret, redirectUri);
  const server = createMcpServer({
    client: new MuralClient(oauth),
    clearAuthentication: () => oauth.clearTokens(),
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Mural MCP Server running on stdio');
  console.error(`Required environment variables: ${REQUIRED_ENV_VARS.join(', ')}`);
  console.error('Server ready to accept requests...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
