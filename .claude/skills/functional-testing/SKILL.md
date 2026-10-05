---
name: functional-testing
description: Drive the inter-LLM functional test harness for this MCP server. Use when the user invokes /functional-testing, either with a scenario slug (e.g. `01-tool-surface`) or `all`. Reads STATE.md, produces a bridge prompt for the executing LLM, then ingests reports and writes verdicts. Never reads `expected.md` until the executor has already pushed its report.
---

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

# Functional testing: leading LLM protocol

You are the **leading LLM** in a two-LLM functional test loop. The other LLM
runs in a Claude Code session connected to the server under test (the
`mural-mcp-dev` entry: the PR's Vercel preview), executes scenarios against it,
and pushes its artifacts. You drive the loop without ever calling the server
yourself. Protocol and file layout: `tests/functional/README.md`.

## Invocation forms

- `/functional-testing <NN-slug>`: drive a single scenario.
- `/functional-testing all`: drive every scenario in `STATE.md` whose status is
  not yet final (not `OK` and not `FAIL`), in order.

## Scenario status lifecycle

| status      | written by  | meaning                                          |
| ----------- | ----------- | ------------------------------------------------ |
| `pending`   | initial     | scenario declared, executor has not yet run it   |
| `done`      | executor    | report pushed, awaiting the leading-LLM verdict  |
| `OK`/`FAIL` | leading LLM | verdict written; row is now final                |

## Loop per scenario

1. **Read state.** Open `tests/functional/STATE.md`. Confirm the scenario exists
   and its status. With `all`, pick the first row still `pending` or `done`.
2. **Refuse if not your turn.** If `holder` in the frontmatter is not `leading`,
   the executor still owes a push. Tell the user, stop.
3. **Read the spec, NOT the expected.** Open
   `tests/functional/scenarios/<slug>/spec.md`. Do **NOT** open `expected.md`
   yet: reading it before the executor reports would leak bias into the bridge
   prompt.
4. **Produce a bridge prompt** for the user to paste into the executing session,
   translated into the user's language (`AGENTS.md`: chat follows the user,
   GitHub is English):

   ```text
   You are in the mural-mcp-serveur repository; the local branch must be up to
   date with origin/<branch-from-STATE>.
   Read tests/functional/scenarios/<slug>/spec.md and follow its instructions
   strictly.
   Do NOT read expected.md: it holds the verdict criteria, and seeing it would
   bias your report.
   Write tests/functional/reports/<slug>.raw.json and
   tests/functional/reports/<slug>.report.md, redacted as the spec says.
   When done, update tests/functional/STATE.md (status=done, holder=leading),
   commit and push. Then tell me.
   ```

5. **Wait for the user to confirm the push.** No polling.
6. **Pull and read.** `git pull origin <branch>`. Open
   `tests/functional/reports/<slug>.raw.json` (canonical) and
   `tests/functional/reports/<slug>.report.md` (narrative and assertion fence).
   If either holds unredacted personal data, stop: tell the user before anything
   else, since the push already published it.
7. **Now read `expected.md`.** Compare each assertion ID between the report fence
   and the expected values. Re-verify each against `raw.json`: the executor may
   have miscopied.
8. **Write the verdict** at `tests/functional/reports/<slug>.verdict.md`:

   ```markdown
   # Verdict: <slug>

   | ID  | Status | Notes                                                 |
   | --- | ------ | ----------------------------------------------------- |
   | A1  | OK     | -                                                     |
   | A2  | FAIL   | Expected X, raw shows Y. See `raw.json` `.tools[1]`.  |

   ## Summary

   <green / list of failing IDs>

   ## Proposed actions

   - <if any FAIL: pointer to the code fix, file:line>
   ```

9. **Update `STATE.md`.** Set the scenario `status` to `OK` or `FAIL`, the final
   state. Hand `holder` back to `executor` only to ask for a re-run (report
   incomplete), reverting `status` to `pending`.
10. **Commit and push** the verdict and the `STATE.md` update.
11. **If FAIL with a clear root cause:** propose the code fix on the branch in a
    **separate commit**. Push, tell the user.

## When `all`

Loop steps 1 to 11 for each pending scenario, in order. Stop on the first FAIL
and surface the diagnosis before continuing: the executor may need to re-run
after a code fix.

## Hard rules

- Never read `expected.md` before the executor has pushed its report.
- Never edit `spec.md` or `expected.md` mid-run.
- Never push a code fix and a verdict in the same commit.
- Never let real mural content, member names or emails into a committed file:
  the repository is public. Redaction rules: the `run-validation-plan` skill.
- If you can't reach a verdict (raw JSON corrupted, missing artifact), say so in
  `verdict.md` and ask the user; don't fabricate.
