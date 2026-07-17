import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";

import { formatHttpUrl, formatWsUrl } from "./entrypoint.js";
import {
  PageBackendError,
  createPageApi,
  type PageBackend,
  type PageDescriptor,
} from "./page-api.js";
import {
  createTargetRegistry,
  type ConnectedTarget,
  type TargetInfo,
} from "./target-registry.js";

export interface RelayOptions {
  port?: number;
  host?: string;
  targetTimeoutMs?: number;
}

export interface RelayServer {
  wsEndpoint: string;
  port: number;
  stop(): Promise<void>;
}

export const WEBSOCKET_POLICY_VIOLATION_CODE = 1008;
export const CDP_ORIGIN_POLICY_REASON = "CDP endpoint requires an originless client";
export const EXTENSION_ORIGIN_POLICY_REASON =
  "Extension endpoint requires originless or chrome-extension client";

export function isTrustedCdpOrigin(origin: string | undefined): boolean {
  return origin === undefined;
}

export function isTrustedExtensionOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (
      url.protocol === "chrome-extension:" &&
      /^[a-p]{32}$/.test(url.hostname) &&
      (url.pathname === "" || url.pathname === "/") &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

interface PlaywrightClient {
  id: string;
  ws: WSContext;
  knownTargets: Set<string>;
  sessionAliases: Map<string, SessionAlias>;
}

interface SessionAlias {
  physicalSessionId: string;
  parentSessionId?: string;
}

interface ExtensionResponse {
  id: number;
  result?: unknown;
  error?: string;
}

interface ExtensionEvent {
  method: "forwardCDPEvent";
  params: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  };
}

interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CDPMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCdpCommand(value: unknown): value is CDPCommand {
  return isRecord(value)
    && typeof value.id === "number"
    && Number.isFinite(value.id)
    && typeof value.method === "string"
    && (value.params === undefined || isRecord(value.params))
    && (value.sessionId === undefined || typeof value.sessionId === "string");
}

type TargetRegistry = ReturnType<typeof createTargetRegistry>;

export function createExtensionPageBackend({
  registry,
  isConnected,
  sendCommand,
  timeoutMs,
}: {
  registry: TargetRegistry;
  isConnected: () => boolean;
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  timeoutMs: number;
}): PageBackend {
  const pending = new Map<string, Promise<PageDescriptor>>();

  async function create(name: string): Promise<PageDescriptor> {
    if (!isConnected()) throw new PageBackendError(503, "extension not connected");
    const result = (await sendCommand("Target.createTarget", { url: "about:blank" })) as {
      targetId?: unknown;
    };
    if (typeof result?.targetId !== "string" || result.targetId.length === 0) {
      throw new PageBackendError(502, "extension returned an invalid targetId");
    }
    if (!isConnected()) {
      throw new PageBackendError(503, "extension connection closed");
    }

    let target: ConnectedTarget;
    try {
      target = await registry.waitForAttach(result.targetId, timeoutMs);
    } catch (error) {
      if (error instanceof PageBackendError) throw error;
      const timeout = new PageBackendError(504, errorMessage(error));
      try {
        await sendCommand("Target.closeTarget", { targetId: result.targetId });
      } catch {}
      throw timeout;
    }
    registry.bindName(name, target.targetId);
    return { name, targetId: target.targetId };
  }

  return {
    async list() {
      return registry.list();
    },

    async getOrCreate(name) {
      const existing = registry.getByName(name);
      if (existing) return { name, targetId: existing.targetId };

      const inFlight = pending.get(name);
      if (inFlight) return inFlight;
      const creation = create(name);
      pending.set(name, creation);
      try {
        return await creation;
      } finally {
        if (pending.get(name) === creation) pending.delete(name);
      }
    },

    async close(name) {
      const target = registry.getByName(name);
      if (!target) return false;
      if (!isConnected()) throw new PageBackendError(503, "extension not connected");

      const result = (await sendCommand("Target.closeTarget", {
        targetId: target.targetId,
      })) as { success?: unknown };
      if (result?.success !== true) {
        throw new PageBackendError(502, `extension failed to close target ${target.targetId}`);
      }
      if (!isConnected()) {
        throw new PageBackendError(503, "extension connection closed");
      }
      try {
        await registry.waitForDetach(target.targetId, timeoutMs);
      } catch (error) {
        if (error instanceof PageBackendError) throw error;
        throw new PageBackendError(504, errorMessage(error));
      }
      return true;
    },
  };
}

export async function serveRelay(options: RelayOptions = {}): Promise<RelayServer> {
  const requestedPort = options.port ?? 9222;
  const host = options.host ?? "127.0.0.1";
  const targetTimeoutMs = options.targetTimeoutMs ?? 5000;
  const wsEndpoint = formatWsUrl(host, requestedPort, "/cdp");
  const registry = createTargetRegistry();
  const playwrightClients = new Map<string, PlaywrightClient>();
  const extensionPending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  let extensionWs: WSContext | null = null;
  let extensionMessageId = 0;
  let virtualSessionId = 0;

  function log(...args: unknown[]) {
    console.log("[relay]", ...args);
  }

  function isPlaywrightClientOwner(client: PlaywrightClient): boolean {
    return playwrightClients.get(client.id) === client;
  }

  function sendToPlaywright(message: CDPMessage, client?: PlaywrightClient) {
    const encoded = JSON.stringify(message);
    if (client) {
      if (isPlaywrightClientOwner(client)) client.ws.send(encoded);
      return;
    }
    for (const client of playwrightClients.values()) client.ws.send(encoded);
  }

  function sendAttached(target: ConnectedTarget, client?: PlaywrightClient) {
    const event: CDPMessage = {
      method: "Target.attachedToTarget",
      params: {
        sessionId: target.sessionId,
        targetInfo: { ...target.targetInfo, attached: true },
        waitingForDebugger: false,
      },
    };
    const clients = client ? [client] : playwrightClients.values();
    for (const owner of clients) {
      if (!isPlaywrightClientOwner(owner) || owner.knownTargets.has(target.targetId)) continue;
      owner.knownTargets.add(target.targetId);
      owner.ws.send(JSON.stringify(event));
    }
  }

  function createSessionAlias(
    client: PlaywrightClient,
    physicalSessionId: string,
    parentSessionId?: string
  ): string {
    let sessionId: string;
    do {
      sessionId = `dev-browser-virtual-${++virtualSessionId}`;
    } while (registry.getBySessionId(sessionId) || client.sessionAliases.has(sessionId));
    client.sessionAliases.set(sessionId, { physicalSessionId, parentSessionId });
    return sessionId;
  }

  function resolveSessionId(client: PlaywrightClient, sessionId?: string): string | undefined {
    return sessionId
      ? (client.sessionAliases.get(sessionId)?.physicalSessionId ?? sessionId)
      : undefined;
  }

  function sendSessionEvent(method: string, params: Record<string, unknown> | undefined, sessionId?: string) {
    for (const client of playwrightClients.values()) {
      client.ws.send(JSON.stringify({ method, params, sessionId } satisfies CDPMessage));
      if (!sessionId) continue;
      for (const [alias, binding] of client.sessionAliases) {
        if (binding.physicalSessionId !== sessionId) continue;
        client.ws.send(JSON.stringify({ method, params, sessionId: alias } satisfies CDPMessage));
      }
    }
  }

  function sendDetached(
    physicalSessionId: string,
    params: Record<string, unknown>,
    target?: ConnectedTarget
  ) {
    const physicalParams = { ...params, sessionId: physicalSessionId };
    for (const client of playwrightClients.values()) {
      if (target) client.knownTargets.delete(target.targetId);
      client.ws.send(
        JSON.stringify({ method: "Target.detachedFromTarget", params: physicalParams } satisfies CDPMessage)
      );
      for (const [alias, binding] of client.sessionAliases) {
        if (binding.physicalSessionId !== physicalSessionId) continue;
        client.sessionAliases.delete(alias);
        client.ws.send(
          JSON.stringify({
            method: "Target.detachedFromTarget",
            params: { ...params, sessionId: alias },
            sessionId: binding.parentSessionId,
          } satisfies CDPMessage)
        );
      }
    }
  }

  function rejectExtensionPending(error: Error) {
    for (const pending of extensionPending.values()) pending.reject(error);
    extensionPending.clear();
  }

  function closePlaywrightClients(reason: string) {
    for (const client of playwrightClients.values()) client.ws.close(1000, reason);
    playwrightClients.clear();
  }

  function disconnectExtension(error: PageBackendError) {
    rejectExtensionPending(error);
    registry.disconnect(error);
    extensionWs = null;
    closePlaywrightClients(error.message);
  }

  async function sendToExtension(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<unknown> {
    const ws = extensionWs;
    if (!ws) throw new PageBackendError(503, "extension not connected");
    const id = ++extensionMessageId;
    ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        extensionPending.delete(id);
        reject(new Error(`Extension request timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      extensionPending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  const sendCdpCommand = (method: string, params?: Record<string, unknown>) =>
    sendToExtension("forwardCDPCommand", { method, params });
  const pageBackend = createExtensionPageBackend({
    registry,
    isConnected: () => extensionWs !== null,
    sendCommand: sendCdpCommand,
    timeoutMs: targetTimeoutMs,
  });

  async function routeCdpCommand(
    client: PlaywrightClient,
    { method, params, sessionId }: Omit<CDPCommand, "id">
  ): Promise<unknown> {
    const physicalSessionId = resolveSessionId(client, sessionId);
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          revision: "1.0.0",
          userAgent: "dev-browser-relay/1.0.0",
          jsVersion: "V8",
        };
      case "Browser.setDownloadBehavior":
      case "Target.setDiscoverTargets":
        return {};
      case "Target.setAutoAttach":
        if (!sessionId) return {};
        break;
      case "Target.attachToBrowserTarget":
        return { sessionId: "browser" };
      case "Target.detachFromTarget": {
        const detachedSessionId = params?.sessionId;
        if (typeof detachedSessionId === "string" && client.sessionAliases.delete(detachedSessionId)) {
          return {};
        }
        if (sessionId === "browser" || params?.sessionId === "browser") return {};
        break;
      }
      case "Target.attachToTarget": {
        const targetId = params?.targetId;
        if (typeof targetId !== "string") throw new Error("targetId is required");
        const target = registry.getByTargetId(targetId);
        if (!target) throw new Error(`Target ${targetId} not found`);
        return {
          sessionId: createSessionAlias(client, target.sessionId, sessionId),
        };
      }
      case "Target.getTargetInfo": {
        const targetId = params?.targetId;
        const target =
          typeof targetId === "string"
            ? registry.getByTargetId(targetId)
            : physicalSessionId
              ? registry.getBySessionId(physicalSessionId)
              : undefined;
        return { targetInfo: target?.targetInfo };
      }
      case "Target.getTargets":
        return {
          targetInfos: registry.targets().map(({ targetInfo }) => ({
            ...targetInfo,
            attached: true,
          })),
        };
      case "Target.createTarget":
      case "Target.closeTarget":
        return sendCdpCommand(method, params);
    }

    return sendToExtension("forwardCDPCommand", {
      sessionId: physicalSessionId,
      method,
      params,
    });
  }

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.get("/", (c) =>
    c.json({
      wsEndpoint,
      extensionConnected: extensionWs !== null,
      mode: "extension" as const,
    })
  );
  app.route("/", createPageApi({ backend: pageBackend, wsEndpoint }));

  app.get(
    "/cdp/:clientId?",
    upgradeWebSocket((c) => {
      const clientId =
        c.req.param("clientId") ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const trustedOrigin = isTrustedCdpOrigin(c.req.header("origin"));
      return {
        onOpen(_event, ws) {
          if (!trustedOrigin) {
            ws.close(WEBSOCKET_POLICY_VIOLATION_CODE, CDP_ORIGIN_POLICY_REASON);
            return;
          }
          if (playwrightClients.has(clientId)) {
            ws.close(1000, "Client ID already connected");
            return;
          }
          playwrightClients.set(clientId, {
            id: clientId,
            ws,
            knownTargets: new Set(),
            sessionAliases: new Map(),
          });
        },
        async onMessage(event, ws) {
          if (!trustedOrigin) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data.toString());
          } catch {
            return;
          }
          if (!isCdpCommand(parsed)) return;
          const command = parsed;
          const { id, method, params, sessionId } = command;
          const client = playwrightClients.get(clientId);
          if (!client || client.ws !== ws) return;
          if (!extensionWs) {
            sendToPlaywright({ id, sessionId, error: { message: "extension not connected" } }, client);
            return;
          }
          try {
            const result = await routeCdpCommand(client, { method, params, sessionId });
            if (method === "Target.setAutoAttach" && !sessionId) {
              for (const target of registry.targets()) sendAttached(target, client);
            }
            if (method === "Target.setDiscoverTargets" && params?.discover === true) {
              for (const target of registry.targets()) {
                sendToPlaywright(
                  {
                    method: "Target.targetCreated",
                    params: { targetInfo: { ...target.targetInfo, attached: true } },
                  },
                  client
                );
              }
            }
            if (method === "Target.attachToTarget") {
              const targetId = params?.targetId;
              if (typeof targetId === "string") {
                const target = registry.getByTargetId(targetId);
                if (target) sendAttached(target, client);
              }
            }
            sendToPlaywright({ id, sessionId, result }, client);
          } catch (error) {
            sendToPlaywright({ id, sessionId, error: { message: errorMessage(error) } }, client);
          }
        },
        onClose(_event, ws) {
          if (!trustedOrigin) return;
          const client = playwrightClients.get(clientId);
          if (client?.ws === ws) playwrightClients.delete(clientId);
        },
      };
    })
  );

  app.get(
    "/extension",
    upgradeWebSocket((c) => {
      const trustedOrigin = isTrustedExtensionOrigin(c.req.header("origin"));
      return {
        onOpen(_event, ws) {
          if (!trustedOrigin) {
            ws.close(WEBSOCKET_POLICY_VIOLATION_CODE, EXTENSION_ORIGIN_POLICY_REASON);
            return;
          }
          if (extensionWs) {
            const old = extensionWs;
            disconnectExtension(new PageBackendError(503, "extension connection replaced"));
            old.close(4001, "Extension replaced");
          }
          extensionWs = ws;
          log("Extension connected");
        },
        onMessage(event, ws) {
          if (!trustedOrigin) return;
          if (extensionWs !== ws) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data.toString());
          } catch {
            ws.close(1000, "Invalid JSON");
            return;
          }
          if (!isRecord(parsed)) {
            ws.close(1003, "Invalid extension message");
            return;
          }
          const message = parsed as ExtensionResponse | ExtensionEvent | {
            method: "log";
            params: unknown;
          };

          if ("id" in message) {
            if (typeof message.id !== "number") return;
            const pending = extensionPending.get(message.id);
            if (!pending) return;
            extensionPending.delete(message.id);
            if (message.error) pending.reject(new PageBackendError(502, message.error));
            else pending.resolve(message.result);
            return;
          }

          if (message.method !== "forwardCDPEvent") return;
          const { method, params, sessionId } = message.params;
          if (method === "Target.attachedToTarget") {
            const attached = params as unknown as {
              sessionId: string;
              targetInfo: TargetInfo;
            };
            const target: ConnectedTarget = {
              sessionId: attached.sessionId,
              targetId: attached.targetInfo.targetId,
              targetInfo: attached.targetInfo,
            };
            registry.attach(target);
            sendAttached(target);
            return;
          }
          if (method === "Target.detachedFromTarget") {
            const detached = params as Record<string, unknown> & { sessionId: string };
            const target = registry.detach(detached.sessionId);
            sendDetached(detached.sessionId, detached, target);
            return;
          }
          if (method === "Target.targetInfoChanged") {
            const changed = params as unknown as { targetInfo: TargetInfo };
            registry.updateTargetInfo(changed.targetInfo);
            sendToPlaywright({ method, params: changed });
            return;
          }
          sendSessionEvent(method, params, sessionId);
        },
        onClose(_event, ws) {
          if (!trustedOrigin) return;
          if (extensionWs !== ws) return;
          log("Extension disconnected");
          disconnectExtension(new PageBackendError(503, "extension connection closed"));
        },
      };
    })
  );

  const server = serve({ fetch: app.fetch, port: requestedPort, hostname: host });
  injectWebSocket(server);
  await waitForListening(server);
  log(`HTTP: ${formatHttpUrl(host, requestedPort)}`);

  let stopped = false;
  return {
    wsEndpoint,
    port: requestedPort,
    async stop() {
      if (stopped) return;
      stopped = true;
      const ws = extensionWs;
      disconnectExtension(new PageBackendError(503, "relay server stopped"));
      ws?.close(1000, "Server stopped");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function waitForListening(server: ReturnType<typeof serve>): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
