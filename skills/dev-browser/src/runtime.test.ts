import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  getInvalidRuntimeDependencies,
  getLockedRuntimeDependencies,
  getPlaywrightInstallCommand,
  getRuntimeDependencyInstallCommand,
  isPlaywrightChromiumInstalled,
  isTcpPortInUse,
  resolveRuntimePaths,
  resolveSkillDirFromEntrypoint,
} from "./runtime.js";

describe("runtime commands", () => {
  it("installs only locked runtime dependencies", () => {
    expect(getRuntimeDependencyInstallCommand()).toEqual({
      command: "npm",
      args: ["ci", "--omit=dev"],
    });
  });

  it("installs Chromium through the local locked Playwright CLI", () => {
    expect(
      getPlaywrightInstallCommand({
        skillDir: "/opt/dev-browser",
        nodeExecutable: "/usr/bin/node",
      })
    ).toEqual({
      command: "/usr/bin/node",
      args: [join("/opt/dev-browser", "node_modules", "playwright", "cli.js"), "install", "chromium"],
    });
  });
});

describe("isTcpPortInUse", () => {
  it("detects an occupied port without inspecting or terminating its process", async () => {
    const createProbe = (event: "error" | "listening") => () => {
      const server = new EventEmitter() as EventEmitter & {
        listen: () => void;
        close: (callback: () => void) => void;
      };
      server.listen = () => queueMicrotask(() => server.emit(event));
      server.close = (callback) => callback();
      return server;
    };

    await expect(isTcpPortInUse(9223, "127.0.0.1", createProbe("error"))).resolves.toBe(true);
    await expect(isTcpPortInUse(9223, "127.0.0.1", createProbe("listening"))).resolves.toBe(false);
  });
});

describe("resolveSkillDirFromEntrypoint", () => {
  it("resolves the package root from source and compiled startup entrypoints", () => {
    const skillDir = resolve("/opt", "dev-browser");

    expect(
      resolveSkillDirFromEntrypoint(pathToFileURL(join(skillDir, "scripts", "start.ts")).href)
    ).toBe(skillDir);
    expect(
      resolveSkillDirFromEntrypoint(
        pathToFileURL(join(skillDir, "dist", "scripts", "start.js")).href
      )
    ).toBe(skillDir);
  });
});

describe("resolveRuntimePaths", () => {
  it("does not reserve runtime state directories inside the installed skill", () => {
    expect(resolveRuntimePaths("/opt/dev-browser")).toEqual({
      skillDir: "/opt/dev-browser",
    });
  });
});

describe("isPlaywrightChromiumInstalled", () => {
  it("checks the full Chromium executable for headed launch", () => {
    const executablePath = join("/cache", "chromium-1200", "chrome-linux", "chrome");
    const names: string[] = [];
    expect(
      isPlaywrightChromiumInstalled({
        headless: false,
        findExecutable: (name) => {
          names.push(name);
          return { executablePath: () => executablePath };
        },
        exists: (path) => path === executablePath,
      })
    ).toBe(true);
    expect(names).toEqual(["chromium"]);
  });

  it("requires the headless shell even when full Chromium is installed", () => {
    const chromiumPath = join("/cache", "chromium-1200", "chrome-linux", "chrome");
    const shellPath = join(
      "/cache",
      "chromium_headless_shell-1200",
      "chrome-headless-shell-linux64",
      "chrome-headless-shell"
    );
    const names: string[] = [];

    expect(
      isPlaywrightChromiumInstalled({
        headless: true,
        findExecutable: (name) => {
          names.push(name);
          return { executablePath: () => (name === "chromium" ? chromiumPath : shellPath) };
        },
        exists: (path) => path === chromiumPath,
      })
    ).toBe(false);
    expect(names).toEqual(["chromium-headless-shell"]);
  });

  it("does not accept an older Chromium revision in the cache", () => {
    expect(
      isPlaywrightChromiumInstalled({
        headless: false,
        findExecutable: () => ({
          executablePath: () => join("/cache", "chromium-1200", "chrome-linux", "chrome"),
        }),
        exists: (path) => path.includes("chromium-1162"),
      })
    ).toBe(false);
  });
});

describe("runtime dependency versions", () => {
  const lockfile = {
    packages: {
      "": {
        dependencies: {
          "@hono/node-server": "^1.19.13",
          playwright: "^1.49.0",
        },
      },
      "node_modules/@hono/node-server": { version: "1.19.14" },
      "node_modules/playwright": { version: "1.57.0" },
    },
  };

  it("reads exact top-level runtime versions from package-lock.json", () => {
    expect(getLockedRuntimeDependencies(lockfile)).toEqual({
      "@hono/node-server": "1.19.14",
      playwright: "1.57.0",
    });
  });

  it("reports missing and wrong installed versions", () => {
    const lockedDependencies = getLockedRuntimeDependencies(lockfile);
    const installed = new Map([
      [join("/skill", "node_modules", "@hono", "node-server", "package.json"), "1.19.13"],
    ]);

    expect(
      getInvalidRuntimeDependencies({
        skillDir: "/skill",
        lockedDependencies,
        readPackageVersion: (path) => installed.get(path),
      })
    ).toEqual(["@hono/node-server", "playwright"]);
  });

  it("accepts only exact installed versions", () => {
    const lockedDependencies = getLockedRuntimeDependencies(lockfile);

    expect(
      getInvalidRuntimeDependencies({
        skillDir: "/skill",
        lockedDependencies,
        readPackageVersion: (path) =>
          path.includes("@hono") ? "1.19.14" : "1.57.0",
      })
    ).toEqual([]);
  });
});
