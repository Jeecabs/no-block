import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isBashToolResult,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProcessManager } from "../../src/manager";
import type { ManagerEvent, ProcessInfo } from "../../src/types";
import { stripAnsi } from "../../src/utils";
import type { NotificationRegistry } from "../processes/notifications/registry";
import { createNoBlockRenderers } from "./render";
import { buildRunDetails, type NoBlockDetails } from "./run-details";

const DEFAULT_BACKGROUND_AFTER_SECONDS = 30;

const NoBlockParams = Type.Object({
  command: Type.String({ description: "Finite shell command to execute" }),
  name: Type.Optional(Type.String({ description: "Optional job name" })),
  backgroundAfter: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description:
        "Seconds to wait before the finite command continues in the background. Defaults to 30.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description:
        "Hard lifetime limit in seconds. The command is stopped when this limit expires.",
    }),
  ),
});

type NoBlockInput = {
  command: string;
  name?: string;
  backgroundAfter?: number;
  timeout?: number;
};

type RunOutcome =
  | { kind: "finished"; process: ProcessInfo }
  | { kind: "background" }
  | { kind: "timeout" }
  | { kind: "abort" };

type ProcessObservation = {
  promise: Promise<ProcessInfo>;
  dispose: () => void;
  suppressOutput: () => void;
};

export function registerNoBlockTool(
  pi: ExtensionAPI,
  manager: ProcessManager,
  notifications: NotificationRegistry,
): void {
  const failures = new Map<string, NoBlockDetails>();
  pi.on("tool_result", (event) => {
    if (!isBashToolResult(event)) return;
    const details = failures.get(event.toolCallId);
    failures.delete(event.toolCallId);
    if (details) return { details: { ...event.details, ...details } };
  });
  pi.on("session_shutdown", () => failures.clear());

  pi.registerTool({
    ...createNoBlockRenderers(),
    name: "bash",
    label: "bash",
    description:
      "Execute a finite shell command and return its exit result. Long commands can continue without blocking the agent.",
    promptSnippet:
      "Execute finite shell commands without blocking on slow jobs",
    promptGuidelines: [
      "Use bash for finite commands whose exit code matters. Use a service process manager for servers, watchers, tunnels, and other indefinite processes.",
    ],
    parameters: NoBlockParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const run = new FiniteCommandRun({
        params,
        manager,
        notifications,
        ctx,
        signal,
        onUpdate,
      });
      try {
        return await run.run();
      } catch (error) {
        const details = run.failureDetails();
        if (details) failures.set(toolCallId, details);
        throw error;
      }
    },
  });
}

class FiniteCommandRun {
  private process!: ProcessInfo;
  private observation!: ProcessObservation;
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private aborted = false;
  private detachAbort = () => {};

  constructor(
    private readonly deps: {
      params: NoBlockInput;
      manager: ProcessManager;
      notifications: NotificationRegistry;
      ctx: ExtensionContext;
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback<NoBlockDetails | undefined>;
    },
  ) {}

  failureDetails(): NoBlockDetails | undefined {
    if (!this.process) return undefined;
    const phase = this.timedOut
      ? "timed_out"
      : this.aborted
        ? "cancelled"
        : "failed";
    return buildRunDetails(
      outcomeProcess(this.deps.manager, this.process),
      phase,
    );
  }

  async run(): Promise<AgentToolResult<NoBlockDetails | undefined>> {
    if (this.deps.signal?.aborted) throw new Error("Command aborted");

    this.process = this.startProcess();
    this.deps.notifications.register(this.process.id, {
      completionDelivery: "tool",
    });
    if (isFinished(this.process)) {
      return formatFinishedResult(this.deps.manager, this.process);
    }

    this.observation = observeProcessEnd(
      this.deps.manager,
      this.process.id,
      () => this.publishOutput(),
    );
    this.deps.onUpdate?.({
      content: [],
      details: buildRunDetails(this.process, "foreground"),
    });

    const outcome = await Promise.race([
      this.observation.promise.then(
        (process): RunOutcome => ({ kind: "finished", process }),
      ),
      this.waitForBackground(),
      this.waitForTimeout(),
      this.waitForAbort(),
    ]);

    this.detachAbort();
    return this.settle(outcome);
  }

  private startProcess(): ProcessInfo {
    const { params, manager, ctx } = this.deps;
    return manager.start(
      params.name ?? defaultProcessName(params.command),
      params.command,
      ctx.cwd,
    );
  }

  private publishOutput(): void {
    this.deps.onUpdate?.({
      content: [
        {
          type: "text",
          text: formatProcessOutput(this.deps.manager, this.process),
        },
      ],
      details: buildRunDetails(this.process, "foreground"),
    });
  }

  private waitForBackground(): Promise<RunOutcome> {
    const seconds =
      this.deps.params.backgroundAfter ?? DEFAULT_BACKGROUND_AFTER_SECONDS;
    return new Promise((resolve) => {
      this.backgroundTimer = setTimeout(() => {
        this.deps.notifications.register(this.process.id, {
          completionDelivery: "notify",
          onSuccess: "turn",
          onFailure: "turn",
          onKilled: "turn",
          turnDelivery: "followUp",
        });
        resolve({ kind: "background" });
      }, seconds * 1_000);
      this.backgroundTimer.unref?.();
    });
  }

  private waitForTimeout(): Promise<RunOutcome> {
    const seconds = this.deps.params.timeout;
    if (seconds === undefined) return neverOutcome();

    return new Promise((resolve) => {
      this.timeoutTimer = setTimeout(() => {
        if (this.aborted) return;
        this.timedOut = true;
        this.clearBackgroundTimer();
        void this.deps.manager.kill(this.process.id).finally(() => {
          resolve({ kind: "timeout" });
        });
      }, seconds * 1_000);
      this.timeoutTimer.unref?.();
    });
  }

  private waitForAbort(): Promise<RunOutcome> {
    const signal = this.deps.signal;
    if (!signal) return neverOutcome();

    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.timedOut || this.aborted) return;
        this.aborted = true;
        this.clearBackgroundTimer();
        this.clearTimeoutTimer();
        void this.deps.manager.kill(this.process.id).finally(() => {
          resolve({ kind: "abort" });
        });
      };
      this.detachAbort = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private settle(
    outcome: RunOutcome,
  ): AgentToolResult<NoBlockDetails | undefined> {
    switch (outcome.kind) {
      case "finished":
        return this.settleFinished(outcome.process);
      case "timeout":
        this.observation.dispose();
        throw this.timeoutError(
          outcomeProcess(this.deps.manager, this.process),
        );
      case "abort":
        this.observation.dispose();
        throw this.abortError(outcomeProcess(this.deps.manager, this.process));
      case "background":
        return this.settleBackground();
    }
  }

  private settleFinished(
    process: ProcessInfo,
  ): AgentToolResult<NoBlockDetails | undefined> {
    this.clearBackgroundTimer();
    this.clearTimeoutTimer();
    if (this.aborted) throw this.abortError(process);
    if (this.timedOut) throw this.timeoutError(process);
    return formatFinishedResult(this.deps.manager, process);
  }

  private settleBackground(): AgentToolResult<NoBlockDetails | undefined> {
    this.observation.suppressOutput();
    if (this.timeoutTimer) {
      void this.observation.promise.then(() => this.clearTimeoutTimer());
    } else {
      this.observation.dispose();
    }
    return formatBackgroundResult(this.process);
  }

  private timeoutError(process: ProcessInfo): Error {
    return new Error(
      `Command timed out after ${this.deps.params.timeout} seconds\n\n${formatProcessOutput(this.deps.manager, process)}`,
    );
  }

  private abortError(process: ProcessInfo): Error {
    return new Error(
      `Command aborted\n\n${formatProcessOutput(this.deps.manager, process)}`,
    );
  }

  private clearBackgroundTimer(): void {
    if (!this.backgroundTimer) return;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
  }

  private clearTimeoutTimer(): void {
    if (!this.timeoutTimer) return;
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }
}

function neverOutcome(): Promise<RunOutcome> {
  return new Promise(() => {});
}

function outcomeProcess(
  manager: ProcessManager,
  fallback: ProcessInfo,
): ProcessInfo {
  return manager.get(fallback.id) ?? fallback;
}

function formatBackgroundResult(
  process: ProcessInfo,
): AgentToolResult<NoBlockDetails | undefined> {
  return {
    content: [
      {
        type: "text",
        text:
          `Command is still running as ${process.id} ("${process.name}"). ` +
          `No Block will report its exit.\n\n` +
          `stdout=${process.stdoutFile}\nstderr=${process.stderrFile}`,
      },
    ],
    details: buildRunDetails(process, "background"),
  };
}

function formatFinishedResult(
  manager: ProcessManager,
  process: ProcessInfo,
): AgentToolResult<NoBlockDetails | undefined> {
  const text = formatProcessOutput(manager, process);

  if (process.exitCode !== 0) {
    throw new Error(
      [text === "(no output)" ? "" : text, formatFailure(process)]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return {
    content: [{ type: "text", text }],
    details: buildRunDetails(process, "completed"),
  };
}

function observeProcessEnd(
  manager: ProcessManager,
  processId: string,
  onOutput: () => void,
): ProcessObservation {
  let dispose = () => {};
  let forwardOutput = true;
  const promise = new Promise<ProcessInfo>((resolve) => {
    dispose = manager.onEvent((event: ManagerEvent) => {
      if (event.type === "process_output_changed" && event.id === processId) {
        if (forwardOutput) onOutput();
        return;
      }
      if (event.type !== "process_ended" || event.info.id !== processId) return;
      dispose();
      resolve(event.info);
    });

    const current = manager.get(processId);
    if (current && isFinished(current)) {
      dispose();
      resolve(current);
    }
  });
  return {
    promise,
    dispose: () => dispose(),
    suppressOutput: () => {
      forwardOutput = false;
    },
  };
}

function isFinished(process: ProcessInfo): boolean {
  return process.status === "exited" || process.status === "killed";
}

function formatProcessOutput(
  manager: ProcessManager,
  process: ProcessInfo,
): string {
  const lines = manager.getCombinedOutput(process.id, 2_000) ?? [];
  const text = lines
    .map((line) => stripAnsi(line.text))
    .join("\n")
    .trim();
  if (!text) return "(no output)";
  const truncation = truncateTail(text);
  if (!truncation.truncated) return truncation.content;
  return (
    `${truncation.content}\n\n` +
    `[Output truncated: showing the last ${truncation.outputLines} of ${truncation.totalLines} lines. ` +
    `Inspect retained logs with process output ${process.id}.]`
  );
}

function formatFailure(process: ProcessInfo): string {
  if (process.exitCode !== null) {
    return `Command exited with code ${process.exitCode}`;
  }
  if (process.signal) {
    return `Command terminated by ${process.signal.name}`;
  }
  return process.errorMessage ?? "Command failed";
}

function defaultProcessName(command: string): string {
  const [executable = "command"] = command.trim().split(/\s+/u);
  const parts = executable.split("/");
  const basename = parts.at(-1) ?? "command";
  return `bash-${basename.slice(0, 32)}`;
}
