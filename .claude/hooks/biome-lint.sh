#!/bin/sh
# Lint the file Claude just edited and apply the safe fixes. What is left goes
# back to Claude: a PostToolUse hook's stderr reaches it only on exit 2.
# Formatting and the `types` rules wait for pre-commit:
# docs/decisions/lint-tooling.md.
set -eu

file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  "$CLAUDE_PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR"
if ! out=$(pnpm exec biome lint --write --skip=types --error-on-warnings \
  --no-errors-on-unmatched --colors=off "$file" 2>&1); then
  printf '%s\n' "$out" >&2
  exit 2
fi
