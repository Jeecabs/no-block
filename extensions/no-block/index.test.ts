import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { ProcessManager } from "../../src/manager";
import type { ManagerEvent, ProcessInfo } from "../../src/types";
import { flushQueuedMicrotasks } from "../../tests/utils/async";
import { registerNotificationDelivery } from "../processes/handlers/notifications";
import { createNotificationRegistry } from "../processes/notifications/registry";
import { createNotificationService } from "../processes/notifications/service";
import { registerNoBlockTool } from ".";

const runningProcess: ProcessInfo = {
  id: "proc_1",
  name: "tests",
  pid: 123,
  command: "pnpm test",
  cwd: "/repo",
  startTime: 1_000,
  endTime: null,
  status: "running",
  exitCode: null,
  success: null,
  stdoutFile: "/tmp/proc_1-stdout.log",
  stderrFile: "/tmp/proc_1-stderr.log",
  endReason: null,
  signal: null,
  errorMessage: null,
};

function createFakeManager() {
  const listeners = new Set<(event: ManagerEvent) => void>();
  let process = runningProcess;
  let outputLines = [{ type: "stdout" as const, text: "all tests passed" }];

  const emitFinished = (next: ProcessInfo) => {
    process = next;
    for (const listener of listeners) {
      listener({ type: "process_ended", info: process });
    }
  };

  const manager = {
    start: vi.fn(() => process),
    get: vi.fn(() => process),
    getCombinedOutput: vi.fn(() => outputLines),
    kill: vi.fn(async () => {
      emitFinished({
        ...process,
        status: "killed",
        endTime: 2_000,
        exitCode: null,
        success: false,
        endReason: "signal",
      });
      return { ok: true as const, info: process };
    }),
    onEvent(listener: (event: ManagerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    manager: manager as unknown as ProcessManager,
    rawManager: manager,
    output(text: string) {
      outputLines = [{ type: "stdout", text }];
      for (const listener of listeners) {
        listener({
          type: "process_output_changed",
          id: process.id,
          appendedText: outputLines,
        });
      }
    },
    finish(exitCode: number) {
      if (process.status !== "running") return;
      emitFinished({
        ...process,
        status: "exited",
        endTime: 2_000,
        exitCode,
        success: exitCode === 0,
        endReason: "exit",
      });
    },
  };
}

function captureBashTool(
  manager: ProcessManager,
  notifications = createNotificationRegistry(),
): {
  tool: ToolDefinition;
  notifications: ReturnType<typeof createNotificationRegistry>;
} {
  const tools: ToolDefinition[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as ExtensionAPI;
  registerNoBlockTool(pi, manager, notifications);
  const tool = tools.find((candidate) => candidate.name === "bash");
  if (!tool) throw new Error("No Block did not register bash");
  return { tool, notifications };
}

const ctx = { cwd: "/repo" } as ExtensionContext;

describe("No Block bash", () => {
  it("returns the normal result when a finite command exits quickly", async () => {
    const fake = createFakeManager();
    const { tool, notifications } = captureBashTool(fake.manager);

    const execution = tool.execute(
      "tool_1",
      { command: "pnpm test", name: "tests" },
      undefined,
      undefined,
      ctx,
    );
    fake.finish(0);

    const result = await execution;

    expect(result.content).toEqual([
      { type: "text", text: "all tests passed" },
    ]);
    expect(notifications.get("proc_1")?.completionDelivery).toBe("tool");
  });

  it("bounds streamed foreground output and retains its tail", async () => {
    const fake = createFakeManager();
    const { tool } = captureBashTool(fake.manager);
    const onUpdate = vi.fn();
    const lines = Array.from(
      { length: 2_100 },
      (_, index) => `test line ${String(index).padStart(4, "0")}`,
    );

    const execution = tool.execute(
      "tool_1",
      { command: "pnpm test" },
      undefined,
      onUpdate,
      ctx,
    );
    fake.output(lines.join("\n"));
    fake.finish(0);
    await execution;

    const update = onUpdate.mock.calls.at(0)?.at(0);
    const text = update?.content.find(
      (part: { type: string; text?: string }) => part.type === "text",
    )?.text;
    expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThan(52 * 1_024);
    expect(text).toContain("test line 2099");
    expect(text).toContain("[Output truncated");
  });

  it("hands a slow finite command back after the foreground wait", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeManager();
      const { tool, notifications } = captureBashTool(fake.manager);

      const execution = tool.execute(
        "tool_1",
        {
          command: "pnpm test",
          name: "tests",
          backgroundAfter: 0.01,
        },
        undefined,
        undefined,
        ctx,
      );
      await vi.advanceTimersByTimeAsync(10);

      const result = await execution;
      const text = result.content.find((part) => part.type === "text")?.text;

      expect(text).toContain("proc_1");
      expect(text).toContain("still running");
      expect(notifications.get("proc_1")?.completionDelivery).toBe("notify");
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches the tool cancellation signal after background handoff", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeManager();
      const { tool } = captureBashTool(fake.manager);
      const controller = new AbortController();

      const execution = tool.execute(
        "tool_1",
        { command: "pnpm test", backgroundAfter: 0.01 },
        controller.signal,
        undefined,
        ctx,
      );
      await vi.advanceTimersByTimeAsync(10);
      await execution;
      controller.abort();

      expect(fake.rawManager.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a backgrounded command at its hard timeout and notifies once", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeManager();
      const notifications = createNotificationRegistry();
      const events = createEventBus();
      const sendMessage = vi.fn();
      const service = createNotificationService({
        events,
        manager: fake.manager,
        registry: notifications,
        getProcess: () => fake.rawManager.get(),
      });
      const disposeDelivery = registerNotificationDelivery(events, {
        sendMessage,
      } as never);
      const { tool } = captureBashTool(fake.manager, notifications);
      setTimeout(() => fake.finish(0), 100);

      const execution = tool.execute(
        "tool_1",
        {
          command: "pnpm test",
          timeout: 0.02,
          backgroundAfter: 0.01,
        },
        undefined,
        undefined,
        ctx,
      );
      await vi.advanceTimersByTimeAsync(10);
      await execution;
      await vi.advanceTimersByTimeAsync(10);
      await flushQueuedMicrotasks();

      expect(fake.rawManager.kill).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls.at(0)?.at(0)?.details.kind).toBe("killed");
      expect(sendMessage.mock.calls.at(0)?.at(1)).toEqual({
        triggerTurn: true,
        deliverAs: "followUp",
      });

      await vi.advanceTimersByTimeAsync(80);
      await flushQueuedMicrotasks();
      expect(sendMessage).toHaveBeenCalledTimes(1);

      disposeDelivery();
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a foreground command when the tool call is cancelled", async () => {
    const fake = createFakeManager();
    const { tool, notifications } = captureBashTool(fake.manager);
    const controller = new AbortController();

    const execution = tool.execute(
      "tool_1",
      { command: "pnpm test", backgroundAfter: 30 },
      controller.signal,
      undefined,
      ctx,
    );
    const rejection = expect(execution).rejects.toThrow("Command aborted");
    controller.abort();
    await rejection;

    expect(fake.rawManager.kill).toHaveBeenCalledWith("proc_1");
    expect(notifications.get("proc_1")?.completionDelivery).toBe("tool");
  });

  it("kills a foreground command at its hard timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeManager();
      const { tool, notifications } = captureBashTool(fake.manager);

      const execution = tool.execute(
        "tool_1",
        {
          command: "pnpm test",
          timeout: 0.01,
          backgroundAfter: 1,
        },
        undefined,
        undefined,
        ctx,
      );
      const rejection = expect(execution).rejects.toThrow(
        "Command timed out after 0.01 seconds",
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejection;

      expect(fake.rawManager.kill).toHaveBeenCalledWith("proc_1");
      expect(notifications.get("proc_1")?.completionDelivery).toBe("tool");
    } finally {
      vi.useRealTimers();
    }
  });
});
