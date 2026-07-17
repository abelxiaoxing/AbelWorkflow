import { once } from "node:events";
import type { Socket } from "node:net";

import { serve as serveNode } from "@hono/node-server";
import { Hono } from "hono";
import { chromium, type BrowserContext } from "playwright";

import { formatHttpUrl } from "./entrypoint.js";
import {
  createPageApi,
  type PageBackend,
  type PageDescriptor,
  type Viewport,
} from "./page-api.js";
import type { ServeOptions } from "./types.js";

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

interface StandalonePage {
  setViewportSize(viewport: Viewport): Promise<void>;
  close(): Promise<void>;
  on(event: "close", listener: () => void): void;
}

interface StandaloneContext {
  newPage(): Promise<StandalonePage>;
  newCDPSession(page: StandalonePage): Promise<{
    send(method: "Target.getTargetInfo"): Promise<{ targetInfo: { targetId: string } }>;
    detach(): Promise<void>;
  }>;
}

interface PageEntry extends PageDescriptor {
  page: StandalonePage;
}

export function createStandalonePageBackend(context: StandaloneContext): PageBackend {
  const pages = new Map<string, PageEntry>();
  const pending = new Map<string, Promise<PageDescriptor>>();

  async function create(name: string, viewport?: Viewport): Promise<PageDescriptor> {
    const pagePromise = context.newPage();
    let page: StandalonePage;
    try {
      page = await withTimeout(pagePromise, 30_000, "Page creation timed out after 30000ms");
    } catch (error) {
      void pagePromise.then(
        (latePage) => latePage.close().catch(() => undefined),
        () => undefined
      );
      throw error;
    }
    try {
      if (viewport) await page.setViewportSize(viewport);
      const session = await context.newCDPSession(page);
      let targetId: string;
      try {
        ({ targetInfo: { targetId } } = await session.send("Target.getTargetInfo"));
      } finally {
        await session.detach();
      }

      const entry: PageEntry = { name, targetId, page };
      pages.set(name, entry);
      page.on("close", () => {
        if (pages.get(name) === entry) pages.delete(name);
      });
      return { name, targetId };
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  return {
    async list() {
      return [...pages.values()].map(({ name, targetId }) => ({ name, targetId }));
    },

    async getOrCreate(name, viewport) {
      const existing = pages.get(name);
      if (existing) return { name, targetId: existing.targetId };

      const inFlight = pending.get(name);
      if (inFlight) return inFlight;

      const creation = create(name, viewport);
      pending.set(name, creation);
      try {
        return await creation;
      } finally {
        if (pending.get(name) === creation) pending.delete(name);
      }
    },

    async close(name) {
      const entry = pages.get(name);
      if (!entry) return false;
      await entry.page.close();
      if (pages.get(name) === entry) pages.delete(name);
      return true;
    },
  };
}

export function createStandaloneApp({
  backend,
  wsEndpoint,
}: {
  backend: PageBackend;
  wsEndpoint: string;
}) {
  const app = new Hono();
  app.get("/", (c) => c.json({ wsEndpoint, mode: "standalone" as const }));
  app.route("/", createPageApi({ backend, wsEndpoint }));
  return app;
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  const port = options.port ?? 9222;
  const host = options.host ?? "localhost";
  const cdpPort = options.cdpPort ?? 9223;
  validatePorts(port, cdpPort);

  const context = await chromium.launchPersistentContext("", {
    headless: options.headless ?? false,
    args: [`--remote-debugging-port=${cdpPort}`],
  });

  try {
    const response = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
    const { webSocketDebuggerUrl: wsEndpoint } = (await response.json()) as {
      webSocketDebuggerUrl: string;
    };
    const backend = createStandalonePageBackend(
      context as unknown as StandaloneContext
    );
    const app = createStandaloneApp({ backend, wsEndpoint });
    const server = serveNode({ fetch: app.fetch, port, hostname: host });
    const connections = new Set<Socket>();
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
    });
    await once(server, "listening");

    console.log(`HTTP API server running on ${formatHttpUrl(host, port)}`);
    let stopped = false;
    return {
      wsEndpoint,
      port,
      async stop() {
        if (stopped) return;
        stopped = true;
        for (const socket of connections) socket.destroy();
        connections.clear();
        for (const { name } of await backend.list()) {
          await backend.close(name).catch(() => undefined);
        }
        await context.close().catch(() => undefined);
        await closeServer(server);
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

function validatePorts(port: number, cdpPort: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be between 1 and 65535`);
  }
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be between 1 and 65535`);
  }
  if (port === cdpPort) throw new Error("port and cdpPort must be different");
}

async function fetchWithRetry(url: string, maxRetries = 5, delayMs = 500) {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed after ${maxRetries} retries: ${message}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function closeServer(server: ReturnType<typeof serveNode>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export type { ServeOptions } from "./types.js";
