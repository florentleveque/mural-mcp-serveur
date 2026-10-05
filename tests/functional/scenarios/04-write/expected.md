# LEADING LLM ONLY: DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **A1.** A mural id; compact keys within `id`, `title`, `status`, `roomId`,
  `workspaceId`, `infinite`, `updatedOn`, `_canvasLink`. A refusal for the
  plan's mural quota makes A1 to A7 `BLOCKED`, not `FAIL`.
- **A2.** One widget id.
- **A3.** Count 1; text `validation`.
- **A4.** `validation updated`.
- **A5.** Zero or more `false`, then `true`; an `https` URL on a storage host,
  fetched without authentication. `download-export` never writes a file.
- **A6.** Count 0.
- **A7.** HTTP 404, with the error code Mural sends for a missing mural: the mural is gone.

## Failure diagnostics

| If FAIL on | Likely cause | Where to look |
| --- | --- | --- |
| A1 to A7, 403 scope message | `murals:write` not granted | `check-user-scopes`, `src/mural-client.ts` `checkScope` |
| A5 | Pending export not mapped to `ready:false` | `src/mural-client.ts` `getExportUrl` |
| A7 | Deletion not reaching Mural | `src/tools/murals.ts` |
