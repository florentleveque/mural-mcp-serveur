# LEADING LLM ONLY: DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

Compact shapes come from `src/projections.ts`; a key whose value is absent,
null or empty is omitted, so a subset of the listed keys passes.

- **A1.** At least 1 workspace; keys exactly `id`, `name`.
- **A2.** More keys than A1 (the raw Mural object), `id` and `name` among them.
- **A3.** At least 1 room; keys within `id`, `name`, `type`, `workspaceId`.
- **A4.** At least 1 mural; keys within `id`, `title`, `status`, `roomId`,
  `workspaceId`, `infinite`, `updatedOn`, `_canvasLink`.
- **A5.** A count matching the mural (all pages followed); widget keys within
  `id`, `type`, `x`, `y`, `width`, `height`, `parentId` plus the content keys
  of its type (sticky note: `text`, `shape`, `backgroundColor`).
- **A6.** No error.

## Failure diagnostics

| If FAIL on | Likely cause | Where to look |
| --- | --- | --- |
| Any, with a 401 | The Mural token not carried, or the grant revoked | `src/app.ts` `requestTokenProvider`, Vercel runtime logs |
| Any, with a 403 scope message | A scope Mural did not grant | `check-user-scopes`, `src/mural-client.ts` `checkScope` |
| A1 to A5, keys | A projection drifted | `src/projections.ts` |
