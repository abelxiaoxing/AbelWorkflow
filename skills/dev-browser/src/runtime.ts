import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeCommand {
  command: string;
  args: string[];
}

export interface TcpPortProbe {
  once(event: "error" | "listening", listener: () => void): this;
  listen(port: number, host: string): unknown;
  close(callback: () => void): unknown;
}

export type TcpPortProbeFactory = () => TcpPortProbe;

export type PlaywrightChromiumExecutableName = "chromium" | "chromium-headless-shell";

export interface ChromiumInstallCheckOptions {
  headless: boolean;
  findExecutable: (name: PlaywrightChromiumExecutableName) =>
    | { executablePath: () => string | undefined }
    | undefined;
  exists: (path: string) => boolean;
}

export interface RuntimePackageLock {
  packages?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      version?: string;
    }
  >;
}

export interface InvalidRuntimeDependenciesOptions {
  skillDir: string;
  lockedDependencies: Record<string, string>;
  readPackageVersion: (packageJsonPath: string) => string | undefined;
}

export function getRuntimeDependencyInstallCommand(): RuntimeCommand {
  return { command: "npm", args: ["ci", "--omit=dev"] };
}

export function getPlaywrightInstallCommand({
  skillDir,
  nodeExecutable = process.execPath,
}: {
  skillDir: string;
  nodeExecutable?: string;
}): RuntimeCommand {
  return {
    command: nodeExecutable,
    args: [join(skillDir, "node_modules", "playwright", "cli.js"), "install", "chromium"],
  };
}

export async function isTcpPortInUse(
  port: number,
  host = "127.0.0.1",
  createProbe: TcpPortProbeFactory = createServer
): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createProbe();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, host);
  });
}

export function isPlaywrightChromiumInstalled({
  headless,
  findExecutable,
  exists,
}: ChromiumInstallCheckOptions): boolean {
  const name = headless ? "chromium-headless-shell" : "chromium";
  const executablePath = findExecutable(name)?.executablePath();
  return typeof executablePath === "string" && executablePath.length > 0 && exists(executablePath);
}

export function getLockedRuntimeDependencies(
  lockfile: RuntimePackageLock
): Record<string, string> {
  const packages = lockfile.packages ?? {};
  return Object.fromEntries(
    Object.keys(packages[""]?.dependencies ?? {}).map((name) => {
      const version = packages[`node_modules/${name}`]?.version;
      if (!version) throw new Error(`Missing locked version for runtime dependency ${name}`);
      return [name, version];
    })
  );
}

export function getInvalidRuntimeDependencies({
  skillDir,
  lockedDependencies,
  readPackageVersion,
}: InvalidRuntimeDependenciesOptions): string[] {
  return Object.entries(lockedDependencies).flatMap(([name, version]) =>
    readPackageVersion(join(skillDir, "node_modules", ...name.split("/"), "package.json")) ===
    version
      ? []
      : [name]
  );
}

export function resolveRuntimePaths(skillDir: string) {
  return { skillDir };
}

export function resolveImportMetaDir(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}

export function resolveSkillDirFromEntrypoint(moduleUrl: string): string {
  const parentDir = dirname(resolveImportMetaDir(moduleUrl));
  return basename(parentDir) === "dist" ? dirname(parentDir) : parentDir;
}

export function shouldUseShellForPackageCommands(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}
