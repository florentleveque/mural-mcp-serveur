---
pr: 18
writes: true
---

# 04: write

Verify write tools end to end through the preview server, on a disposable
mural that the scenario creates and deletes. Run it in a session where
`mural-mcp-dev` is connected.

Record **structure only**: ids, keys, counts, statuses and error codes stay;
the signed download URL becomes `<signed url>` (keep only its scheme and host).

## Steps

1. Ask the human for an **open** room where you may create a mural (its id).
   Mural's free plan allows 3 murals per workspace: if creation is refused for
   that reason, record the error code and stop, with the remaining assertions
   marked `BLOCKED`.
2. `mcp__mural-mcp-dev__create-mural` with
   `{"roomId": <room id>, "title": "[MCP validation] 04-write"}`. Record the
   mural id and the keys of the result.
3. `mcp__mural-mcp-dev__create-sticky-notes` on that mural with one note:
   `{"x": 100, "y": 100, "text": "validation"}`. Record the widget id.
4. `mcp__mural-mcp-dev__get-mural-widgets` on the mural. Record the count and
   the `text` of the note.
5. `mcp__mural-mcp-dev__update-sticky-note` with `{"text": "validation updated"}`
   as `updates`, then `get-mural-widgets` again: record the note's `text`.
6. `mcp__mural-mcp-dev__export-mural` with `"downloadFormat": "pdf"`. Record
   the export id. Then call `mcp__mural-mcp-dev__download-export` with it until
   `ready` is true (at most 10 calls, a few seconds apart). Record each
   `ready` value and the URL's scheme and host.
7. `mcp__mural-mcp-dev__delete-widget` on the note, then `get-mural-widgets`:
   record the count.
8. `mcp__mural-mcp-dev__delete-mural` on the mural. Then
   `mcp__mural-mcp-dev__get-board` with its id: record the error (status and
   code).
9. Write `tests/functional/reports/04-write.raw.json` with the tool results,
   redacted as above, and `tests/functional/reports/04-write.report.md` with
   the fence below, filled in.

If a step fails, still run step 8 so the mural does not stay behind, and say
so in the report.

## Assertions to record

Set `pass: true|false` (or `"BLOCKED"`), fill `actual`, copy `desc` verbatim.
**Do not** look up expected values: `expected.md` is off-limits.

```json
{
  "scenario": "04-write",
  "branch": "<branch>",
  "sha": "<git rev-parse HEAD>",
  "assertions": [
    { "id": "A1", "desc": "create-mural: a mural id, and the keys of the result", "pass": null, "actual": null },
    { "id": "A2", "desc": "create-sticky-notes: a widget id", "pass": null, "actual": null },
    { "id": "A3", "desc": "get-mural-widgets after creation: count, and the note's text", "pass": null, "actual": null },
    { "id": "A4", "desc": "the note's text after update-sticky-note", "pass": null, "actual": null },
    { "id": "A5", "desc": "download-export: ready values in order, and the URL's scheme and host", "pass": null, "actual": null },
    { "id": "A6", "desc": "get-mural-widgets count after delete-widget", "pass": null, "actual": null },
    { "id": "A7", "desc": "get-board after delete-mural: status and error code", "pass": null, "actual": null }
  ],
  "summary": "<one line: green / which IDs failed or were blocked>"
}
```

## When done

1. In `tests/functional/STATE.md`, set this scenario to `done` and `holder` to
   `leading`.
2. `git add tests/functional/reports/04-write.* tests/functional/STATE.md`,
   commit with `test(functional): run scenario 04-write`, push.
3. Tell the leading LLM in chat.
