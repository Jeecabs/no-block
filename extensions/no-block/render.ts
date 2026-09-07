import {
  type AgentToolResult,
  createBashToolDefinition,
  highlightCode,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  plainTextForDisplay,
  truncateForDisplay,
} from "../shared/display-text";
import {
  type DisplayLogLine,
  renderLogLine,
  renderLogLineWrap,
} from "../shared/log-line";
import { wrapToWidth } from "../shared/truncate";
import { LineComponent, LinesComponent } from "../shared/ui";
import {
  type PythonCommand,
  recognizePython,
  startsWithPython,
} from "./python-command";
import type { NoBlockDetails, RunPhase } from "./run-details";

interface RenderArgs {
  command?: string;
  name?: string;
  timeout?: number;
}
type Result = AgentToolResult<NoBlockDetails | undefined>;
type NativeDefinition = ReturnType<typeof createBashToolDefinition>;
interface RenderState {
  command?: string;
  python?: PythonCommand;
  result?: Result;
  nativeCall?: Component;
  nativeResult?: Component;
  native?: {
    startedAt: number | undefined;
    endedAt: number | undefined;
    interval: NodeJS.Timeout | undefined;
  };
}
type Context = Omit<
  Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
  "state" | "args"
> & {
  state: RenderState;
  args: RenderArgs;
};
const EMPTY_OUTPUT_LINES = new Set(["", "(no output)"]);
const PHASE_LABELS: Record<RunPhase, string> = {
  foreground: "running",
  background: "background",
  completed: "✓",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
};

/** Use Pi's tool shell for both Python and native Bash content. */
export function createNoBlockRenderers() {
  const native = createBashToolDefinition(process.cwd());
  return {
    renderCall(args: RenderArgs, theme: Theme, context: Context): Component {
      if (usePythonView(args, context))
        return buildPythonCall(args, theme, context);
      return buildNativeCall(native, args, theme, context);
    },
    renderResult(
      result: Result,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: Context,
    ): Component {
      context.state.result = result;
      if (context.state.python)
        return buildPythonResult(result, options, theme, context);
      return buildNativeResult(native, result, options, theme, context);
    },
  };
}

function usePythonView(args: RenderArgs, context: Context): boolean {
  const command = args.command ?? "";
  const complete =
    context.argsComplete || context.executionStarted || !context.isPartial;
  if (!complete) return startsWithPython(command);
  if (context.state.command !== command) {
    context.state.command = command;
    context.state.python = recognizePython(command);
  }
  return context.state.python !== undefined;
}

function buildPythonCall(
  args: RenderArgs,
  theme: Theme,
  context: Context,
): Component {
  const call = new Container();
  call.addChild(
    new LineComponent((width) => buildHeader(args, context, theme, width)),
  );
  const python = context.state.python;
  if (!context.expanded || !python) return call;
  if (python.kind === "inline")
    call.addChild(buildSource(python.source, "python", theme));
  call.addChild(
    new LineComponent((width) =>
      theme.fg("dim", truncateForDisplay("Original command", width)),
    ),
  );
  call.addChild(buildSource(args.command ?? "", "bash", theme));
  return call;
}

function buildNativeCall(
  native: NativeDefinition,
  args: RenderArgs,
  theme: Theme,
  context: Context,
): Component {
  const state = context.state;
  const component =
    native.renderCall?.(
      { ...args, command: args.command ?? "" },
      theme,
      getNativeContext(context, state.nativeCall),
    ) ?? new Container();
  state.nativeCall = component;
  return component;
}

function buildNativeResult(
  native: NativeDefinition,
  result: Result,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: Context,
): Component {
  const state = context.state;
  const component =
    native.renderResult?.(
      result,
      options,
      theme,
      getNativeContext(context, state.nativeResult),
    ) ?? new Container();
  state.nativeResult = component;
  return component;
}

function buildPythonResult(
  result: Result,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: Context,
): Component {
  const run = result.details?.noBlock;
  if (!options.expanded && run?.phase === "background") {
    return new LineComponent((width) =>
      theme.fg(
        "muted",
        truncateForDisplay(
          `${run.processId}: No Block will report its exit`,
          width,
        ),
      ),
    );
  }
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const lines = text.split("\n");
  const displayed = options.expanded
    ? lines
    : previewLines(lines, context.isError);
  const body = new Container();
  for (const line of displayed) {
    const entry: DisplayLogLine = {
      type: context.isError ? "stderr" : "stdout",
      text: line,
    };
    body.addChild(
      new LinesComponent((width) =>
        options.expanded && width >= 4
          ? renderLogLineWrap(entry, { theme, width })
          : [renderLogLine(entry, { theme, width })],
      ),
    );
  }
  if (options.expanded)
    body.addChild(buildLogReferences(result.details, theme));
  return body;
}

function buildLogReferences(
  details: NoBlockDetails | undefined,
  theme: Theme,
): Component {
  const block = new Container();
  if (details?.noBlock?.version !== 1) return block;
  for (const file of [details.noBlock.stdoutFile, details.noBlock.stderrFile]) {
    block.addChild(
      buildWrappedLine(theme.fg("dim", plainTextForDisplay(file))),
    );
  }
  return block;
}

function getNativeContext(context: Context, lastComponent?: Component) {
  context.state.native ??= {
    startedAt: undefined,
    endedAt: undefined,
    interval: undefined,
  };
  return {
    ...context,
    args: { ...context.args, command: context.args.command ?? "" },
    state: context.state.native,
    lastComponent,
  };
}

function runStatus(
  run: NoBlockDetails["noBlock"] | undefined,
  context: Context,
): string {
  if (run?.version !== 1) return context.isError ? "failed" : "";
  if (context.isError && run.phase === "completed") return "failed";
  if (run.phase === "foreground" && !context.isPartial) return "interrupted";
  const label = PHASE_LABELS[run.phase] ?? "unknown";
  return label + elapsedLabel(run);
}

function elapsedLabel(run: NoBlockDetails["noBlock"]): string {
  if (
    run.endedAt === null ||
    !Number.isFinite(run.endedAt) ||
    !Number.isFinite(run.startedAt)
  )
    return "";
  return ` ${Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1)}s`;
}

function buildHeader(
  args: RenderArgs,
  context: Context,
  theme: Theme,
  width: number,
): string {
  const python = context.state.python;
  const title =
    args.name || (python?.kind === "file" ? python.path : "inline script");
  const run = context.state.result?.details?.noBlock;
  const right = truncateForDisplay(runStatus(run, context), width);
  const space = width - visibleWidth(right) - 1;
  const color = context.isError
    ? "error"
    : run?.phase === "completed"
      ? "success"
      : "muted";
  if (space < 4) return theme.fg(color, right);
  const left = truncateForDisplay(`py ${title}`, space);
  return (
    theme.fg("toolTitle", left) +
    " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right))) +
    theme.fg(color, right)
  );
}

function buildSource(
  source: string,
  language: string,
  theme: Theme,
): Component {
  const block = new Container();
  const safe = source.split("\n").map(plainTextForDisplay).join("\n");
  for (const line of highlightCode(safe, language)) {
    block.addChild(buildWrappedLine(theme.fg("toolOutput", line)));
  }
  return block;
}

function buildWrappedLine(line: string): Component {
  return new LinesComponent((width) =>
    width < 4 ? [truncateForDisplay(line, width)] : wrapToWidth(line, width),
  );
}

function previewLines(lines: string[], isError: boolean): string[] {
  const nonempty = lines.filter(
    (line) => !EMPTY_OUTPUT_LINES.has(plainTextForDisplay(line).trim()),
  );
  if (
    isError &&
    lines.some((line) => line.includes("Traceback (most recent call last):"))
  ) {
    const reversed = nonempty.slice().reverse();
    const exception = reversed.find((line) =>
      /^[\w.]+(?::.*)?$/u.test(plainTextForDisplay(line)),
    );
    const location = reversed.find((line) =>
      /^\s*File ".*", line \d+/u.test(plainTextForDisplay(line)),
    );
    if (exception) return location ? [exception, location.trim()] : [exception];
  }
  return nonempty.slice(-3);
}
