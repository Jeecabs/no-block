<p align="center">
  <img src="./assets/no-block-logo.png" alt="No Block mascot vaulting over a blocked terminal command" width="280">
</p>

# No Block

Run finite Bash jobs without blocking Pi while they finish.

No Block replaces Pi's Bash tool for commands that must return an exit code. Quick commands return normally. A slow command yields after 30 seconds, remains supervised, and reports its terminal result when it exits.

No Block builds on [aliou/pi-processes](https://github.com/aliou/pi-processes). It retains the process panel, bounded logs, process-group cleanup, stdin support, and log watches from that project.

## Choose the correct process lane

| Command type | Use |
| --- | --- |
| Tests, checks, migrations, exports, archives, and other finite jobs | No Block `bash` |
| Dev servers, watchers, local APIs, tunnels, port forwards, and log tails | A service process manager such as whiskd |
| Docker or Podman workloads | The native container lifecycle |

A finite job has a meaningful terminal result. An indefinite service is successful while it stays alive. Do not use No Block as a service manager.

## No Block and codemode

Pi's [codemode](https://pi.dev/docs/latest/cli#enable-codemode) lets the model write one JavaScript script that calls other tools. A script can run commands in parallel, chain results, and filter large output before it reaches the model. Codemode does not make commands run in the background. The script is a single tool call, and the agent waits until every awaited call inside it returns. Scripts have no timers, so a script cannot wait for a job later.

No Block limits how long one shell command can hold the agent. The two tools solve different problems.

| You want to | Use |
| --- | --- |
| Run several commands at once or chain their results | codemode |
| Reduce large output before the model reads it | codemode |
| Keep a slow command from blocking the agent | No Block |
| Receive a long job's exit after the turn has moved on | No Block |

They work together. When codemode is active, scripts call No Block's `bash`. The call resolves to an object. `output`, `truncated`, `exit_code`, and `wall_time_seconds` match Pi's built-in Bash result. `status` and `process_id` describe the handoff:

```ts
type NoBlockBashResult = {
  status: "completed" | "running";
  process_id: string;
  output: string; // stdout and stderr, ANSI stripped, last 1 MiB
  truncated: boolean;
  exit_code: number | null; // null while running
  wall_time_seconds: number;
};
```

A non-zero exit resolves with its `exit_code`, as with the built-in Bash tool. A command that reaches `backgroundAfter` resolves with `status: "running"` and the output so far. The script continues. No Block reports the exit in one follow-up message, which the agent reads after the codemode call returns.

Known limits:

- `output` keeps the last 1 MiB. Pi's built-in Bash keeps the first and last 512 KiB. Use the `process` tool with `process_id` to read retained logs.
- The result has no `full_output_path`, unlike the built-in Bash result.
- Script calls render inside the codemode row. The compact Python view applies only to direct Bash calls.
- A timeout, a cancellation, or a command killed by a signal rejects the script call, as with the built-in Bash tool.

Without codemode, the model sees the same Bash results as before.

## Installation

No Block requires Pi 0.99.1 or later. Older Pi versions report a non-zero exit as a successful result.

From npm after the first release:

```bash
pi install npm:@jeecabs/no-block
```

From git:

```bash
pi install git:github.com/Jeecabs/no-block
```

## Bash behavior

The `bash` tool accepts these fields:

```ts
type BashInput = {
  command: string;
  name?: string;
  backgroundAfter?: number;
  timeout?: number;
};
```

- `command` is the finite shell command.
- `name` is an optional job name.
- `backgroundAfter` is the foreground wait in seconds. The default is `30`.
- `timeout` is a hard lifetime limit in seconds.

No Block starts every Bash job in the process manager.

If the job exits before `backgroundAfter`, Bash returns its output and exit status normally. No Block does not send a lifecycle notification because the tool result already reports the terminal state.

If the job is still running at `backgroundAfter`, Bash returns its process ID and log paths. The agent can continue other work. No Block sends one follow-up when the process exits.

A hard `timeout` remains active after background handoff. When it expires, No Block stops the process group and reports the terminal event once.

## Python output

Direct Python commands use a compact view inside the existing Bash tool. Virtualenv paths such as `.venv/bin/python` work too.

The collapsed view shows the job name, status, and up to three output lines. Expand the tool result to inspect inline source, the original command, output, and log paths.

No Block executes the original command without changes. Python uses the same foreground wait, timeout, cancellation, and background notifications as other Bash jobs. Compound commands and unsupported Python invocations keep the normal Bash view.

See [Python presentation](docs/python-presentation.md) for supported commands and limits.

## Completion delivery

No Block uses `followUp` for an unobserved background completion. It does not steer an active tool batch.

Lifecycle delivery uses explicit states:

```text
pending -> publishing -> published
             |
             +-> pending after a synchronous enqueue failure
```

A transient synchronous enqueue failure schedules a bounded retry. No Block marks a notification as published only after Pi accepts the message.

Pi does not provide a provider-turn acknowledgment. No Block can guarantee retryable message enqueue, not exactly-once model processing.

## Inspect a yielded job

Use `/no-block` to open the job panel. It shows running and recently finished finite jobs.

Use `/no-block:logs [id]` for retained output. Use `/no-block:kill [id]` to stop a job. Use `/no-block:clear` to remove finished entries and their log storage.

The model can use the inherited `process` tool to list jobs and inspect output. It can also write stdin, update log watches, stop jobs, and clear finished entries.

## Output and cleanup

No Block stores stdout, stderr, and combined logs. Each log file has a 64 MiB cap. Model-visible output remains bounded.

Commands run in detached POSIX process groups. A stop targets the full group. Session shutdown stops live jobs and removes temporary manager state.

No Block supports macOS and Linux. It does not support Windows.

## Configuration

Use `/no-block:settings` for inherited process settings. These settings control shell path, output limits, panel size, follow mode, dock behavior, and the optional status widget.

The inherited background-command interception option blocks shell patterns such as `&`, `nohup`, `disown`, and `setsid`. Keep service-shaped routing in the separate service manager integration.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
```

The package uses TypeScript, Node.js 22.19 or newer, pnpm, Biome, Vitest, and Changesets.

## Upstream and license

No Block is a fork of [`@aliou/pi-processes`](https://github.com/aliou/pi-processes). The original process manager, user interface, protocol, and documentation structure remain under the MIT license.

No Block is also MIT licensed.
