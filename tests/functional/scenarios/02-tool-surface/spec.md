---
pr: 18
writes: false
---

# 02: tool surface

Verify the tools an MCP client receives from the preview server: names, and
the parameters of a few of them. Run it after `01-sign-in`, in a session where
`mural-mcp-dev` is connected.

## Steps

1. List every tool of `mural-mcp-dev` available to you (`mcp__mural-mcp-dev__*`).
   Record their names without the prefix, in the order you see them, and their
   count.
2. For `create-sticky-notes`, `update-mural` and `download-export`, record the
   input parameters you see: name, type, whether required.
3. Call `mcp__mural-mcp-dev__list-workspaces` with an unknown argument,
   `{"unknownField": true}`, and record the result: error or not, and its text.
4. Write `tests/functional/reports/02-tool-surface.raw.json` with what you
   recorded (no personal data appears in this scenario).
5. Write `tests/functional/reports/02-tool-surface.report.md` with the fence
   below, filled in.

## Assertions to record

Set `pass: true|false`, fill `actual`, copy `desc` verbatim. **Do not** look up
expected values: `expected.md` is off-limits.

```json
{
  "scenario": "02-tool-surface",
  "branch": "<branch>",
  "sha": "<git rev-parse HEAD>",
  "assertions": [
    { "id": "A1", "desc": "number of mural-mcp-dev tools", "pass": null, "actual": null },
    { "id": "A2", "desc": "tool names, without the prefix", "pass": null, "actual": null },
    { "id": "A3", "desc": "create-sticky-notes parameters (name, type, required)", "pass": null, "actual": null },
    { "id": "A4", "desc": "update-mural parameters (name, type, required)", "pass": null, "actual": null },
    { "id": "A5", "desc": "download-export parameters (name, type, required)", "pass": null, "actual": null },
    { "id": "A6", "desc": "list-workspaces with an unknown argument: error or not, and its text", "pass": null, "actual": null }
  ],
  "summary": "<one line: green / which IDs failed>"
}
```

## When done

1. In `tests/functional/STATE.md`, set this scenario to `done` and `holder` to
   `leading`.
2. `git add tests/functional/reports/02-tool-surface.* tests/functional/STATE.md`,
   commit with `test(functional): run scenario 02-tool-surface`, push.
3. Tell the leading LLM in chat.
