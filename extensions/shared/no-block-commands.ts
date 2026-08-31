import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CommandRegistrar = Pick<ExtensionAPI, "registerCommand">;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

/** Register one command in the No Block namespace. */
export function registerNoBlockCommand(
  pi: CommandRegistrar,
  suffix: string,
  options: CommandOptions,
): void {
  pi.registerCommand(`no-block${suffix}`, options);
}
