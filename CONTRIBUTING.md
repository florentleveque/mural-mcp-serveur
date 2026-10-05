# Contributing

Thanks for considering a contribution to `mural-mcp-serveur`. See the
[README](README.md) for what the project does and how to run it.

## Review philosophy

This server is maintained by a single developer who works with AI assistance.
**AI-assisted contributions are welcome**, on one condition: every submitted
change has been read line by line and is owned by a human author who can
defend it. Final responsibility for merging belongs to the maintainer; tooling
catches the mechanical issues, understanding the change is non-negotiable.
External contributions follow the same standard.

Besides the author-side AI review, pull requests are reviewed by CodeRabbit,
pointed at this repository's own rules rather than generic ones: it
auto-detects `AGENTS.md` as a code guideline. Review emphasis it would not infer
lives in `.coderabbit.yaml`.

Architecture, code style and the rules agents follow live in
[`AGENTS.md`](AGENTS.md).

## Development setup

| Tool | Version | Source of truth |
| ---- | ------- | --------------- |
| Node | 24 | [`.nvmrc`](.nvmrc) |
| pnpm | 12 | [`package.json#packageManager`](package.json), pinned with a corepack integrity hash |

```bash
git clone https://github.com/florentleveque/mural-mcp-serveur.git
cd mural-mcp-serveur && pnpm install
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

`pnpm install` also installs the lefthook pre-commit hook. pnpm refuses any
dependency version published less than five days ago (`minimumReleaseAge` in
`pnpm-workspace.yaml`); pick an older version rather than working around it.

## Before you start: avoid duplicate work

1. **Check the issue is still live.** Closed as *completed* means it already
   shipped. If a follow-up is needed, open a new issue for the delta.
2. **Search open *and* merged PRs for the issue number** (`is:pr #<n>`). An open
   PR means someone is mid-flight: comment there and coordinate.
3. **Claim it.** Self-assign the issue and leave a short "picking this up"
   comment.
4. **Open your PR as a draft early.** It is the earliest signal that the work is
   in flight.

## Opening a pull request

1. Fork the repository and create a branch from `main`, named
   `<issue>-<kebab-slug>` (see [`AGENTS.md`](AGENTS.md#claim-before-you-build-no-duplicate-work)).
2. Write small, reviewable commits using
   [Conventional Commits](https://www.conventionalcommits.org/): they drive the
   next version (see [Releases](#releases)).
3. Make the author checklist on the
   [PR template](.github/pull_request_template.md) pass locally.
4. Open the PR against `main`. If it resolves an issue, link it in the
   **description** with a closing keyword (`Closes #123`); the squash merge
   reads the PR body, not the individual commit messages.

## Code standards

- TypeScript strict. Biome must be clean: `pnpm check` (`pnpm check:fix` to
  auto-format). The pre-commit hook enforces it on staged files and CI on the
  whole tree.
- `pnpm test` passes and `pnpm test:coverage` holds the thresholds.
- Test-Driven Development is the default workflow:
  - **New features**: write a failing test first, then implement.
  - **Bug fixes**: write a test that reproduces the bug first, then fix it.
  - **Existing tests are sacred**: a failing existing test is a potential
    regression. Investigate before changing it.
  - Never call the real Mural API in tests: HTTP is stubbed
    (`tests/unit/helpers.ts`).
- **Comments explain the *why*, not the *how*.** Longer rationale belongs in
  `docs/decisions/` with a one-line pointer from the code.
- **Tool schemas are never weakened**: see the rule in
  [`AGENTS.md`](AGENTS.md#tool-schemas-never-weakened-absolute-rule).

## Author-side AI review

Before pushing, run an AI review pass on the diff. Suggested prompt:

> Read the diff between this branch and `main`. Look for: potential bugs,
> uncovered edge cases, inconsistencies with the project architecture,
> undocumented dependencies, security issues (secrets in cleartext,
> injections, missing input validation), missing tests. Be strict.

Address every finding, or say in the PR description why you are not.

## Submission quality bar

The bar to clear before opening a PR or asking for review, whether the code was
written by a human or by an AI assistant. The maintainer's review starts from
the assumption that everything below has been done.

1. **Re-read your own diff in full.** If a hunk no longer makes sense out of the
   context where you wrote it, rewrite it.
2. **Justify each change.** For every non-trivial hunk: why is it here, what
   would break without it, and is it the smallest version of the fix.
3. **Look for what you didn't write.** Missing validation on an input, missing
   test for an edge case, missing README update on a renamed tool, missing error
   path.
4. **Run the [author-side AI review](#author-side-ai-review)** and address its
   findings.
5. **Run the full local gate**: `pnpm check`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`. If the PR changes anything under `src/`, also run the mutation
   gate on your diff, because CI does: `pnpm test:mutation:diff origin/main HEAD`
   ([`docs/decisions/mutation-testing.md`](docs/decisions/mutation-testing.md)).
6. **Scope discipline.** Don't bundle unrelated cleanups. Note them and open a
   separate issue.
7. **No invented behaviour.** If a Mural API field, an SDK option or a library
   API isn't confirmed by the docs, an existing test or a typed response, mark it
   `// TODO:` and raise the question in the PR description rather than guessing.
8. **Functional validation plan** when the change is visible to an MCP client at
   runtime (see [Planning](AGENTS.md#planning) in `AGENTS.md`).
9. **Mark the PR ready for review** once the local gate is green.

## What happens after you open the PR

1. CI runs lint, the Biome config migration check, typecheck, tests with
   coverage thresholds and the build (`.github/workflows/ci.yml`), plus the
   mutation gate on the lines your diff changed (`Changed lines` in
   `.github/workflows/mutation.yml`), preceded by a canary that proves Stryker
   still measures something.
2. The maintainer reviews, you address the findings, the maintainer merges.

## Merge policy

- **Squash merge** is the default. The squashed commit message must follow
  Conventional Commits, since semantic-release reads it.
- No force-push to `main`.

## Releases

Versions follow [SemVer](https://semver.org/) and are computed automatically
from commit messages: nobody bumps the version by hand. Every merge to `main`
runs [semantic-release](https://github.com/semantic-release/semantic-release),
which computes the next version, updates [`CHANGELOG.md`](CHANGELOG.md) and
`server.json`, creates the GitHub Release and publishes the new version to the
MCP Registry. Vercel deploys `main` to production on its own. How it works and
the one-time setup: [`docs/release-automation.md`](docs/release-automation.md).

| Commit type | Resulting bump |
| --- | --- |
| `fix:`, `perf:` | patch |
| `feat:` | minor |
| `feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `style:`, `build:` | no release |
