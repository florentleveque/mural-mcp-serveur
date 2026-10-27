---
name: functional-validation-plan
description: Create a functional validation plan for a feature or bugfix. Use whenever you author an implementation plan, finish a feature/bugfix with runtime-observable behaviour, or prepare a PR that needs independent end-to-end validation, even when validation isn't explicitly asked for.
---

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

# Functional validation plan: author protocol

A code change is not "done" when the unit tests pass. Someone who did **not**
write the code must be able to exercise the feature end-to-end and confirm it
behaves as claimed. This skill produces the brief that lets them do that.

## When to apply

- Whenever you produce an **implementation plan** that changes MCP-runtime-
  observable behaviour: the plan includes a functional validation plan as a
  first-class section, not an afterthought.
- Whenever you land a feature or bugfix whose behaviour is observable at
  **MCP-server runtime** (auth flows, transports, tool surface, resources,
  prompts, persistence, timing).

Skip for changes with no MCP-runtime-observable behaviour: pure docs, comments,
formatting, **and pure tooling** (build, lint, test tooling, CI, release
automation). The standard gates (`pnpm typecheck`, `pnpm check`, `pnpm test`,
CI) cover those. Say so explicitly rather than silently omitting the plan.

## Hard rules

- **Independent validator.** Write the plan FOR someone other than the
  implementer: another agent or a human. Don't assume it shares your
  conversation: spell out the state to manipulate and how to observe results.
  Independence is about *context*, not identity: every agent here posts under
  the same human's GitHub account, so judge a report on its evidence and leave
  the "does this count" call to the repository owner.
- **Assume a ready environment; don't make the validator build it.** The server
  under test is the **Vercel preview deployment of the PR branch**, mounted in
  the validator's session as the `mural-mcp-dev` MCP server (project
  `.mcp.json`), already authenticated, its tools loaded as
  `mcp__mural-mcp-dev__*`. So the plan must NOT ask the validator to:
  - build, install or start a server, or deploy anything;
  - locate or configure credentials, tokens, the Mural client secret or the
    deployment URL.

  The validator drives the feature by calling the real `mcp__mural-mcp-dev__*`
  tools. A credential or connection error is a `BLOCKED` finding to report,
  never a setup task to perform. The plan names the commit the preview must be
  built from (the PR head), so the validator can check it before starting.
- **Ground truth from the tools.** Read tools take `verbose: true` and return the
  raw Mural object, so a change that depends on the exact shape of a Mural
  response can be checked through the tools themselves. When even the verbose
  output cannot show what matters (an HTTP status, a header, an OAuth redirect),
  say which observable to capture instead (a Vercel runtime log line, the
  browser address bar during the OAuth flow) rather than asking for a script.
- **Disposable Mural state only.** A scenario that writes creates its own
  objects in a mural made for the run, with a title prefixed
  `[MCP validation]`, and the plan says how to delete them afterwards. Never
  touch a pre-existing mural, room or workspace setting.
- **Lives in the PR description.** Put the plan in the PR body under a
  `## Functional validation plan` heading so it travels with the PR. Keep it in
  sync if the change evolves.
- **Report goes to a PR comment.** The validator posts their findings as a PR
  comment (English, `AGENTS.md` rule), referencing each scenario id with an
  OK/FAIL/BLOCKED verdict and the observed evidence.
- **No waiting on real time.** Prefer levers that simulate state over waiting
  out a real timeout (Mural access tokens live 900 s: say how to force the
  refresh path instead of waiting for it). Call out which behaviours are already
  covered by fake-timer unit tests so the validator doesn't re-prove them.
- **Distinct from `/functional-testing`.** That harness drives the committed
  inter-LLM scenarios in `tests/functional/`. This skill is the lighter, per-PR
  brief embedded in the PR description. Reference the harness when the change
  belongs there; don't duplicate it.

## Plan structure

Write the plan as a self-contained, copy-pasteable brief:

1. **Context**: the feature and which `mcp__mural-mcp-dev__*` tool call(s)
   exercise it. Note any path that does NOT exercise the code, so the validator
   doesn't test the wrong surface.
2. **Setup & prerequisites**: only what the ready environment does not provide:
   the disposable state to create, and how to observe (tool output, Vercel
   runtime logs, browser). Flag what can only be checked partially.
3. **Scenarios**: a table, each row: id, what it validates, the exact
   manipulation, the tool call to make, the expected observable. Make
   "expected" concrete (which field, which error code, which log event).
4. **Long-running behaviours**: for anything time-based, give the no-wait lever
   AND name the unit test that already covers it.
5. **Priorities**: which scenarios are the real user-facing paths (do first).
6. **Cleanup**: how to delete what the run created.
7. **Reporting instructions**: the validator posts a PR comment: per-id verdict
   and evidence, redacted (see `run-validation-plan`); overall summary.

## Loop

1. Draft the plan from the structure above, tailored to the change.
2. Put it in the PR description under `## Functional validation plan`
   (`gh pr edit --body-file`), or inline if you are still in plan mode and no
   PR exists yet.
3. Hand it to the independent validator: another agent runs the executor side
   (the `run-validation-plan` skill), or a human picks it up.

## Closing the loop (verifying the report)

The feature is not validated until every scenario is `OK` against the **latest
pushed commit**. When the validator's report lands as a PR comment:

1. **Read the report** and confirm it tested the right commit SHA. If it
   predates your last push, ask for a re-run. A stale SHA is a reason to re-run;
   the account it was posted from never is.
2. **Re-verify each scenario; don't trust the verdict blindly.** Check the
   reported evidence against the plan's expected observable yourself. Where the
   evidence is too thin to confirm, ask for that scenario to be re-captured.
3. **On all OK:** the loop is closed. Note the outcome **once** (a short
   confirming PR comment, or tell the user) and stop there.
4. **On any FAIL/BLOCKED:** diagnose the root cause. A real bug gets a fix on
   the branch in a separate commit, a push, and a re-run of the affected ids
   against the new SHA. A `BLOCKED` is reported to the user, who decides whether
   that scenario can be validated here.
