---
pr: 18
writes: false
---

# 01: sign-in

Verify that Claude Code signs in to the preview server through its OAuth flow,
and that the connection then reaches Mural with the scopes Mural granted.

The browser part is done by the human who runs this session: ask them to
complete it and to tell you what each page showed. Never ask for, or record, a
password, a token or a cookie.

## Steps

1. Run `/mcp` and authenticate `mural-mcp-dev`. The human follows the browser
   pages. Ask them, and record:
   - whether the Mural sign-in (or Mural's own approval page) appeared;
   - whether a page of this server asked "Allow <client> to use your Mural
     account?", and the client name it showed;
   - whether `/mcp` then reports `mural-mcp-dev` as connected.
2. Call `mcp__mural-mcp-dev__test-connection` with `{}`.
3. Call `mcp__mural-mcp-dev__check-user-scopes` with `{}`.
4. Write `tests/functional/reports/01-sign-in.raw.json`: the two tool results
   as returned, with every personal value redacted (`<first name>`,
   `<last name>`, `<email>`, `<user id>`). Scope names are not personal data:
   keep them.
5. Write `tests/functional/reports/01-sign-in.report.md`: a short narrative of
   the sign-in, then the fence below, filled in.

## Assertions to record

Set `pass: true|false`, fill `actual` with what you observed, copy `desc`
verbatim. **Do not** look up expected values: `expected.md` is off-limits.

```json
{
  "scenario": "01-sign-in",
  "branch": "<branch>",
  "sha": "<git rev-parse HEAD>",
  "assertions": [
    { "id": "A1", "desc": "the browser went through Mural (sign-in or approval page)", "pass": null, "actual": null },
    { "id": "A2", "desc": "this server's consent page appeared, and the client name it showed", "pass": null, "actual": null },
    { "id": "A3", "desc": "/mcp reports mural-mcp-dev connected after the sign-in", "pass": null, "actual": null },
    { "id": "A4", "desc": "test-connection: value of connected", "pass": null, "actual": null },
    { "id": "A5", "desc": "check-user-scopes: the scopes list, and the missing list", "pass": null, "actual": null },
    { "id": "A6", "desc": "check-user-scopes: user is an object (not null) with id, firstName, lastName, email keys", "pass": null, "actual": null }
  ],
  "summary": "<one line: green / which IDs failed>"
}
```

## When done

1. In `tests/functional/STATE.md`, set this scenario to `done` and `holder` to
   `leading`.
2. `git add tests/functional/reports/01-sign-in.* tests/functional/STATE.md`,
   commit with `test(functional): run scenario 01-sign-in`, push.
3. Tell the leading LLM in chat.
