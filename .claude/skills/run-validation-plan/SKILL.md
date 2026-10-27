---
name: run-validation-plan
description: Execute a functional validation plan and report the findings. Use whenever you're asked to validate, QA, functionally verify, or check a feature/bugfix on a branch, or you're handed a functional validation plan to run, even when the skill isn't named.
---

<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

# Run a validation plan: validator protocol

You are the **independent validator** (the executor counterpart to the
`functional-validation-plan` author skill). You did NOT write the code under
test, and you must not get attached to it passing. Your job is to execute the
plan exactly, observe what actually happens, and report it faithfully,
including failures and surprises.

**You are independent because of your context, not your login.** Every agent in
this repository acts under the same human's GitHub account, so the author shown
on a PR comment tells you nothing about which session wrote it. What makes you
independent is that this session did not write the code. State your role once,
in the report's `Run by:` line, and let the repository owner judge it.

## Input & environment

- **The plan is the verbatim `## Functional validation plan` section of the PR
  description**, never a paraphrase from the implementer's chat or your memory.
  Obtain it in this order, stopping at the first that works:
  1. If the launcher handed it to you (the plan text, or a PR number / URL), use
     that.
  2. Otherwise resolve the PR from the branch you are on:
     `gh pr view --json body,number,headRefOid` (no argument = the current
     branch's PR). Never search for it with `gh pr list`.
- The GitHub MCP (`mcp__github__*`) is not guaranteed to be mounted; check what
  is available and fall back to `gh`.

### Your environment is already set up: do NOT re-create it

- **The server under test is the PR's Vercel preview deployment**, mounted as
  the `mural-mcp-dev` MCP server and already authenticated. Its tools are loaded
  as `mcp__mural-mcp-dev__*`. Calling them *is* exercising the server: no build,
  no install, no local server, no deployment.
- **Do not go looking for tokens, the Mural client secret or the deployment URL**
  to "set things up". If a tool returns a 401 or a connection error, that is a
  `BLOCKED` finding to report, not a cue to wire auth.
- **Name the code you validated.** Record the PR head SHA (`headRefOid` above).
  If the plan or the PR's Vercel check shows the preview was built from another
  commit, report that before running anything: the run would validate the wrong
  code.

## Protocol

1. **Record what you're testing**: the commit SHA, and the preview deployment it
   was built from when the plan says how to see it.
2. **Set up observation** as the plan says.
3. **Run each scenario in order.** Create only the disposable state the plan
   describes (a mural titled `[MCP validation] …`), make the exact
   `mcp__mural-mcp-dev__*` tool call(s), and capture the **actual** observable:
   tool result or error, log line, browser state.
4. **Compare to expected.** Mark a scenario `OK` only if the actual observable
   matches the plan's expected one. Anything else is `FAIL`, or `BLOCKED` if a
   prerequisite was unavailable (say which).
5. **Clean up** what the run created, as the plan says. Report anything you
   could not delete.
6. **Don't fix, don't massage.** Never edit the code to make a scenario pass,
   never round a partial or ambiguous result up to OK.

## Reporting

Post the report as a **PR comment** in **English** (`gh pr comment` on the
current branch, or `mcp__github__add_issue_comment` if mounted). Without GitHub
write access, output the full report for the human to paste. Structure:

```markdown
## Functional validation report: <commit SHA>

Run by: independent validator session (did not write the code)

| ID | Verdict | Evidence |
| -- | ------- | -------- |
| S1 | OK      | `get-mural-widgets` returned `widgets[]` with `id`, `type`, `text`; `next` cursor present |
| S2 | FAIL    | expected an error payload with `status: 404`, got `status: 500` |
| S3 | BLOCKED | `mural-mcp-dev` not connected in this session |

## Summary

<green, or the failing/blocked IDs with a one-line why>
```

Per-row evidence must let the author verify without re-running: the field
names, error codes, counts, the shape of the payload. Concrete means the
**structure**, *not* the live values (see next).

### Redact real data: murals hold personal content

The server under test talks to a **real Mural account**. Tool outputs carry
personal and confidential data: member names and emails, workspace and room
names, mural titles, sticky note and text box content, comments, image and
file URLs, export download links (signed URLs grant access to the file). The
repository is **public**, so **never paste real data into a report**.

- Replace every real value with a placeholder that keeps only what the scenario
  tests: `<redacted>`, `<member name>`, `<mural title>`, `<signed url>`, `<int>`.
  Keep field *names*, types, counts and error codes.
- Opaque ids (mural, widget, room ids) may be kept when a scenario needs them for
  reproduction, but never next to the name, title or content they belong to.
- The disposable objects you created yourself (titles prefixed
  `[MCP validation]`) are not personal data; their content may be quoted.
- This applies to **every** outbound channel: the PR comment, output pasted for
  a human, scratch files, quoted log lines.
- If the harness blocks a post for sensitive content, that is a correct catch:
  redact and repost.

## Hard rules

- Faithful reporting over a green result. A wrong "OK" is worse than an honest
  FAIL.
- Validate behaviour against the plan's expectations, not against the
  implementer's explanation of why it should work.
- Report the run, nothing else: one `Run by:` line, no meta-commentary.
- Real tools only (`mcp__mural-mcp-dev__*`), disposable state only.
- One report per run, naming the commit SHA. After a fix, post a fresh report
  against the new SHA rather than editing the old one.
