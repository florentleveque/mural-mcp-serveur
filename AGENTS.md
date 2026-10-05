# AGENTS.md: working rules for AI agents

**Purpose & scope.** This file orients an LLM working in this repository: where
things live and the rules that are not obvious from the code. It is **not** user
documentation (that is `README.md`).

- **Don't document what the code already shows.** File trees, command listings,
  env-var tables and setup steps are read faster from the source,
  `package.json` or `README.md` than from a prose copy here, which only goes
  stale.
- Keep each section short: durable rules and pointers. Reference material goes
  to `README.md` or `docs/`, linked from here.
- **Write for the next agent, not for the record.** A line earns its place only
  by changing what someone does next. Git history already holds what was done.
  Exception: a migration still in flight, while both states are live.

## Migration in flight: remote HTTP server (#17, PR #18)

PR #18 replaces the stdio server and its local OAuth flow with a remote MCP
server on Vercel. That server holds the Mural client secret and acts as its own
OAuth authorization server for MCP clients; stdio and npm publishing go away.
Until #18 merges, the sections below describe the **current** state on `main`;
read the PR description for the target design and the commit sequence. Drop
this section once #18 lands.

## Claim before you build: no duplicate work

Before coding an issue: re-read it live (closed as completed means it already
shipped: stop); search open *and* merged PRs for its number (`is:pr #<n>`) and
coordinate on an open one rather than forking it; then self-assign, comment that
you are picking it up, and open your PR as a draft early. Link the issue in the
PR **description** with a closing keyword (`Closes #<n>`; a bare `#<n>` or
`Part of #<n>` does not close it). A follow-up on shipped work gets a *new*
issue for the delta.

**Branch name**: `<issue>-<kebab-slug>`, issue number first, no type prefix
(`17-remote-http-server`, not `feat/17-...`). Short, lowercase, hyphens only,
about the change rather than the file. `feature/remote-http-vercel` (PR #18)
predates this rule and is an accepted exception; don't imitate it.

## Architecture

- `src/index.ts` is the stdio MCP server: it declares every tool's JSON Schema in
  the `tools/list` handler and dispatches `tools/call` through one `switch`.
- Every Mural API request goes through `MuralClient` (`src/mural-client.ts`).
  Failures surface as the typed `MuralApiError` (`status`, `errorCode`,
  `apiMessage`), never as a message to parse; 429 waits come from the
  `x-ratelimit-*-reset` headers.
- Tool responses are built by `jsonResult` / `jsonError` (`src/mcp-format.ts`).
  Read tools return a compact projection (`src/projections.ts`) and take
  `verbose: true` to opt back into the raw object. Keep both conventions for any
  new read tool.
- Auth (`src/oauth.ts`): OAuth 2.0 with PKCE plus the client secret (Mural
  refuses a refresh without it), tokens in `~/.mural-mcp-tokens.json`, a
  temporary callback server on port 3000.
- Mural API reference: `docs/mural-api.md` and
  <https://developers.mural.co/public/docs>.

## Design principle: usage-first, not API-shaped

Design every tool for what an LLM needs to accomplish a real task, not for what
the Mural API happens to expose. Endpoints, names, pagination and data shapes
are an implementation detail: a tool may fan out to several calls and reshape
the result. When API shape and usage pull apart, follow the usage. This never
overrides the tool schema rule below.

## Testing

- New features: TDD, failing test first. Bug fixes: reproduce with a test first.
- Existing tests are sacred: a failure is a potential regression. Find the root
  cause before touching the test.
- Never call the real Mural API from a test. HTTP goes through the global fetch
  stub and filesystem access through `vi.mock('fs/promises')`
  (`tests/unit/helpers.ts`).
- Coverage thresholds in `vitest.config.ts` are a ratchet: raise them, never
  lower them.
- Inter-LLM functional tests live in `tests/functional/`; drive them with
  `/functional-testing`. Protocol: `tests/functional/README.md`.
- Mutation testing (StrykerJS) runs over the scope in `stryker.config.mjs`, and
  CI fails a PR on a mutant that survived **in a line it changed**
  (`pnpm test:mutation:diff origin/main HEAD` reproduces it). That gate is the
  contract; **the score is not a target.** A survivor in a line you changed
  means an assertion is missing or too loose: tighten it, never weaken one to go
  green. Everywhere else, **waive late, not early**: an equivalent mutant stays
  escaped until the gate trips on it, and the person touching the line writes
  `// Stryker disable next-line <mutator>: <one-sentence reason>`. Rationale:
  `docs/decisions/mutation-testing.md`.

## Planning

An implementation plan that changes **MCP-runtime-observable behaviour** (the
tool surface, transports, auth, resources, prompts, persistence or timing a
running server exposes to a client) must also carry a **functional validation
plan**, written for an *independent* validator (another agent or a human who did
not write the code). It lives in the PR description; the validator posts their
report as a PR comment, in English. Author the plan with the
`functional-validation-plan` skill; the validator runs it with the
`run-validation-plan` skill. Don't inline either here.

Independence is about context, not identity: every agent here acts under the
same GitHub account, so a comment's author says nothing about which session
wrote it. A validator is independent when it did not write the code. State the
role behind a run once, in one line; the repository owner decides whether it
counts.

**Pure tooling changes are exempt** (build, lint, test tooling, CI, release
automation): if a running server behaves no differently for a client, the
standard gates (`pnpm typecheck`, `pnpm check`, `pnpm test`, CI) are the
validation.

## Code style

- TypeScript strict; Biome lints and formats (`pnpm check`, `pnpm check:fix`).
- Keep the `!!**/node_modules` force-ignore in `biome.json` `files.includes`: it
  keeps dependency files out of Biome's module-graph scan, not out of the lint.
  `biome.json` rejects comments, hence this note.
- Lint runs on every edit, formatting at pre-commit (`lefthook.yml`). Keep
  `--skip=types` on the edit hook and don't add formatting to it. Why:
  `docs/decisions/lint-tooling.md`.
- Enable a lint rule only once the tree is already clean for it, so `pnpm check`
  stays green in the same commit. Which rules are on and why each other one is
  off: `docs/decisions/biome-rules.md`. `nursery` and the `types` domain are
  closed by policy.
- Only `console.error` and `console.warn` in `src/`: on the stdio transport,
  stdout carries the JSON-RPC protocol (`noConsole` enforces it).
- **Comments explain the why, never the how.** Write one only for what the code
  cannot say: a constraint, a trade-off, a non-obvious API behaviour, a pointer
  to `docs/decisions/`. A comment that paraphrases the line below it is noise.
  Cap an implementation comment at ~50 words and a `/** */` contract block at
  ~100; past that, write a decision record and point to it.

## Toolchain and dependencies

- pnpm only (version pinned in `package.json#packageManager`), Node 24
  (`.nvmrc`).
- `minimumReleaseAge` in `pnpm-workspace.yaml` refuses any version published
  less than five days ago. Pick the newest version that clears it; never add a
  `minimumReleaseAgeExclude` entry or turn `minimumReleaseAgeStrict` off. Why:
  `docs/decisions/dependency-automerge.md`.
- GitHub Actions are referenced by full commit SHA with the exact release as a
  trailing comment (`uses: actions/checkout@<sha> # v6.1.0`), never by a tag.
  Resolve a new one with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`
  (dereference an annotated tag); Renovate keeps the SHAs current.

## Secrets and personal data

- Never print, log or commit a secret: `.env`, `~/.mural-mcp-tokens.json`, OAuth
  tokens, the Mural client secret. A command that needs one reads it into a
  variable and uses it without echoing it.
- Murals hold real people's content and names. Never paste real mural content,
  member names or emails into a commit, an issue, a PR or a test fixture:
  redact or use synthetic data.

## Communication language

GitHub (issues, PRs, commits, comments, code) in **English**. Chat follows the
user's language.

## No attribution lines

Commits and PR descriptions carry no AI attribution: no `Co-Authored-By:`
trailer for an assistant, no "Generated with ..." footer. The human author owns
the change.

## Tool schemas: never weakened (absolute rule)

The server must keep working with every mainstream MCP agent; no PR may degrade
one. A **tool change** keeps what agents depend on in the exposed JSON Schema:
never drop a field, loosen a type or drop what a description said (saying it in
fewer words is fine, fixing a false statement is a duty). A **new tool** states
its purpose, when to use it, its side effects, and describes every parameter,
and keeps the tool set coherent: consistent naming, no needless duplication.

`tests/unit/fixtures/tools-list.json` holds the exposed `tools/list` answer and
`tests/unit/tool-schemas.test.ts` compares the server against it. Edit it by
hand, in the commit that changes the surface, and say so in the message.

## Documentation maintenance

A change to the tool surface updates the "Tools Available" section of
`README.md` in the same PR. Keep counts out of prose; they only go stale.

## Submission quality bar

Before opening a PR or asking for review, clear the
[Submission quality bar](CONTRIBUTING.md#submission-quality-bar) (same bar for
human and AI authors).

## Merging and releases

- Agents never merge. The repository owner merges, by squash.
- Releases are automated by semantic-release on push to `main`: never hand-bump
  `version` in `package.json`. Conventional Commits decide the bump; mark a
  change that breaks visible behaviour with `!`.
