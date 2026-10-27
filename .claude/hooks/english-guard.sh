#!/bin/sh
# GitHub content is written in English (AGENTS.md). Deny a GitHub write whose
# text looks French: an accented letter or a common French function word.
# Covers the GitHub MCP write tools and `gh pr|issue create|edit|comment|review`,
# including a body passed with --body-file / -F.
set -eu

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name')

if [ "$tool" = Bash ]; then
  text=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
  printf '%s' "$text" |
    grep -qE '(^|[^[:alnum:]_-])gh[[:space:]]+(pr|issue)[[:space:]]+(create|edit|comment|review)([^[:alnum:]_-]|$)' ||
    exit 0
  body_file=$(printf '%s' "$text" |
    grep -oE -- '(--body-file|[[:space:]]-F)(=|[[:space:]]+)[^[:space:];&|]+' |
    head -n 1 | sed -E 's/^[[:space:]]*(--body-file|-F)(=|[[:space:]]+)//; s/^["'\'']//; s/["'\'']$//' || true)
  if [ -n "$body_file" ]; then
    case "$body_file" in
      /*) ;;
      *) body_file="$(printf '%s' "$input" | jq -r '.cwd')/$body_file" ;;
    esac
    [ -r "$body_file" ] && text="$text $(cat "$body_file")"
  fi
else
  text=$(printf '%s' "$input" |
    jq -r '[.tool_input.title, .tool_input.body] | map(select(type=="string")) | join(" ")')
fi

if printf '%s' "$text" | grep -qiP '(*UTF)(*UCP)\b(avec|sans|donc|nous|vous|votre|notre|cette|dans|leur|une|aux|qui|que|mais|ses|alors|ainsi|aussi|chez|vers|selon|comme|cela)\b|[\x{e9}\x{e8}\x{ea}\x{e0}\x{e2}\x{e7}\x{f9}\x{fb}\x{fc}\x{f4}\x{ee}\x{ef}\x{eb}\x{0153}]'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"GitHub content appears to be in French. Project rule (AGENTS.md): issues, PRs, comments and reviews are written in English. Rewrite the text in English and retry."}}'
fi
