// Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
// Mutation testing config. Rationale, scope choices and the gate contract:
// `docs/decisions/mutation-testing.md`.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',

  // Plugin auto-discovery globs `node_modules/@stryker-mutator/*`, which does
  // not resolve the runner under pnpm's symlinked layout. Declare it.
  plugins: ['@stryker-mutator/vitest-runner'],

  // Scope: logic code, where a surviving mutant is a genuine test gap.
  //
  // `src/index.ts` is excluded: it is the stdio entry point (environment
  // checks, signal handlers, `main()`), run once per test process at import,
  // and it goes away with the stdio transport. The tools it used to declare
  // live in `src/tools/`, which is in scope.
  // `src/types.ts` is type-only: nothing to mutate.
  //
  // `!` ordering is load-bearing: Stryker applies these as set/unset in
  // sequence, and `scopeMatcher` in the gate mirrors it
  // (`tests/unit/mutation-scope.test.ts`).
  mutate: ['src/**/*.ts', '!src/index.ts', '!src/types.ts'],

  // `json` is what `scripts/mutation-scope.mjs` reads to judge a diff, so it
  // belongs here. The dashboard reporter only runs when its key is set: a
  // keyless run would upload anyway and fail.
  reporters: [
    'html',
    'json',
    'clear-text',
    'progress',
    ...(process.env.STRYKER_DASHBOARD_API_KEY ? ['dashboard'] : []),
  ],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  dashboard: { reportType: 'full' },

  // Score table yes, per-mutant dump no: under `--incremental` the report is
  // project-wide, and the PR gate tees stdout into the job summary. The full
  // per-mutant detail is in the uploaded HTML report.
  clearTextReporter: { reportMutants: false },

  // Where `--incremental` keeps its baseline. Not enabled by default: it diffs
  // mutated sources and test files only, so a dependency, config or Node change
  // would replay verdicts instead of re-running them. CI opts in per invocation,
  // with a cache key that covers those inputs.
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // A mutant that loops forever is detected by hanging the run; 20 s keeps
  // genuine hangs distinguishable from slow tests.
  timeoutMS: 20000,

  // Advisory only: `break` stays null so a mutation run never fails a build on
  // its own. The gate is on the diff (`pnpm test:mutation:diff`).
  thresholds: { high: 85, low: 70, break: null },
};
