---
"@jeecabs/no-block": minor
---

Return structured Bash results for codemode scripts. Scripts now receive `{ status, process_id, output, truncated, exit_code, wall_time_seconds }` instead of text. A non-zero exit resolves with its exit code instead of rejecting the call. A job past its foreground wait resolves with `status: "running"`.

Target Pi 0.99.1. Older Pi versions report a non-zero exit as a successful result.
