import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { formatHttpUrl, parseEntrypointArgs, resolveHostForProbe } from "../src/entrypoint.js";
import {
  getInvalidRuntimeDependencies,
  getLockedRuntimeDependencies,
  getPlaywrightInstallCommand,
  getRuntimeDependencyInstallCommand,
  isPlaywrightChromiumInstalled,
  isTcpPortInUse,
  resolveSkillDirFromEntrypoint,
  resolveRuntimePaths,
  shouldUseShellForPackageCommands,
} from "../src/runtime.js";
import {
  ensurePlaywrightChromium,
  preflightStandaloneStartup,
  runEntrypoint,
} from "../src/startup.js";

const runtimePaths = resolveRuntimePaths(resolveSkillDirFromEntrypoint(import.meta.url));
const useShell = shouldUseShellForPackageCommands(process.platform);
const require = createRequire(import.meta.url);

async function main() {
  const args = parseEntrypointArgs(process.argv.slice(2));
  await ensureSkillDependencies();

  await runEntrypoint(args, {
    runtimePaths,
    serveStandalone: async (options) => {
      const { serve } = await import("../src/index.js");
      return serve(options);
    },
    serveExtension: async (options) => {
      const { serveRelay } = await import("../src/relay.js");
      return serveRelay(options);
    },
    registerShutdown,
    keepAlive: () => new Promise(() => {}),
    log: (line) => console.log(line),
    ensureBrowser: async () => {
      const { registry } = require("playwright-core/lib/server/registry/index") as {
        registry: {
          findExecutable: (name: "chromium" | "chromium-headless-shell") =>
            | { executablePath: () => string | undefined }
            | undefined;
        };
      };
      await ensurePlaywrightChromium({
        isInstalled: () =>
          isPlaywrightChromiumInstalled({
            headless: args.headless,
            findExecutable: (name) => registry.findExecutable(name),
            exists: existsSync,
          }),
        installCommand: getPlaywrightInstallCommand({ skillDir: runtimePaths.skillDir }),
        runCommand,
        log: (line) => console.log(line),
      });
    },
    preflightStandalone: () =>
      preflightStandaloneStartup(args, {
        checkServer: async (host, port) => {
          try {
            const response = await fetch(formatHttpUrl(resolveHostForProbe(host), port), {
              signal: AbortSignal.timeout(1000),
            });
            if (!response.ok) {
              return { ok: false };
            }
            const info = (await response.json()) as {
              mode?: unknown;
              wsEndpoint?: unknown;
            };
            return { ok: true, info };
          } catch {
            return { ok: false };
          }
        },
        isPortInUse: isTcpPortInUse,
        log: (line) => console.log(line),
      }),
  });
}

async function ensureSkillDependencies() {
  const packageLock = JSON.parse(
    readFileSync(join(runtimePaths.skillDir, "package-lock.json"), "utf8")
  );
  const invalidDependencies = getInvalidRuntimeDependencies({
    skillDir: runtimePaths.skillDir,
    lockedDependencies: getLockedRuntimeDependencies(packageLock),
    readPackageVersion: (path) => {
      try {
        const installed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
        return typeof installed.version === "string" ? installed.version : undefined;
      } catch {
        return undefined;
      }
    },
  });

  if (invalidDependencies.length === 0) return;

  console.log("dev-browser dependencies missing or out of date. Installing local packages...");
  const installCommand = getRuntimeDependencyInstallCommand();
  await runCommand(installCommand.command, installCommand.args);
  console.log("dev-browser dependencies installed.");
}

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: runtimePaths.skillDir,
      stdio: "inherit",
      shell: useShell && command === "npm",
      windowsHide: useShell && command === "npm",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function registerShutdown(stop: () => Promise<void>) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await stop();
      process.exit(0);
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}

main().catch((error) => {
  console.error("Failed to start dev-browser:", error);
  process.exit(1);
});
