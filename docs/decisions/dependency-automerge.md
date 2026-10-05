# Dependency auto-merge: the criterion is the dependency, not the semver level

> **Build documentation, not user documentation.** This records why Renovate
> auto-merges what it auto-merges here. Nothing in it changes how the MCP server
> behaves for a client. `renovate.json` rejects comments, so the reasoning lives
> here; each rule's `description` field points back to this file.

| | |
| --- | --- |
| **Status** | Applied. Takes effect once the Renovate app is installed on the repository and "Allow auto-merge" is enabled in its settings (`platformAutomerge`). |
| **Starting point** | The policy of [fruggr/zendesk-mcp-server](https://github.com/fruggr/zendesk-mcp-server) (`renovate.json`, `docs/decisions/dependency-automerge.md`), minus its container and Termux rules |
| **Question** | Which dependency updates deserve a human read, and what actually protects the repository from the ones that do not get one? |
| **Answer** | Gate on **what the dependency can reach**, not on its semver level. The dependencies that define the exposed MCP surface have their minors read by hand; everything else non-major is batched weekly and auto-merged. |

## 1. The criterion: what can this dependency reach?

Semver level is a claim by the publisher about compatibility. It says nothing
about how far a change can travel *in this repository*, which is the thing worth
gating on.

- **The `@modelcontextprotocol/*` SDK and `zod` define the tool surface itself.**
  The JSON Schema agents consume is generated from the tool schemas and
  serialised by the SDK. A minor on either can move that schema, which the tool
  schema rule in [`AGENTS.md`](../../AGENTS.md) forbids weakening. These are read
  by hand.
- **Everything else is a leaf** behind our own code, and CI is what catches a
  behaviour change in it.

The list is applied to **minors only**. A patch on `zod` goes through the batch
like any other patch, on the bet that a patch moving the exposed schema is an
upstream bug rather than a normal release. Reviewing every patch by hand would
turn the review into a rubber stamp on the one dependency where attention is
actually worth something.

The list is names, not a category: a new dependency that shapes what clients
see (an OAuth authorization server library, for instance) joins it in the commit
that adds it.

## 2. What protects the repository, and what does not

**Human review does not detect a compromised package.** Nobody reads a version
number bump in a diff and sees a malicious postinstall. What catches that class
of attack is time. This repository has two independent delays:

- `minimumReleaseAge: "5 days"` in `renovate.json`, on every update Renovate
  proposes;
- `minimumReleaseAge: 7200` (minutes) in `pnpm-workspace.yaml`, which pnpm
  enforces natively at resolution time and which therefore also covers the
  transitive tree Renovate does not manage.

**Security updates are held to the same quarantine.** Renovate documents that
security updates bypass `minimumReleaseAge`, which is true of its defaults: the
`vulnerabilityAlerts` option ships a default object carrying
`minimumReleaseAge: null`. That option is mergeable, so the explicit
`"minimumReleaseAge": "5 days"` in the block wins. The quarantine guards against a
*published package being malicious*, and a compromised release announced as a
security fix is precisely the case the delay is for.

How the wait is enforced, in order of what actually holds the merge:

1. Renovate posts `renovate/stability-days` as a pending status.
   `internalChecksFilter: "flexible"` in the block still opens the PR at once, so
   a CVE is visible the day it lands. This status is not a required check, and
   cannot be: Renovate only posts it where the age gate applies.
2. `platformAutomerge` arms GitHub's auto-merge, which waits only on required
   checks, so point 1 does not hold the merge.
3. **pnpm does.** It refuses to resolve a version younger than five days, as a
   hard failure (`minimumReleaseAgeStrict` defaults to `true` once the age is set
   explicitly). CI runs `pnpm install --frozen-lockfile` and goes red until the
   fix ages out.

So the visible cost is a red security PR for a few days. It is loud,
self-clearing and fails closed. Do not "fix" it with
`minimumReleaseAgeStrict: false` (pnpm would quietly resolve an older version and
the PR would go green without applying the fix) nor with
`minimumReleaseAgeExclude` (the per-package form of the same mistake).

One asymmetry remains, and it is a Renovate default: the same block forces
`dependencyDashboardApproval: false`, so a **major** carrying an advisory opens a
PR directly instead of waiting on the Dependency Dashboard. It is labelled
`needs-review` and merged by hand.

## 3. Batching, and what it costs

Non-major, non-security updates are grouped into weekly PRs: production and dev
apart, so a broken dev bump does not hold back a production one. The
`@modelcontextprotocol/*` packages travel in their own `mcp sdk` group because
they release in lockstep over one shared core, and moving one without the others
would leave two copies of it in the lockfile.

The cost is accepted: one member breaking CI holds its whole batch, and a
regression found later is attributed to a batch. Squash-merge keeps the
mitigation cheap: one commit per batch, so `git revert` takes it all back out.

The Monday window is not cosmetic: `lockFileMaintenance` runs Tuesday and
Friday, both rewrite `pnpm-lock.yaml`, and overlapping windows cost a rebase
cascade.

Two rules sit outside the batches: GitHub Actions updates are never auto-merged
(a workflow change runs with the repository's token), and the Stryker packages
are held for a person because `@stryker-mutator/vitest-runner` carries a local
patch pinned to its exact version (see
[`mutation-testing.md`](mutation-testing.md)).

Every action is referenced by its full commit SHA, with the release it matches
as a trailing comment (`actions/checkout@<sha> # v6.1.0`). A tag such as `v6` is
mutable: whoever controls the action's repository can move it to other code,
which would then run with the repository's token. A SHA cannot be moved.
`helpers:pinGitHubActionDigests` keeps the SHAs current: Renovate follows the
version in the comment and opens a PR that changes the SHA and the comment
together, held for review by the rule above.

## 4. The invariant that fails silently

Release levels are decided by the commit title. A batch is titled
`chore(deps): …`, which `.releaserc.json` maps to *no release*; a security update
is titled `fix(security): …`, which maps to a patch release. **If a security
update were ever swept into a batch, it would inherit the batch title and stop
cutting a release.** Nothing would fail, and nothing would warn.

Renovate keeps packages under a vulnerability alert out of standard grouping by
default, and the `vulnerabilityAlerts` block takes precedence over
`packageRules`. The block still pins `"groupName": null` explicitly. This is the
first thing to check the next time the grouping rules are touched.

## 5. Review condition

Reopen this decision if either of these shows up:

- a batch sits blocked for more than two consecutive weeks: the grouping is then
  costing more than the PR noise it removed;
- a regression reaches `main` through an auto-merged batch that a changelog read
  would plausibly have caught. The answer would be to widen the hand-read list by
  one name, not to go back to gating on semver.
