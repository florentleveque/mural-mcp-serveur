# LEADING LLM ONLY: DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

The reference is `tests/unit/fixtures/tools-list.json` at the tested SHA: the
`tools/list` answer the server exposes, checked by
`tests/unit/tool-schemas.test.ts`.

- **A1.** The length of `.tools` in the fixture.
- **A2.** Set equality with `.tools[].name` of the fixture. Order is not
  asserted (the client may reorder).
- **A3 to A5.** Each parameter of the tool's `inputSchema.properties` in the
  fixture, with its type, and `required` exactly as the fixture's `required`.
  `download-export` has no `outputPath` (it returns the URL).
- **A6.** An error result (`isError`): the schemas are closed
  (`additionalProperties: false`), and the SDK rejects the unknown key before
  the handler runs. Its text starts with `Input validation error: Invalid
  arguments for tool list-workspaces`. If the client itself refused to send
  the call, A6 is inconclusive, not a failure.

## Failure diagnostics

| If FAIL on | Likely cause | Where to look |
| --- | --- | --- |
| A1, A2 | A tool missing from the registry, or the client filtering tools | `src/tools/registry.ts` |
| A3 to A5 | The exposed schema drifted from the fixture | `src/tools/*.ts`, `tests/unit/tool-schemas.test.ts` |
| A6 | An open object schema (`z.object` instead of `z.strictObject`) | `src/tools/workspaces.ts` |
