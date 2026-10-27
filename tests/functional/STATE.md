---
branch: feature/remote-http-vercel
current_run: none
holder: leading
---

# Functional test run state

`holder` is the narrative lock: only the holder pushes commits. Pass `holder` to
the other LLM before pushing. The leading LLM reads reports and writes verdicts;
the executing LLM runs scenarios and writes the raw and report artifacts.
Protocol: [`README.md`](README.md).

| Scenario | Status | Last update |
| -------- | ------ | ----------- |
| 01-sign-in | pending | 2026-10-05 |
| 02-tool-surface | pending | 2026-10-05 |
| 03-read | pending | 2026-10-05 |
| 04-write | pending | 2026-10-05 |
