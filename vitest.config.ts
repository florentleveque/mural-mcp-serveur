import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // MCP wiring, out of unit test scope
      // json-summary feeds the coverage table in the CI job summary.
      reporter: ['text', 'text-summary', 'json-summary'],
      // Quality gate: the run fails below these baselines (measured values,
      // rounded down). Ratchet them up as coverage improves; never lower them
      // silently.
      thresholds: {
        statements: 96,
        branches: 88,
        functions: 96,
        lines: 96,
      },
    },
  },
});
