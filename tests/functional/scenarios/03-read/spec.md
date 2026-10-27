---
pr: 18
writes: false
---

# 03: read

Verify read tools end to end against the real Mural API through the preview
server: navigation from workspaces down to a mural's widgets, the compact
projection, and `verbose`. Run it in a session where `mural-mcp-dev` is
connected.

Murals hold real content: record **structure only**. Keep field names, types,
counts and ids; replace names, titles, texts, emails and URLs with
placeholders (`<workspace name>`, `<mural title>`, `<widget text>`, `<url>`).

## Steps

1. `mcp__mural-mcp-dev__list-workspaces` with `{}`. Record the count and the
   set of keys of one item.
2. Same call with `{"verbose": true}`. Record the set of keys of one item.
3. Pick a workspace from step 1 (ask the human which one if there are
   several). `mcp__mural-mcp-dev__list-workspace-rooms` with its id. Record the
   count and the set of keys of one item.
4. Pick a room that holds murals. `mcp__mural-mcp-dev__list-room-boards` with
   its id. Record the count and the set of keys of one item.
5. Pick a mural from step 4. `mcp__mural-mcp-dev__get-mural-widgets` with its
   id. Record the count, the set of `type` values, and the set of keys of one
   sticky note (or of any widget if there is none).
6. Write `tests/functional/reports/03-read.raw.json`: the tool results, redacted
   as above (ids may stay).
7. Write `tests/functional/reports/03-read.report.md` with the fence below,
   filled in.

## Assertions to record

Set `pass: true|false`, fill `actual`, copy `desc` verbatim. **Do not** look up
expected values: `expected.md` is off-limits.

```json
{
  "scenario": "03-read",
  "branch": "<branch>",
  "sha": "<git rev-parse HEAD>",
  "assertions": [
    { "id": "A1", "desc": "list-workspaces: count, and keys of one item", "pass": null, "actual": null },
    { "id": "A2", "desc": "list-workspaces verbose: keys of one item", "pass": null, "actual": null },
    { "id": "A3", "desc": "list-workspace-rooms: count, and keys of one item", "pass": null, "actual": null },
    { "id": "A4", "desc": "list-room-boards: count, and keys of one item", "pass": null, "actual": null },
    { "id": "A5", "desc": "get-mural-widgets: count, type values, keys of one widget", "pass": null, "actual": null },
    { "id": "A6", "desc": "any tool call returned an error (which, and its text)", "pass": null, "actual": null }
  ],
  "summary": "<one line: green / which IDs failed>"
}
```

## When done

1. In `tests/functional/STATE.md`, set this scenario to `done` and `holder` to
   `leading`.
2. `git add tests/functional/reports/03-read.* tests/functional/STATE.md`,
   commit with `test(functional): run scenario 03-read`, push.
3. Tell the leading LLM in chat.
