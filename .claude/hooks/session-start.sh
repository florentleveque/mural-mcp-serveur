#!/bin/sh
# Adapted from fruggr/zendesk-mcp-server (MIT, see THIRD-PARTY-NOTICES.md).
set -eu

# Install dependencies at the start of a Claude Code on the web session so tests
# and linters work out of the box. Web-only: local sessions manage their own
# dependencies (and would re-run this on every start with no benefit).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# pnpm is pinned via package.json "packageManager"; Corepack selects that exact
# version rather than trusting whatever pnpm is on PATH.
#
# Plain install (not --frozen-lockfile): this is a dev bootstrap, so a session
# that adds or bumps a dependency should reconcile the lockfile rather than fail
# the way a CI install would. Lifecycle scripts are already governed by
# pnpm-workspace.yaml (`allowBuilds` and the `minimumReleaseAge` cooldown).
corepack enable >/dev/null 2>&1 || true
corepack pnpm install
