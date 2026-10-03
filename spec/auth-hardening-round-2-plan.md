# Auth Hardening, Round 2 — Implementation Plan

Tracks issue #14 (follow-up to #1 / PR #13). Scope: `src/oauth.ts`, `src/mural-client.ts`, `src/types.ts` and their unit tests. No new MCP tool, no new dependency.

## Delivery

One PR, three commits so each can be reviewed on its own:

1. `docs(spec)`: this plan.
2. `fix(oauth)`: token lifecycle — 401 retry (§1), token response validation (§2), atomic write + re-read (§3).
3. `fix(oauth)`: callback server — loopback binding, static pages, state handling, `redirectUri`-derived port/path, timeout cleanup (§4).

Each commit keeps `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

---

## 1. Retry once on HTTP 401

### `src/oauth.ts`

- New field `private rejectedAccessToken: string | null = null`.
- New public method `invalidateAccessToken(token: string): void` — stores `token` in `rejectedAccessToken`.
- New private helper `isUsable(tokens, marginMs)`: `tokens.access_token !== this.rejectedAccessToken && Number.isFinite(tokens.expires_at) && tokens.expires_at > Date.now() + marginMs`.
- `performAuthentication` uses `isUsable` everywhere it currently checks `expires_at`:
  - fast path (stored token valid → return it);
  - refresh-failure fallback ("still-valid stored token") — must **not** return the rejected token, otherwise a revoked token is served back forever.
- A rejected token never needs to be "un-rejected": any new token differs from it.

### `src/mural-client.ts` — `makeAuthenticatedRequest`

- Per-request flag `let authRetried = false` declared before the loop.
- After `fetch`, before the generic `!response.ok` branch:

  ```ts
  if (response.status === 401 && !authRetried) {
    authRetried = true;
    this.oauth.invalidateAccessToken(accessToken);
    attempt--; // the auth retry must not consume a 5xx/network retry
    continue;
  }
  ```

- Guard against the `globalAuthPromise` dedupe handing back the token that was just rejected (a call already in flight when the 401 came in): in the loop, if `authRetried && accessToken === rejectedToken`, throw `MuralApiError(401, ...)` instead of sending it again.
- A second 401 falls through to the existing branch → `MuralApiError(401)` (non-retryable), unchanged behaviour.
- **403 is untouched**: a refresh cannot widen scopes.
- Replaying is safe: bodies are strings (`JSON.stringify`), and a 401 is rejected before the request is processed.
- The retry re-goes through the rate limiter (one extra token consumed) — acceptable and keeps accounting honest.
- Out of scope: `debugWorkspacesAPI` (debug tool that bypasses `makeAuthenticatedRequest`).

### Resulting flow on 401

`getAccessToken()` → `performAuthentication()`:

1. file holds a different, valid token (another process refreshed) → used, **no network call**;
2. else refresh with the stored `refresh_token`;
3. else interactive browser flow (correct for a truly revoked grant).

### Tests (`tests/unit/mural-client.test.ts`, `tests/unit/oauth.test.ts`)

- 401 → 200: one invalidation, request replayed, result returned.
- 401 → 401: throws `MuralApiError` with `status: 401` after exactly one replay.
- 403: no invalidation, no replay.
- 401 while the token file holds a different valid token: replay uses it, no `/token` call.
- `performAuthentication` with a rejected token still "valid" by `expires_at`: refresh attempted; on refresh failure, rejected token is **not** returned.

---

## 2. Validate token responses and the token file

### `normalizeTokenResponse(data: unknown, previousRefreshToken?: string): OAuthTokens`

Module-level (exported for tests), used by both `exchangeCodeForTokens` and `refreshAccessToken`:

1. `access_token` must be a non-empty string → otherwise `throw new Error('OAuth token response is missing access_token')`.
2. `expires_at`, first match wins:
   - `expires_in` coerced with `Number()`, accepted if finite and `> 0`;
   - the JWT `exp` claim of `access_token` (decode the payload segment as base64url JSON; accept if finite and in the future);
   - fallback: 5 minutes, with `console.warn` (stderr) explaining the token lifetime is unknown.
3. `expires_in` is rewritten with the normalised value so the stored file stays consistent.
4. `refresh_token ??= previousRefreshToken` (moves the existing PR #13 logic here).
5. `token_type` defaults to `'Bearer'` when absent.

The JWT decoding currently inlined in `MuralClient.getUserScopes` moves to a small shared helper `decodeJwtPayload(token): Record<string, unknown> | null` (in `oauth.ts`), reused by both.

Both `/token` calls share a private `postTokenRequest(params, label)` to remove the duplicated fetch/error handling. Its error carries the OAuth `error` code (`OAuthTokenError` with an `error` field) so §3 can detect `invalid_grant` without matching on message text.

### `loadTokens`

- Parse failure or missing / empty `access_token` → `null` (unchanged contract for callers).
- `expires_at` not finite (e.g. `null` persisted by the `NaN` bug) → keep the object; `isUsable` treats it as expired, so the next call refreshes **once** and persists a sane `expires_at`. This self-heals files written by older versions.

⚠️ Assumption: whether Mural always sends `expires_in` is unverified; for well-formed responses this is a no-op.

### Tests

- Missing `expires_in`, JWT with `exp` → `expires_at === exp * 1000`.
- Missing `expires_in`, opaque token → now + 5 min, warning on stderr.
- `expires_in: "3600"` (string) → coerced.
- `expires_in: 0` / negative / `NaN` → falls through to JWT / default.
- Empty `access_token` → throws, nothing written.
- Token file without `access_token` → `getStoredTokens()` returns `null`.
- Token file with `expires_at: null` → refreshed once, then served from the file.

---

## 3. Concurrent token file access

### 3A. Atomic write — `saveTokens`

```ts
const tmp = `${TOKEN_FILE_PATH}.${process.pid}.tmp`;
await fs.rm(tmp, { force: true }); // a stale tmp may predate 0o600
await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600, flag: 'wx' });
await fs.rename(tmp, TOKEN_FILE_PATH);
```

- `wx` guarantees the file is created by this call, so `mode: 0o600` applies — no world-readable window (closes the PR #13 review note).
- `rename` is atomic on the same filesystem (tmp lives next to the target, so same filesystem by construction): readers see the old or the new file, never a truncated one.
- On any failure: best-effort `fs.rm(tmp, { force: true })`, then throw `Failed to save authentication tokens` (unchanged message).
- The best-effort `chmod` from PR #13 is no longer needed for new writes (the replaced file inherits the tmp's mode); it is dropped.
- **Windows**: `rename` over an existing file can fail with `EPERM`/`EBUSY` when another process has it open (antivirus, another server reading). Retry the rename up to 3 times with a short delay (50 / 100 / 200 ms) before failing.

### 3B. Re-read around refresh — `performAuthentication`

1. Before calling `/token` with `refresh_token`: re-read the file. If it now holds a usable token (another process refreshed meanwhile) → return it, no network call.
2. If the refresh fails with `invalid_grant`: re-read once more. If the file holds a usable token → return it; else fall back to the browser flow (current behaviour).
3. No lock file for now (more code, stale-lock edge cases). Revisit only if refresh-token rotation is confirmed (open question 1).

### Tests

- `saveTokens` writes `<path>.<pid>.tmp` with `{ mode: 0o600, flag: 'wx' }` then renames onto the final path.
- Write failure → tmp removed, error thrown, final file untouched.
- `rename` fails once with `EPERM` then succeeds → tokens saved.
- File refreshed by "another process" between the first read and the refresh → no `/token` call.
- `invalid_grant`, re-read file holds a valid token → that token is used, no callback server started.

`tests/unit/oauth.test.ts` mock of `fs/promises` gains `rename` and `rm`.

---

## 4. Local callback server

`startCallbackServer` is rewritten around a small internal helper so it can be tested against a real HTTP server on an ephemeral port.

### 4d. Port and path from `redirectUri`

`parseRedirectUri(this.redirectUri)` returns `{ hosts, port, pathname }`:

- protocol must be `http:` — otherwise throw a clear error (the local server cannot terminate TLS);
- `port` = explicit port, or `80`;
- `pathname` = the URI path (`/callback` by default);
- `hosts`: `localhost` → `['127.0.0.1', '::1']`; `127.0.0.1` → `['127.0.0.1']`; `[::1]` → `['::1']`; any other host → throw (a non-loopback redirect URI cannot be served by this process).

Defaults stay `http://localhost:3000/callback` → behaviour unchanged for existing setups. This honours the user's configured value; it does not introduce a dynamic port (decision from #1, point 5, still stands).

For tests, `startCallbackServer` accepts an optional `{ port?: number }` override; port `0` means "ephemeral" — the first listener binds port 0, the second reuses the port actually assigned.

### 4b. Loopback only, dual-stack

- One `http.Server` per host in `hosts`, all sharing the same request handler and the same settle logic.
- Listen errors per host:
  - `EADDRNOTAVAIL` / `EAFNOSUPPORT` on `::1` (IPv6 disabled, some WSL/Docker setups) → ignored as long as at least one listener is up;
  - `EADDRINUSE` on any host → reject (port taken, same as today).
- Startup log on stderr lists the bound addresses.
- ⚠️ Manual check required on macOS, Linux and Windows/WSL (browser resolving `localhost` to `::1` vs `127.0.0.1`).

### 4a. Static pages, no echo

- Fixed HTML bodies only (`success`, `error`, `invalid request`, `already processed`, `not found`) — no request parameter or `expectedState` is ever interpolated.
- Headers on every response: `Content-Type: text/html; charset=utf-8`, `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- stderr logging: `code: present/missing`, `state: match/mismatch` — never the values.
- The rejection error for a Mural `error` keeps the error code (it goes to stderr / the tool result, not to HTML), truncated to 100 chars and restricted to `[\w.-]`.

### 4c. Invalid requests do not end the flow

Handler logic, path matched exactly (`url.pathname === pathname`, not `startsWith`):

| Request                       | Response | Flow                          |
| ----------------------------- | -------- | ----------------------------- |
| other path                    | 404      | keeps waiting                 |
| already settled               | 200      | —                             |
| `state` missing or ≠ expected | 400      | **keeps waiting**             |
| correct `state` + `error`     | 400      | rejects `OAuth error: <code>` |
| correct `state`, no `code`    | 400      | rejects                       |
| correct `state` + `code`      | 200      | resolves `{ code }`           |

`expectedState` becomes a required parameter (it is always passed today).

### 4e. Cleanup

A single `settle()` function: sets `resolved`, `clearTimeout(timeout)`, closes every listener, then resolves/rejects. The 5-minute timeout goes through it too.

### Tests (new `tests/unit/oauth-callback.test.ts`, real server on port 0)

- `?error=<script>…</script>&state=<expected>` → body contains no `<script`, CSP header present.
- Wrong `state` → 400, server still listening; then correct callback → resolves with the code.
- Server bound to loopback only (`server.address()` is `127.0.0.1` / `::1`).
- `parseRedirectUri`: `http://localhost:8080/cb` → port 8080, path `/cb`, both loopback hosts; `https://…` and non-loopback hosts throw.
- Timeout cleared on success (fake timers: no pending timer after resolution).

The comment in `oauth.test.ts` stating the callback server is out of unit-test scope is updated accordingly.

---

## Documentation

- `README.md`: `MURAL_REDIRECT_URI` now also drives the local callback port/path; must be an `http://` loopback URI registered in the Mural app.
- `CLAUDE.md`: OAuth handler section — "listens on the port/path of the redirect URI, loopback only"; atomic token file write.
- `CHANGELOG.md` is generated by the release workflow — not edited by hand.

## Open questions (real Mural account)

1. Does Mural rotate refresh tokens? → decides whether a lock file is ever needed (§3).
2. Is `expires_in` always present, and what is the access token lifetime? (§2)
3. What does a 401 body look like? Only for error messages; the retry keys on status 401 alone (§1).
