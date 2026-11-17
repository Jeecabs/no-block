---
"@jeecabs/no-block": patch
---

Report timed-out, cancelled, and signal-terminated commands as error results instead of thrown errors. The model sees the same message, the transcript keeps the run's phase and output, and codemode scripts receive the structured result with `exit_code: null`. This replaces an internal `tool_result` hook that patched details onto thrown failures.
