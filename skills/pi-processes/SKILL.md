---
name: no-block
description: Run finite Bash commands without blocking Pi. Use for tests, checks, migrations, exports, archives, and other jobs that must eventually return an exit code.
---

# No Block

Use `bash` for finite commands whose exit code matters.

A quick command returns normally. A slow command yields after its foreground wait and continues under No Block. No Block reports the terminal result later. Do not sleep or poll while a yielded job runs.

Use a service process manager for dev servers, watchers, tunnels, local APIs, port forwards, log tails, and other indefinite processes. An indefinite service is successful while it stays alive. No Block is for commands that must terminate.

## Bash

The Bash tool accepts:

```ts
type BashInput = {
  command: string;
  name?: string;
  backgroundAfter?: number;
  timeout?: number;
};
```

- You must provide `command`.
- `name` gives the finite job a stable display name.
- `backgroundAfter` sets the foreground wait in seconds. The default is `30`.
- `timeout` sets a hard lifetime limit in seconds.

The hard timeout remains active after background handoff.

Good finite jobs:

```text
pnpm test
pnpm lint
python migrate.py --dry-run
tar -czf release.tar.gz dist
```

Wrong lane:

```text
pnpm dev
vite --host
kubectl port-forward service/api 3000:3000
tail -f app.log
```

Route those commands to a service process manager.

## After Bash yields

Bash returns an opaque process ID and retained log paths. Continue useful independent work or end the turn.

Do not do this:

```text
sleep 10
process output
sleep 10
process output
```

No Block sends one follow-up after an unobserved background exit. A direct foreground Bash result suppresses the extra lifecycle notification.

## Process tool

Use the inherited `process` tool to inspect and control a yielded finite job.

### List

```json
{ "action": "list", "statuses": ["running"] }
```

Use the returned opaque ID for later actions.

### Output

```json
{
  "action": "output",
  "id": "proc_1",
  "stream": "stderr",
  "tailLines": 100
}
```

Use output for a targeted inspection. Do not turn it into a polling loop.

### Write stdin

```json
{ "action": "write", "id": "proc_1", "input": "yes\n" }
```

Close stdin with:

```json
{ "action": "write", "id": "proc_1", "end": true }
```

### Update a finite-job watch

Use a watch only for a specific actionable marker from a finite job:

```json
{
  "action": "update",
  "id": "proc_1",
  "watches": {
    "mode": "append",
    "items": [
      { "pattern": "fatal:", "mode": "literal", "stream": "stderr" }
    ]
  }
}
```

If a watch is noisy, replace or remove it. Do not restart the job only to change a watch.

### Stop

```json
{ "action": "stop", "id": "proc_1" }
```

Use stop when the finite job is obsolete or stuck.

### Clear finished records

```json
{ "action": "clear" }
```

Clear removes finished records and their retained log storage. It never removes a live job.

## Delivery rules

- Foreground completion returns through the Bash tool only.
- Background success sends one follow-up.
- Background failure or timeout sends one follow-up.
- Intentional stop becomes context and does not interrupt active work.
- A synchronous completion enqueue failure receives bounded retries.

Do not claim exactly-once model processing. Pi does not expose a provider-turn acknowledgment.
