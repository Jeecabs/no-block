# Python presentation

No Block gives direct Python scripts a compact view inside its existing Bash tool. It does not add an executor or change command bytes.

## Supported commands

The interpreter can be `python`, `python3`, a versioned name such as `python3.12`, or a path to one. Examples include `.venv/bin/python`, `./.venv/bin/python3`, and `/opt/venv/bin/python`.

The command must contain one direct invocation with one of these script forms:

- `-c` with literal source.
- A quoted heredoc delimiter with standard input as the script.
- A literal `.py` path. No Block does not read the script file for presentation.

Recognition accepts common flags such as `-u`, `-B`, and `-I`. It rejects substitutions, environment assignments, pipelines, extra commands, and other redirects. Wrappers such as `uv run` and activation chains such as `source .venv/bin/activate && python script.py` keep the normal Bash view.

Recognition is conservative. An unsupported form still executes through the same Bash runner.

## Collapsed and expanded views

The header shows `py`, the supplied `name` or script path, and the run status. Inline scripts without a name use `inline script`.

The body shows up to three nonempty output lines. A Python traceback preview shows the exception and source location when available. Typical success results occupy two content rows. Pi adds its separator row.

Expansion shows highlighted inline source, the original command, captured output, and stdout and stderr log paths. Long lines wrap. Existing output and log limits still apply.

Printed results come from the script. A message such as `3 files updated` is not an independent check of file changes.

## Lifecycle and compatibility

Short scripts return through the foreground tool result. Live jobs that exceed the foreground wait show `background`, not success. No Block still owns their completion notification.

The tool result includes versioned `details.noBlock` metadata with the process ID, phase, timestamps, exit code, and log paths. Pi uses these details for display and session replay. They do not add text to model-visible output.

Thrown failures retain their metadata through a Bash-scoped `tool_result` hook. Historical results without this metadata do not receive a success status.

Ordinary Bash commands retain Pi's Bash renderer and framing. No Block does not create another panel or open an overlay. Session shutdown still stops live jobs.

## Code map

- `extensions/no-block/python-command.ts`: `recognizePython` classifies the original shell command without evaluation.
- `extensions/no-block/render.ts`: `createNoBlockRenderers` selects Python or native Bash presentation.
- `extensions/no-block/run-details.ts`: `buildRunDetails` captures process metadata.
- `extensions/no-block/index.ts`: `FiniteCommandRun` retains execution and notification ownership.
