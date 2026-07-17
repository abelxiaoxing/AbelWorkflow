import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HOST,
  formatHttpUrl,
  formatReadinessLines,
  parseEntrypointArgs,
  resolveHostForProbe,
} from "./entrypoint.js";
import { preflightStandaloneStartup, runEntrypoint } from "./startup.js";

describe("entrypoint host handling", () => {
  it("defaults standalone host to localhost", () => {
    const args = parseEntrypointArgs([], {});

    expect(args.host).toBe(DEFAULT_HOST);
    expect(args.host).toBe("localhost");
  });

  it("formats IPv6 hosts in readiness output", () => {
    expect(formatHttpUrl("::1", 9222)).toBe("http://[::1]:9222");

    expect(
      formatReadinessLines({
        mode: "standalone",
        host: "::1",
        port: 9222,
        wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/test",
      })
    ).toContain("  HTTP: http://[::1]:9222");
    expect(
      formatReadinessLines({
        mode: "standalone",
        host: "::1",
        port: 9222,
        wsEndpoint: "ws://127.0.0.1:9223/devtools/browser/test",
      }).join("\n")
    ).not.toMatch(/tmp|profile/i);
  });

  it("normalizes wildcard hosts to a reachable probe target", () => {
    expect(resolveHostForProbe("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveHostForProbe("::")).toBe("::1");
    expect(resolveHostForProbe("[::1]")).toBe("::1");
    expect(resolveHostForProbe("localhost")).toBe("localhost");
  });
});

describe("preflightStandaloneStartup", () => {
  it("checks the configured host before starting", async () => {
    const checkServer = vi.fn().mockResolvedValue({ ok: false });
    const isPortInUse = vi.fn().mockResolvedValue(false);
    const log = vi.fn();

    await expect(
      preflightStandaloneStartup(
        {
          mode: "standalone",
          host: "::1",
          port: 9222,
          cdpPort: 9223,
          headless: false,
        },
        {
          checkServer,
          isPortInUse,
          log,
        }
      )
    ).resolves.toBe(true);

    expect(checkServer).toHaveBeenCalledWith("::1", 9222);
  });

  it("short-circuits when the configured host already has a server", async () => {
    const checkServer = vi.fn().mockResolvedValue({
      ok: true,
      info: { mode: "standalone", wsEndpoint: "ws://test" },
    });
    const isPortInUse = vi.fn();
    const log = vi.fn();

    await expect(
      preflightStandaloneStartup(
        {
          mode: "standalone",
          host: "localhost",
          port: 9222,
          cdpPort: 9223,
          headless: false,
        },
        {
          checkServer,
          isPortInUse,
          log,
        }
      )
    ).resolves.toBe(false);

    expect(checkServer).toHaveBeenCalledWith("localhost", 9222);
    expect(isPortInUse).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Server already running on port 9222");
  });

  it.each([
    ["missing mode", { wsEndpoint: "ws://test" }],
    ["extension mode", { mode: "extension", wsEndpoint: "ws://test" }],
    ["empty endpoint", { mode: "standalone", wsEndpoint: "" }],
  ])("treats a 2xx JSON response with %s as an HTTP port collision", async (_label, info) => {
    const isPortInUse = vi.fn().mockResolvedValue(true);

    await expect(
      preflightStandaloneStartup(
        {
          mode: "standalone",
          host: "localhost",
          port: 9222,
          cdpPort: 9223,
          headless: false,
        },
        {
          checkServer: vi.fn().mockResolvedValue({ ok: true, info }),
          isPortInUse,
          log: vi.fn(),
        }
      )
    ).rejects.toThrow("HTTP port 9222 is already in use. Stop the existing service or use --port.");

    expect(isPortInUse).toHaveBeenCalledWith(9222);
  });

  it("fails safely when the HTTP port is occupied by an unknown service", async () => {
    const checkServer = vi.fn().mockResolvedValue({ ok: false });
    const isPortInUse = vi.fn().mockResolvedValue(true);

    await expect(
      preflightStandaloneStartup(
        {
          mode: "standalone",
          host: "localhost",
          port: 9222,
          cdpPort: 9223,
          headless: false,
        },
        {
          checkServer,
          isPortInUse,
          log: vi.fn(),
        }
      )
    ).rejects.toThrow("HTTP port 9222 is already in use. Stop the existing service or use --port.");

    expect(isPortInUse).toHaveBeenCalledTimes(1);
    expect(isPortInUse).toHaveBeenCalledWith(9222);
  });

  it("fails safely when the CDP port is occupied without terminating its owner", async () => {
    const checkServer = vi.fn().mockResolvedValue({ ok: false });
    const isPortInUse = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(
      preflightStandaloneStartup(
        {
          mode: "standalone",
          host: "localhost",
          port: 9222,
          cdpPort: 9223,
          headless: false,
        },
        {
          checkServer,
          isPortInUse,
          log: vi.fn(),
        }
      )
    ).rejects.toThrow(
      "CDP port 9223 is already in use. Close the existing browser or use --cdp-port."
    );

    expect(isPortInUse).toHaveBeenNthCalledWith(1, 9222);
    expect(isPortInUse).toHaveBeenNthCalledWith(2, 9223);
  });
});

describe("runEntrypoint shutdown lifecycle", () => {
  it("registers standalone shutdown before starting the server", async () => {
    const order: string[] = [];
    const stop = vi.fn().mockResolvedValue(undefined);
    let shutdown = async () => {};

    await runEntrypoint(
      {
        mode: "standalone",
        host: "localhost",
        port: 9222,
        cdpPort: 9223,
        headless: true,
      },
      {
        runtimePaths: {
          skillDir: "/skill",
        },
        serveStandalone: async () => {
          order.push("serve");
          return { port: 9222, wsEndpoint: "ws://browser.test/cdp", stop };
        },
        serveExtension: vi.fn(),
        registerShutdown: (callback) => {
          order.push("register");
          shutdown = callback;
        },
        keepAlive: async () => undefined,
        log: vi.fn(),
        ensureBrowser: async () => {
          order.push("ensure");
        },
        preflightStandalone: async () => true,
      }
    );

    expect(order).toEqual(["ensure", "register", "serve"]);
    await shutdown();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("waits for in-flight standalone startup before completing shutdown", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    let shutdown = async () => {};
    let resolveServe!: (server: { port: number; wsEndpoint: string; stop: () => Promise<void> }) => void;
    let markServeStarted!: () => void;
    const serveStarted = new Promise<void>((resolve) => {
      markServeStarted = resolve;
    });
    const pendingServer = new Promise<{
      port: number;
      wsEndpoint: string;
      stop: () => Promise<void>;
    }>((resolve) => {
      resolveServe = resolve;
    });

    const running = runEntrypoint(
      {
        mode: "standalone",
        host: "localhost",
        port: 9222,
        cdpPort: 9223,
        headless: true,
      },
      {
        runtimePaths: {
          skillDir: "/skill",
        },
        serveStandalone: () => {
          markServeStarted();
          return pendingServer;
        },
        serveExtension: vi.fn(),
        registerShutdown: (callback) => {
          shutdown = callback;
        },
        keepAlive: async () => undefined,
        log: vi.fn(),
        preflightStandalone: async () => true,
      }
    );

    await serveStarted;
    let shutdownComplete = false;
    const stopping = shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    resolveServe({ port: 9222, wsEndpoint: "ws://browser.test/cdp", stop });
    await stopping;
    await running;
    expect(stop).toHaveBeenCalledOnce();
  });
});
