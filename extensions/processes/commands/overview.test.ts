import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerOverviewCommand } from "./overview";

describe("registerOverviewCommand", () => {
  it("registers the No Block command", () => {
    const names: string[] = [];
    const pi = {
      registerCommand(name: string) {
        names.push(name);
      },
    } as unknown as Pick<ExtensionAPI, "registerCommand">;

    registerOverviewCommand(pi, {
      events: {} as never,
      registerOverlay: () => () => {},
    });

    expect(names).toEqual(["no-block"]);
  });
});
