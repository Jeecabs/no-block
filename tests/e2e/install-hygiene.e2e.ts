import { execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("git-source install hygiene", () => {
  it("does not invoke Husky when production dependencies omit it", async () => {
    const directory = await createInstallFixture();
    const sentinel = join(directory, "husky-invoked");
    const binDirectory = join(directory, "bin");
    await mkdir(binDirectory);
    const fakeHusky = join(binDirectory, "husky");
    await writeFile(fakeHusky, '#!/bin/sh\ntouch "$HUSKY_SENTINEL"\n');
    await chmod(fakeHusky, 0o755);

    await execFileAsync(
      "npm",
      [
        "install",
        "--omit=dev",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--foreground-scripts",
        "--package-lock=false",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          HUSKY_SENTINEL: sentinel,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );

    await expect(pathExists(sentinel)).resolves.toBe(false);
  });

  it("does not leave a package lock in a git-source install", async () => {
    const directory = await createInstallFixture();
    await copyFile(join(repoRoot, ".npmrc"), join(directory, ".npmrc"));

    await execFileAsync(
      "npm",
      [
        "install",
        "--omit=dev",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--foreground-scripts",
      ],
      { cwd: directory },
    );

    await expect(
      pathExists(join(directory, "package-lock.json")),
    ).resolves.toBe(false);
  });
});

async function createInstallFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "no-block-install-"));
  tempDirectories.push(directory);
  await mkdir(join(directory, ".git"));

  const manifestText = await readFile(join(repoRoot, "package.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    scripts?: { prepare?: string };
  };

  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "no-block-install-fixture",
        version: "0.0.0",
        private: true,
        scripts: { prepare: manifest.scripts?.prepare },
      },
      null,
      2,
    )}\n`,
  );

  return directory;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
