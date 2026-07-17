export type EntrypointMode = "standalone" | "extension";

export interface EntrypointArgs {
  mode: EntrypointMode;
  host: string;
  port: number;
  cdpPort: number;
  headless: boolean;
}

export interface StandaloneReadinessInfo {
  mode: "standalone";
  host: string;
  port: number;
  wsEndpoint: string;
}

export interface ExtensionReadinessInfo {
  mode: "extension";
  host: string;
  port: number;
  wsEndpoint: string;
}

export type ReadinessInfo = StandaloneReadinessInfo | ExtensionReadinessInfo;

export const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 9222;
const DEFAULT_CDP_PORT = 9223;

export function formatHostForUrl(host: string): string {
  const normalizedHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
}

export function formatHttpUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function formatWsUrl(host: string, port: number, path = ""): string {
  return `ws://${formatHostForUrl(host)}:${port}${path}`;
}

export function resolveHostForProbe(host: string): string {
  const normalizedHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (normalizedHost === "0.0.0.0") {
    return "127.0.0.1";
  }

  if (normalizedHost === "::") {
    return "::1";
  }

  return normalizedHost;
}

export function parseEntrypointArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): EntrypointArgs {
  let index = 0;
  let mode: EntrypointMode = "standalone";

  const first = argv[0];
  if (first && !first.startsWith("--")) {
    if (first !== "standalone" && first !== "extension") {
      throw new Error(`Unknown mode: ${first}`);
    }
    mode = first;
    index = 1;
  }

  const args: EntrypointArgs = {
    mode,
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: readEnvPort(env.PORT, "PORT") ?? DEFAULT_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    headless: env.HEADLESS?.trim().toLowerCase() === "true",
  };

  while (index < argv.length) {
    const token = argv[index++];
    switch (token) {
      case "--headless":
        args.headless = true;
        break;
      case "--host":
        args.host = readValue(argv, index - 1);
        index += 1;
        break;
      case "--port":
        args.port = parsePort(readValue(argv, index - 1), "port");
        index += 1;
        break;
      case "--cdp-port":
        args.cdpPort = parsePort(readValue(argv, index - 1), "cdpPort");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

export function formatReadinessLines(info: ReadinessInfo): string[] {
  if (info.mode === "standalone") {
    return [
      "Dev browser server started",
      `  HTTP: ${formatHttpUrl(info.host, info.port)}`,
      `  WebSocket: ${info.wsEndpoint}`,
      "",
      "Ready",
    ];
  }

  return [
    "CDP relay server started",
    `  HTTP: ${formatHttpUrl(info.host, info.port)}`,
    `  CDP endpoint: ${info.wsEndpoint}`,
    `  Extension endpoint: ${formatWsUrl(info.host, info.port, "/extension")}`,
    "",
    "Waiting for extension to connect...",
  ];
}

function readValue(argv: string[], optionIndex: number): string {
  const value = argv[optionIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${argv[optionIndex]}`);
  }
  return value;
}

function parsePort(value: string, label: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return port;
}

function readEnvPort(value: string | undefined, label: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return parsePort(normalized, label);
}
