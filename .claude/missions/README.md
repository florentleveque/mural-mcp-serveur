<!-- Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md). -->

# Missions

A mission is a self-contained brief for an agent that has access this session
lacks: a real Mural account, an admin role on a workspace, a browser. It settles
facts that the documentation leaves open and that a plan must not guess (an
undocumented field, a scope's real effect, an error code). One file per
mission: `<issue>-<kebab-slug>.md`.

## What a mission file states

- **For:** the access the agent needs.
- **Why:** the issue or plan it serves, and what goes wrong if the facts are
  guessed.
- **Deliverable:** a report posted as a comment on the named PR (or issue),
  answering every question by its identifier (Q1, Q2…), each with the exact
  request or tool call made, the status, the relevant part of the response
  (redacted), and a one-line verdict: **confirmed / refuted / inconclusive**.
  An inconclusive answer is a useful result; a plausible-sounding guess is not.
- **Questions**, each with its identifier.

## Ground rules every mission inherits

- **Do not modify the repository.** No commits, no pushes: the report comment is
  the whole output.
- **Read-only wherever possible.** A write that cannot be avoided goes to a
  disposable object titled `[MCP probe <issue>]`, whose id the report lists so
  it can be cleaned up. Never touch a pre-existing mural, room or setting.
- **Redact personal data.** Report the *shape* of a response, not its content:
  no member names, emails, mural titles or widget text (the repository is
  public). Opaque ids may stay when needed for reproduction.
- **Never print a secret**: tokens and the Mural client secret stay in
  variables, never in output.
