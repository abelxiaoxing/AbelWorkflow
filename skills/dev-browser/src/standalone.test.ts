import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  serveNode: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: dependencyMocks.serveNode }));
vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: dependencyMocks.launchPersistentContext },
}));

import { createStandaloneApp, createStandalonePageBackend, serve } from "./standalone.js";

afterEach(() => {
  dependencyMocks.launchPersistentContext.mockReset();
  dependencyMocks.serveNode.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createContextHarness() {
  let nextId = 1;
  const pages: Array<{
    targetId: string;
    closed: boolean;
    setViewportSize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    on: (event: string, listener: () => void) => void;
  }> = [];

  const context = {
    async newPage() {
      const closeListeners: Array<() => void> = [];
      const page = {
        targetId: `target-${nextId++}`,
        closed: false,
        setViewportSize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(async () => {
          page.closed = true;
          for (const listener of closeListeners) listener();
        }),
        on(event: string, listener: () => void) {
          if (event === "close") closeListeners.push(listener);
        },
      };
      pages.push(page);
      return page;
    },
    async newCDPSession(page: (typeof pages)[number]) {
      return {
        send: vi.fn().mockResolvedValue({ targetInfo: { targetId: page.targetId } }),
        detach: vi.fn().mockResolvedValue(undefined),
      };
    },
  };

  return { context, pages };
}

describe("standalone page backend", () => {
  it("reuses the same physical page for concurrent requests with the same name", async () => {
    const { context, pages } = createContextHarness();
    const backend = createStandalonePageBackend(context);

    const [first, second] = await Promise.all([
      backend.getOrCreate("work", { width: 1280, height: 720 }),
      backend.getOrCreate("work", { width: 800, height: 600 }),
    ]);

    expect(first).toEqual({ name: "work", targetId: "target-1" });
    expect(second).toEqual(first);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.setViewportSize).toHaveBeenCalledOnce();
    expect(pages[0]?.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    await expect(backend.list()).resolves.toEqual([first]);
  });

  it("closes the physical page and reports a second close as missing", async () => {
    const { context, pages } = createContextHarness();
    const backend = createStandalonePageBackend(context);
    await backend.getOrCreate("work");

    await expect(backend.close("work")).resolves.toBe(true);
    expect(pages[0]?.close).toHaveBeenCalledOnce();
    await expect(backend.close("work")).resolves.toBe(false);
    await expect(backend.list()).resolves.toEqual([]);
  });

  it("removes a page that is closed outside the API", async () => {
    const { context, pages } = createContextHarness();
    const backend = createStandalonePageBackend(context);
    await backend.getOrCreate("work");

    await pages[0]?.close();

    await expect(backend.list()).resolves.toEqual([]);
  });

  it("closes a page that arrives after page creation times out", async () => {
    vi.useFakeTimers();
    let resolvePage!: (page: Awaited<ReturnType<ReturnType<typeof createContextHarness>["context"]["newPage"]>>) => void;
    const { context, pages } = createContextHarness();
    const newPage = new Promise<(typeof pages)[number]>((resolve) => {
      resolvePage = resolve;
    });
    const backend = createStandalonePageBackend({
      ...context,
      newPage: vi.fn(() => newPage),
    });

    const creating = backend.getOrCreate("slow");
    const rejection = expect(creating).rejects.toThrow("Page creation timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    const latePage = (await createContextHarness().context.newPage()) as (typeof pages)[number];
    resolvePage(latePage);
    await vi.runAllTimersAsync();

    expect(latePage.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("standalone Hono app", () => {
  it("reports the authoritative standalone mode", async () => {
    const { context } = createContextHarness();
    const backend = createStandalonePageBackend(context);
    const app = createStandaloneApp({ backend, wsEndpoint: "ws://browser.test/cdp" });

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      wsEndpoint: "ws://browser.test/cdp",
      mode: "standalone",
    });
  });
});

describe("standalone server startup", () => {
  it("closes the browser context when HTTP listening fails asynchronously", async () => {
    const listenError = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      close: vi.fn(),
    });
    server.on("error", () => undefined);
    dependencyMocks.serveNode.mockImplementation(() => {
      queueMicrotask(() => server.emit("error", listenError));
      return server;
    });

    const close = vi.fn().mockResolvedValue(undefined);
    dependencyMocks.launchPersistentContext.mockResolvedValue({ close });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://browser.test/cdp" }))
      )
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      serve({ host: "127.0.0.1", port: 19222, cdpPort: 19223, headless: true })
    ).rejects.toBe(listenError);
    expect(dependencyMocks.launchPersistentContext).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ headless: true })
    );
    expect(close).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("HTTP API server running"));
  });
});
