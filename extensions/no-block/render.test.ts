import {
  createBashToolDefinition,
  initTheme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { plainTextForDisplay } from "../shared/display-text";
import { createNoBlockRenderers } from "./render";
import type { NoBlockDetails } from "./run-details";

const details: NoBlockDetails = {
  noBlock: {
    version: 1,
    processId: "opaque-job",
    name: "Calculate",
    phase: "completed",
    startedAt: 1000,
    endedAt: 1100,
    exitCode: 0,
    stdoutFile: "/logs/stdout",
    stderrFile: "/logs/stderr",
  },
};

function createRow(command: string, name?: string, custom = true) {
  const native = createBashToolDefinition("/repo");
  const tool = {
    ...native,
    ...(custom ? createNoBlockRenderers() : {}),
  } as ToolDefinition;
  const row = new ToolExecutionComponent(
    "bash",
    "call",
    { command, name },
    { showImages: false },
    tool,
    { requestRender: vi.fn() } as unknown as TUI,
    "/repo",
  );
  return row;
}

function finish(
  row: ToolExecutionComponent,
  text = "18.42",
  metadata = details,
  isError = false,
) {
  row.setArgsComplete();
  row.updateResult({
    content: [{ type: "text", text }],
    details: metadata,
    isError,
  });
}

function plain(row: ToolExecutionComponent, width = 80) {
  return row.render(width).map(plainTextForDisplay);
}

beforeEach(() => initTheme("dark", false));

describe("Python tool rows in Pi", () => {
  it("keeps a completed result to two content rows and hides the heredoc until expansion", () => {
    const row = createRow(
      "python3 - <<'PY'\nprint(18.42)\nPY",
      "Calculate token cost",
    );
    finish(row);
    expect(plain(row)).toHaveLength(5);
    expect(plain(row).join("\n")).toContain("✓ 0.1s");
    expect(plain(row).join("\n")).not.toContain("print(");
    row.setExpanded(true);
    expect(plain(row).join("\n")).toContain("print(18.42)");
    expect(plain(row).join("\n")).toContain("Original command");
    expect(plain(row).join("\n")).toContain("/logs/stdout");
  });

  it("bounds noisy and hostile output even on narrow terminals", () => {
    const row = createRow(
      "python3 -c 'print(1)'",
      "Long label 界界界\nextra row",
    );
    const esc = String.fromCharCode(27);
    finish(
      row,
      Array.from(
        { length: 100 },
        (_, index) => `${index} ${esc}]52;c;payload\u0007${"界".repeat(60)}`,
      ).join("\n"),
    );
    for (const width of [3, 10, 20, 40, 80]) {
      const rendered = row.render(width);
      expect(rendered.length).toBeLessThanOrEqual(7);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(rendered.join("\n")).not.toContain("]52;");
    }
  });

  it("keeps long source, output, and log paths inspectable after expansion", () => {
    const row = createRow(
      `.venv/bin/python -c 'print("${"x".repeat(120)}SOURCE_END")'`,
    );
    finish(row, `${"x".repeat(120)}OUTPUT_END`, {
      noBlock: {
        ...details.noBlock,
        stdoutFile: `/logs/${"x".repeat(120)}/stdout-end.log`,
      },
    });
    row.setExpanded(true);
    const expanded = plain(row, 40).join("\n");
    expect(expanded).toContain("SOURCE_END");
    expect(expanded).toContain("OUTPUT_END");
    expect(expanded).toContain("stdout-end.log");
    for (const width of [3, 4, 40]) {
      expect(
        row.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
  });

  it("shows the exception and source location without dumping the stack", () => {
    const row = createRow("python3 -c 'raise KeyError(\"id\")'");
    finish(
      row,
      "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nKeyError: 'id'\n\nCommand exited with code 1",
      {
        noBlock: { ...details.noBlock, phase: "failed", exitCode: 1 },
      },
      true,
    );
    const collapsed = plain(row).join("\n");
    expect(collapsed).toContain("KeyError: 'id'");
    expect(collapsed).toContain('File "<string>", line 1');
    expect(collapsed).not.toContain("Traceback");
    expect(collapsed).not.toContain("✓");
    row.setExpanded(true);
    expect(plain(row).join("\n")).toContain("Traceback");
  });

  it("renders a settled handoff as background, including after replay", () => {
    const row = createRow("python3 slow.py");
    finish(row, "Command is still running", {
      noBlock: {
        ...details.noBlock,
        phase: "background",
        endedAt: null,
        exitCode: null,
      },
    });
    expect(plain(row).join("\n")).toContain("background");
    expect(plain(row).join("\n")).toContain("opaque-job");
    expect(plain(row).join("\n")).not.toContain("✓");
  });

  it("does not flash source while Python arguments stream", () => {
    const row = createRow("python3 - <<'PY'\nprint(unfinished");
    expect(plain(row)).toHaveLength(4);
    expect(plain(row).join("\n")).not.toContain("print(");
  });

  it.each([false, true])(
    "keeps Python header and output inside the native tool block (error=%s)",
    (isError) => {
      const python = createRow("python3 /tmp/calculate_5.py");
      const native = createRow("printf 30", undefined, false);
      for (const row of [python, native]) finish(row, "30", details, isError);
      const rendered = python.render(80);
      const reference = native.render(80);
      expect(rendered).toHaveLength(5);
      const [separator, top, header, output, bottom] = rendered;
      expect(reference).toHaveLength(6);
      const [nativeSeparator, nativeTop, , , nativeOutput, nativeBottom] =
        reference;
      expect(separator).toBe(nativeSeparator);
      expect(top).toBe(nativeTop);
      expect(bottom).toBe(nativeBottom);
      expect(plainTextForDisplay(output)).toBe(
        plainTextForDisplay(nativeOutput),
      );
      expect(plainTextForDisplay(header)).toMatch(
        /^ Python 🐍 \/tmp\/calculate_5\.py\s+.* $/u,
      );
      expect(top).not.toBe(" ".repeat(80));
    },
  );

  it("preserves native Bash framing during execution and streaming", () => {
    vi.useFakeTimers();
    try {
      const custom = createRow("printf hello");
      const native = createRow("printf hello", undefined, false);
      for (const row of [custom, native]) {
        row.setArgsComplete();
        row.markExecutionStarted();
      }
      expect(plain(custom)).toEqual(plain(native));
      for (const row of [custom, native]) {
        row.updateResult(
          {
            content: [{ type: "text", text: "hello" }],
            isError: false,
            details,
          },
          true,
        );
      }
      expect(plain(custom)).toEqual(plain(native));
      for (const row of [custom, native]) finish(row, "hello");
      expect(plain(custom)).toEqual(plain(native));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "printf hello",
    "python3 script.py && echo other",
    "python3 script.py > /tmp/result",
  ])("preserves native Bash framing and content for %s", (command) => {
    const custom = createRow(command);
    const native = createRow(command, undefined, false);
    finish(custom, "hello");
    finish(native, "hello");
    expect(plain(custom)).toEqual(plain(native));
  });
});
