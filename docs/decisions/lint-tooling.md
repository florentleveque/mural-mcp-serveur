# Lint tooling: Biome and lefthook, lint on edit, format before sharing

> **Build documentation, not user documentation.** This records a toolchain
> decision for maintainers. Nothing here changes how the MCP server behaves for a
> client.

| | |
| --- | --- |
| **Status** | Applied |
| **Replaces** | ESLint (typescript-eslint, unicorn, prettier plugin), Prettier with an import-sort plugin, husky, lint-staged |
| **Reference** | Same setup as [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server), whose `docs/decisions/lint-tooling.md` holds the measurements |
| **Companion** | [`biome-rules.md`](biome-rules.md) (which rules are on, and why the others are off) |

## Decision

One tool, Biome, lints, formats and sorts imports. lefthook runs it as a git
hook. Four packages and three config files go away.

## Where each check runs

| Stage | Command | What it covers |
| --- | --- | --- |
| Every edit (Claude Code `PostToolUse` hook, `.claude/settings.json`) | `biome lint --write --skip=types` on the edited files | Fast lint feedback. Formatting is left out on purpose: it only matters before code is shared. |
| Pre-commit (`lefthook.yml`) | `biome check --write --error-on-warnings` on the staged files | Format, import sorting and the full lint, including the `types`-domain rules the edit hook skips. Fixed files are re-staged. |
| CI (`pnpm check`) | `biome check --error-on-warnings .` | The same gate on the whole repository, read-only. |

`--skip=types` matters because the two `types`-domain rules
(`useArrayFind`, `useArraySortCompare`) force a project-wide type-inference
pass on every invocation, even on one file. They still run at pre-commit and in
CI, so skipping them on edit loses no rule.

`pnpm typecheck` (`tsc --noEmit`) stays the real type gate: Biome's type
inference is not a substitute for the compiler.

## Perimeter

`biome.json` is the only perimeter. Biome reads `.gitignore`
(`vcs.useIgnoreFile`), and `!!**/node_modules` keeps dependency files out of
its module-graph scan. `.claude/settings.local.json` is excluded explicitly: it
is each developer's personal, never-versioned Claude Code file, ignored through
the global git ignore rather than this repository's. The lefthook job passes staged files without a `glob`
and lets Biome filter, so the two can never disagree.
