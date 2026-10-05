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

No scenario yet: the first ones arrive with the remote HTTP server (PR #18).

| Scenario | Status | Last update |
| -------- | ------ | ----------- |
