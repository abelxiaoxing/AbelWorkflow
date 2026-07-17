import { formatReadinessLines, type EntrypointArgs } from "./entrypoint.js";
import type { RuntimeCommand } from "./runtime.js";

export interface RuntimePaths {
  skillDir: string;
}

interface StandaloneServer {
  port: number;
  wsEndpoint: string;
  stop: () => Promise<void>;
}

interface ExtensionServer {
  port: number;
  wsEndpoint: string;
  stop: () => Promise<void>;
}

export interface RunEntrypointDeps {
  runtimePaths: RuntimePaths;
  serveStandalone: (options: {
    port: number;
    host: string;
    headless: boolean;
    cdpPort: number;
  }) => Promise<StandaloneServer>;
  serveExtension: (options: { port: number; host: string }) => Promise<ExtensionServer>;
  registerShutdown: (stop: () => Promise<void>) => void;
  keepAlive: () => Promise<void>;
  log: (line: string) => void;
  ensureBrowser?: () => Promise<void>;
  preflightStandalone?: () => Promise<boolean>;
}

export interface EnsurePlaywrightChromiumDeps {
  isInstalled: () => boolean;
  installCommand: RuntimeCommand;
  runCommand: (command: string, args: string[]) => Promise<void>;
  log: (line: string) => void;
}

export interface PreflightStandaloneStartupDeps {
  checkServer: (host: string, port: number) => Promise<{
    ok: boolean;
    info?: { mode?: unknown; wsEndpoint?: unknown };
  }>;
  isPortInUse: (port: number) => Promise<boolean>;
  log: (line: string) => void;
}

export async function preflightStandaloneStartup(
  args: EntrypointArgs,
  deps: PreflightStandaloneStartupDeps
): Promise<boolean> {
  const serverCheck = await deps.checkServer(args.host, args.port);
  if (
    serverCheck.ok &&
    serverCheck.info?.mode === "standalone" &&
    typeof serverCheck.info.wsEndpoint === "string" &&
    serverCheck.info.wsEndpoint.trim().length > 0
  ) {
    deps.log(`Server already running on port ${args.port}`);
    return false;
  }

  if (await deps.isPortInUse(args.port)) {
    throw new Error(
      `HTTP port ${args.port} is already in use. Stop the existing service or use --port.`
    );
  }

  if (await deps.isPortInUse(args.cdpPort)) {
    throw new Error(
      `CDP port ${args.cdpPort} is already in use. Close the existing browser or use --cdp-port.`
    );
  }

  return true;
}

export async function ensurePlaywrightChromium(deps: EnsurePlaywrightChromiumDeps) {
  if (deps.isInstalled()) {
    deps.log("Playwright Chromium already installed.");
    return;
  }

  deps.log("Playwright Chromium not found. Installing (this may take a minute)...");
  await deps.runCommand(deps.installCommand.command, deps.installCommand.args);
  deps.log("Chromium installed successfully.");
}

export async function runEntrypoint(args: EntrypointArgs, deps: RunEntrypointDeps) {
  if (args.mode === "extension") {
    const server = await deps.serveExtension({
      port: args.port,
      host: args.host,
    });

    for (const line of formatReadinessLines({
      mode: "extension",
      host: args.host,
      port: args.port,
      wsEndpoint: server.wsEndpoint,
    })) {
      deps.log(line);
    }

    deps.registerShutdown(() => server.stop());
    await deps.keepAlive();
    return;
  }

  const shouldStart = await deps.preflightStandalone?.();
  if (shouldStart === false) {
    return;
  }

  await deps.ensureBrowser?.();

  let settleServer!: (server: StandaloneServer | undefined) => void;
  const serverReady = new Promise<StandaloneServer | undefined>((resolve) => {
    settleServer = resolve;
  });
  deps.registerShutdown(async () => {
    await (await serverReady)?.stop();
  });
  try {
    const server = await deps.serveStandalone({
      port: args.port,
      host: args.host,
      headless: args.headless,
      cdpPort: args.cdpPort,
    });
    settleServer(server);

    for (const line of formatReadinessLines({
      mode: "standalone",
      host: args.host,
      port: args.port,
      wsEndpoint: server.wsEndpoint,
    })) {
      deps.log(line);
    }

    await deps.keepAlive();
  } catch (error) {
    settleServer(undefined);
    throw error;
  }
}
