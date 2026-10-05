# LEADING LLM ONLY: DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **A1.** Yes. Every authorization signs in to Mural again
  (`src/auth/provider.ts`, `policyWithUpstreamLogin`); with a live Mural
  session and the app already approved, Mural may redirect at once, which the
  human may see as a brief flash: still a pass if the flow went on.
- **A2.** Yes, naming `Claude Code`. Claude Code's CIMD client has loopback
  redirect URIs, so it is not a trusted client and sees the page
  (`src/auth/trusted-clients.ts`). A remembered approval (same account, client
  and redirect URIs, under 90 days) skips it: then a pass only if the human
  approved it in an earlier run.
- **A3.** Connected.
- **A4.** `connected: true`.
- **A5.** `scopes` lists what Mural granted; with every scope ticked in the
  Mural app and approved: `workspaces:read`, `rooms:read`, `rooms:write`,
  `murals:read`, `murals:write`, `templates:read`, `templates:write`,
  `identity:read` (any order), and `missing: []`.
- **A6.** An object with those four keys (values redacted).

## Failure diagnostics

| If FAIL on | Likely cause | Where to look |
| --- | --- | --- |
| A1 to A3 | A Vercel 401 on an OAuth request (protection bypass header not sent), a redirect URL missing in the Mural app, or the issuer not matching the branch address | `docs/live-testing.md`, Vercel runtime logs, `resolveIssuer` in `src/app.ts` |
| A5 | Mural's callback without `scopes`, or the claim not carried | `src/auth/interactions.ts`, `src/auth/provider.ts` `extraTokenClaims` |
| A6 | `identity:read` not granted, or `/users/me` failing | `src/tools/utilities.ts` |
