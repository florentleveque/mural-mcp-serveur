// Serves the built app locally, as Vercel's Express preset does in a
// deployment (`pnpm dev:http`). The issuer must match the address clients use.
import app from '../build/app.js';

const port = Number(process.env['PORT'] ?? 3000);
process.env['PUBLIC_URL'] ??= `http://localhost:${port}`;

app.listen(port, 'localhost', () => {
  console.error(`Mural MCP server on ${process.env['PUBLIC_URL']}/mcp`);
});
