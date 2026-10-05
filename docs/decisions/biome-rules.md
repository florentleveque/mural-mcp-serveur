# Biome rule selection: what is on, what is off, and why

> **Build documentation, not user documentation.** This records which Biome lint
> rules this repository enables and, for every rule turned off, why. `biome.json`
> rejects comments, so the rationale lives here.

| | |
| --- | --- |
| **Status** | Applied |
| **Measured on** | Biome 2.5.14, against `src/`, `tests/` and the root config files |
| **Starting point** | The rule set of [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server) (`biome.json`, `docs/decisions/biome-rules.md`) |
| **Companion** | [`lint-tooling.md`](lint-tooling.md) (where lint runs) |

## The selection rule

**Zero-violation ratchet.** A rule is enabled only once the whole repository is
already clean for it, so `pnpm check` stays green in the same commit that turns
it on. Cleanup lands first, the rule after: never a rule plus a bulk rewrite in
one change.

## What is on

The `recommended` preset plus every rule the Zendesk configuration enables
explicitly, minus the rules listed below. The overrides are the same:

| Path | Rule off | Why |
| --- | --- | --- |
| `tests/**`, `scripts/**` | `noExcessiveCognitiveComplexity` | Nested `describe`/`it` callbacks trip it structurally. |
| `tests/**`, `scripts/**` | `useTopLevelRegex` | A regex in a test or a one-shot script has no hot path. |
| `**/*.config.ts`, `**/*.config.mts`, `**/*.config.mjs` | `noDefaultExport` | Tool config files must default-export. |
| `scripts/**` | `noConsole` | Scripts are command-line tools: printing to stdout is their output, not a protocol leak. |

One rule is added on top of the Zendesk set: `suspicious/noConsole`, allowing
only `console.error` and `console.warn`. It carries over the ESLint `no-console`
rule this repository already enforced: on the stdio transport, stdout carries
the JSON-RPC protocol, so any other console call corrupts it.

## Off until the tree is clean for them

Each rule below fired on the current tree when this configuration was
introduced. The count is the number of diagnostics measured then. Turning one
back on means fixing those sites first, in their own commit.

| Group | Rule | Diagnostics |
| --- | --- | ---: |
| suspicious | `noExplicitAny` | 31 |
| suspicious | `noShadow` | 2 |
| suspicious | `noEvolvingTypes` | 2 |
| suspicious | `noImplicitAnyLet` | 1 |
| style | `useReadonlyClassProperties` | 16 |
| style | `noInferrableTypes` | 8 |
| style | `useErrorCause` | 7 |
| style | `useExponentiationOperator` | 3 |
| style | `useCollapsedIf` | 3 |
| style | `useNumberNamespace` | 2 |
| style | `noUselessElse` | 2 |
| style | `noNestedTernary` | 2 |
| style | `noExcessiveClassesPerFile` | 2 |
| style | `useDefaultSwitchClause` | 1 |
| style | `useConsistentTypeDefinitions` | 1 |
| correctness | `noUnusedVariables` | 7 |
| correctness | `useParseIntRadix` | 2 |
| complexity | `noUselessCatchBinding` | 7 |
| complexity | `noExcessiveCognitiveComplexity` | 3 |
| complexity | `useOptionalChain` | 2 |
| complexity | `noUselessStringConcat` | 1 |

`noExplicitAny` mirrors the previous ESLint setup, which only warned on it: the
API client still relies on `any`-typed responses until a dedicated typing pass.

## Off by policy

- **The whole `nursery` group.** Nursery rules change semantics between Biome
  minors, and Renovate bumps Biome automatically: one would break CI with no
  human in the loop.
- **The `types` domain beyond `useArrayFind` and `useArraySortCompare`.** Biome's
  type inference is not trustworthy enough yet for more; zero diagnostics from a
  `types` rule means "not analysed", not "clean". `pnpm typecheck` is the type
  gate.
