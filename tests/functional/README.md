<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

# Functional test harness

End-to-end behavioural tests for the MCP server, driven by **two LLMs
communicating through committed files**. They validate what unit tests cannot
reach: the `tools/list` an MCP client actually receives, real `tools/call`
round-trips against Mural, the OAuth flow a client goes through.

Nothing here runs in CI or under Vitest (`vitest.config.ts` loads only
`tests/unit/`), and the mutation baseline cache key exempts this directory.

## Roles

| Role | Session | Reads | Writes |
| --- | --- | --- | --- |
| **Leading LLM** | Any session that does not call the server | `scenarios/<slug>/spec.md`, `scenarios/<slug>/expected.md`, reports | `STATE.md`, `reports/<slug>.verdict.md`, optional code fixes |
| **Executing LLM** | A Claude Code session connected to the server under test | `scenarios/<slug>/spec.md`, `STATE.md` | `reports/<slug>.raw.json`, `reports/<slug>.report.md`, `STATE.md` |

`scenarios/` is read-only for the executor. `reports/` is the communication
channel. `STATE.md` is shared, but its `holder` field is a narrative lock: only
the holder pushes.

**Critical:** the executor must NOT open `expected.md`. It encodes the verdict
criteria; seeing it would bias the report.

The leading LLM follows the `functional-testing` skill (`/functional-testing`).

## The server under test

The PR's Vercel preview deployment, reached through the `mural-mcp-dev` entry of
the project `.mcp.json` and authenticated through its OAuth flow in the
executor's session. Each `spec.md` states which tools it calls and what to
capture; the executor never builds or starts a server.

## Personal data

Murals hold real people's content, and this repository is public. Reports are
committed, so they carry **structure, never live values**: field names, types,
counts and error codes stay; member names, emails, mural titles, widget content
and signed URLs are replaced by placeholders. Scenarios that write create their
own mural, titled `[MCP validation] <slug>`, and delete it at the end. The full
redaction rule is in the `run-validation-plan` skill.

## Adding a scenario

1. Create `scenarios/<NN>-<slug>/spec.md` with frontmatter:

   ```yaml
   ---
   pr: <number>
   writes: true | false   # whether the scenario creates Mural objects
   ---
   ```

2. Body of `spec.md`: the exact tool calls to make, the disposable state to
   create and delete, the artifacts to write, and the assertion fence template
   (IDs and descriptions, no expected values).
3. Create `scenarios/<NN>-<slug>/expected.md` with a header banner telling the
   executor not to open it, then the expected value per assertion ID.
4. Append a row to `STATE.md` with status `pending`.
5. Invoke the leading LLM with `/functional-testing <NN-slug>` (or `all`).

## Cleaning between runs

`reports/<slug>.*` are committed. Between PRs, clear them with:

```sh
rm tests/functional/reports/*.json tests/functional/reports/*.md
```
