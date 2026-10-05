# Mutation testing: StrykerJS, a gate on the changed lines, and a canary

> **Build documentation, not user documentation.** This records a test-tooling
> decision for maintainers. Nothing here changes how the MCP server behaves for
> a client.

| | |
| --- | --- |
| **Status** | Applied |
| **Tool** | StrykerJS 10 with the vitest runner (patched, see below) |
| **Reference** | Same design as [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server), whose `docs/decisions/mutation-testing.md` holds the full measurements and the alternatives weighed |

## Why

`vitest run --coverage` answers "was this line executed?". Mutation testing
answers "if this line were wrong, would a test notice?". Stryker injects small
changes (a `+` turned into `-`, a condition negated, a string emptied) and
reruns the tests: a mutant no test detects is a line the suite executes without
checking.

## Baseline

Measured when the tooling was introduced, on the scope below (1 247 mutants, about
1 min 30 s on a laptop):

| | |
| --- | ---: |
| **Mutation score** | **36.81 %** |
| Killed | 458 |
| Timeout | 1 |
| Survived | 166 |
| NoCoverage | 622 |

Line coverage on the same files was 48 % at the time; the gap between the two
is what coverage cannot see.

## Scope

`stryker.config.mjs` mutates `src/**/*.ts` except:

- `src/index.ts`: the stdio entry point (environment checks, signal handlers,
  `main()`), run once per test process at import, and due to go with the stdio
  transport. The tools it used to declare moved to `src/tools/`, which is in
  scope with its own tests.
- `src/types.ts`: type-only, nothing to mutate.

The `!` patterns are applied in order (set, then unset), and the gate's
`scopeMatcher` reproduces that order exactly: `--mutate` replaces the
configured scope rather than intersecting it, so a naive match would mutate an
excluded file anyway.

## The contract: the changed lines, not the score

**The gate on the changed lines is the contract. The global score is a
thermometer.** `thresholds.break` stays `null`, so a run never fails a build on
a percentage, and no area is expected to reach any particular number.

`pnpm test:mutation:diff <base> <head>` (what CI runs on every pull request):

1. turns `git diff --unified=0` into `file:start-end` line ranges inside the
   mutate scope;
2. runs Stryker with `--mutate` on exactly those ranges;
3. fails if any mutant *contained* in those ranges is `Survived` or
   `NoCoverage`.

A survivor in a line you changed means an assertion is missing or too loose:
tighten it, never weaken one to go green.

StrykerJS has no git-aware scoping (stryker-js#2843), hence the script. Its
range arithmetic and report reading are unit-tested
(`tests/unit/mutation-scope.test.ts`): an off-by-one there would silently stop
guarding a line.

### What the gate cannot see

Stryker mutates a construct only when the construct is *contained* in a
requested range. An edit inside a construct larger than the edit (one line of
a long multi-line expression) can therefore produce no mutant to judge, and the
gate says so explicitly rather than reporting a pass. Judging mutants that
merely *overlap* the changed lines instead would pull in mutants this run did
not instrument, replayed from the baseline with `main`'s verdicts, and fail a
pull request on code its author did not write.

### Waive late, not early

An equivalent mutant (one no test could ever tell apart from the original)
stays escaped until the gate actually trips on it. The person touching that
line then writes `// Stryker disable next-line <mutator>: <reason>`, with a
one-sentence reason. Nobody clears escaped mutants in advance.

## The canary

`pnpm test:mutation:canary` mutates `scripts/mutation-canary/subject.ts`, two
one-line functions whose verdicts are fixed by construction: the sum is
asserted exactly by its test (its `a - b` mutant must be `Killed`), the product
is reached by no test (its `a / b` mutant must be `NoCoverage`). Any other
verdict means Stryker stopped observing the test run, and every "no mutant
escaped" it reports is meaningless until fixed. CI runs it before the gate,
because a dependency-only change has no mutated line and would otherwise pass
the gate vacuously.

## The vitest-runner patch

vitest 5 joins qualified test names with `' > '`. `@stryker-mutator/vitest-runner`
10.0.0 still filtered on the old separator, so each mutant ran zero tests and
every one came back `Survived`. `patches/@stryker-mutator__vitest-runner@10.0.0.patch`
(wired through `patchedDependencies` in `pnpm-workspace.yaml`) carries the
unmerged upstream fix, stryker-js#6214. The canary is what would catch a
regression of this kind. Drop the patch once a runner release ships the fix.

## Incremental mode

`--incremental` reuses verdicts from `reports/mutation/stryker-incremental.json`
for unchanged code. It is opt-in per invocation, never the default: it diffs
mutated sources and test files only, so a dependency, config or Node change
would replay verdicts instead of re-running them. CI enables it only with a
cache key that hashes those other inputs.

## CI

`.github/workflows/mutation.yml` has two jobs, both set up by the composite
action `.github/actions/mutation-baseline`:

- **`Changed lines`** (every pull request): canary, then
  `pnpm test:mutation:diff <base sha> HEAD --incremental`. `HEAD` is the merge
  commit checkout produces, so the line numbers match the tree Stryker mutates.
- **`Full scope`** (every push to `main`): canary, then the whole scope with
  `--incremental`, and the only job that saves the baseline to the cache.

The baseline can go stale silently: incremental mode diffs `src/**` and the
`*.test.ts` files it discovers, nothing else. So the cache key prefix hashes
every other input that can change a verdict: `pnpm-lock.yaml` (which also
records the patch hash), `package.json`, `stryker.config.mjs`,
`vitest.config.ts`, `.nvmrc`, and every non-`*.test.ts` file under `tests/`
except `tests/functional/`. Change one and no cache entry matches, so Stryker
runs cold. That last part is asserted by `tests/unit/mutation-scope.test.ts`:
adding a shared fixture under `tests/` without hashing it fails the suite.

Two details keep that sound:

- The key ends in the commit sha, and the restore-key is the prefix. Cache
  entries are immutable, so a fixed key would freeze the first baseline; the
  prefix fallback is safe only because the inputs hash sits inside it.
- Only `Full scope` saves, and only on success. A PR run is diff-scoped, so
  saving it would publish a truncated baseline.

The triggers are unfiltered on purpose: a path-filtered required check never
reports, and a `paths:` list would be a second copy of the cache key's rule.

## Dashboard

The `dashboard` reporter only runs when `STRYKER_DASHBOARD_API_KEY` is set. No
key is configured today, so nothing is published.
