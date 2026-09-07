import type { BashToolDetails } from "@earendil-works/pi-coding-agent";
import type { ProcessInfo } from "../../src/types";

export type RunPhase =
  | "foreground"
  | "background"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface NoBlockDetails extends BashToolDetails {
  noBlock: {
    version: 1;
    processId: string;
    name: string;
    phase: RunPhase;
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    stdoutFile: string;
    stderrFile: string;
  };
}

export function buildRunDetails(
  process: ProcessInfo,
  phase: RunPhase,
): NoBlockDetails {
  return {
    noBlock: {
      version: 1,
      processId: process.id,
      name: process.name,
      phase,
      startedAt: process.startTime,
      endedAt: process.endTime,
      exitCode: process.exitCode,
      stdoutFile: process.stdoutFile,
      stderrFile: process.stderrFile,
    },
  };
}
