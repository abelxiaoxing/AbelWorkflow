import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import NodeWebSocket from "ws";

import {
  CDP_ORIGIN_POLICY_REASON,
  EXTENSION_ORIGIN_POLICY_REASON,
  WEBSOCKET_POLICY_VIOLATION_CODE,
  serveRelay,
  type RelayServer,
} from "./relay.js";

const CHROME_EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface FakeExtensionOptions {
  attach: "before" | number | false;
  detach?: number | false;
  disconnectAfterCreate?: boolean;
}

class FakeExtension {
  readonly closedTargets: string[] = [];
  readonly forwardedCommands: Array<{
    sessionId?: string;
    method?: string;
    params?: Record<string, unknown>;
  }> = [];
  private nextTarget = 1;

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: FakeExtensionOptions
  ) {
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
  }

  static async connect(endpoint: string, options: FakeExtensionOptions, origin?: string) {
    const socket = new NodeWebSocket(endpoint, origin ? { origin } : undefined);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("fake extension failed to connect")), {
        once: true,
      });
    });
    return new FakeExtension(socket as unknown as WebSocket, options);
  }

  close() {
    this.socket.close();
  }

  detachTarget(targetId: string) {
    this.sendDetach(`session-${targetId}`);
  }

  sendSessionEvent(targetId: string, method: string, params: Record<string, unknown>) {
    this.socket.send(JSON.stringify({
      method: "forwardCDPEvent",
      params: { method, params, sessionId: `session-${targetId}` },
    }));
  }

  private onMessage(raw: string) {
    const message = JSON.parse(raw) as {
      id: number;
      method: string;
      params?: {
        sessionId?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
    };
    if (message.method !== "forwardCDPCommand") return;

    const method = message.params?.method;
    this.forwardedCommands.push({
      sessionId: message.params?.sessionId,
      method,
      params: message.params?.params,
    });
    if (method === "Target.createTarget") {
      const targetId = `target-${this.nextTarget++}`;
      const sessionId = `session-${targetId}`;
      if (this.options.attach === "before") this.sendAttach(targetId, sessionId);
      this.respond(message.id, { targetId });
      if (typeof this.options.attach === "number") {
        setTimeout(() => this.sendAttach(targetId, sessionId), this.options.attach);
      }
      if (this.options.disconnectAfterCreate) this.socket.close();
      return;
    }

    if (method === "Target.closeTarget") {
      const targetId = message.params?.params?.targetId;
      if (typeof targetId !== "string") throw new Error("close targetId missing");
      this.closedTargets.push(targetId);
      this.respond(message.id, { success: true });
      if (typeof this.options.detach === "number") {
        setTimeout(() => this.sendDetach(`session-${targetId}`), this.options.detach);
      }
      return;
    }

    this.respond(message.id, {});
  }

  private respond(id: number, result: unknown) {
    this.socket.send(JSON.stringify({ id, result }));
  }

  private sendAttach(targetId: string, sessionId: string) {
    this.socket.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: {
              targetId,
              type: "page",
              title: targetId,
              url: "https://example.test/same",
              attached: true,
            },
          },
        },
      })
    );
  }

  private sendDetach(sessionId: string) {
    this.socket.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId },
        },
      })
    );
  }
}

const running: Array<{ server: RelayServer; extension?: FakeExtension }> = [];

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop();
    item?.extension?.close();
    await item?.server.stop();
  }
});

async function start(
  options: FakeExtensionOptions,
  targetTimeoutMs = 1500,
  extensionOrigin?: string
) {
  const port = await freePort();
  const server = await serveRelay({ host: "127.0.0.1", port, targetTimeoutMs });
  const extension = await FakeExtension.connect(
    `ws://127.0.0.1:${port}/extension`,
    options,
    extensionOrigin
  );
  const item = { server, extension };
  running.push(item);
  return { baseUrl: `http://127.0.0.1:${port}`, ...item };
}

async function postPage(baseUrl: string, name: string) {
  return fetch(`${baseUrl}/pages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

let nextCommandId = 0;

async function connectCdp(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP client failed to connect")), {
      once: true,
    });
  });
  return socket;
}

function nextCdpMessage(
  socket: WebSocket,
  predicate: (message: CdpMessage) => boolean
): Promise<CdpMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("CDP client disconnected"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
  });
}

async function sendCdpCommand(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string
): Promise<CdpMessage> {
  const id = ++nextCommandId;
  const response = nextCdpMessage(socket, (message) => message.id === id);
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return response;
}

async function autoAttachFirstPage(socket: WebSocket): Promise<CdpMessage> {
  const attached = nextCdpMessage(
    socket,
    (message) => message.method === "Target.attachedToTarget"
  );
  await sendCdpCommand(socket, "Target.setAutoAttach", {
    autoAttach: true,
    flatten: true,
    waitForDebuggerOnStart: true,
  });
  return attached;
}

describe("extension relay page backend", () => {
  it("returns 503 before the extension connects", async () => {
    const port = await freePort();
    const server = await serveRelay({ host: "127.0.0.1", port, targetTimeoutMs: 50 });
    running.push({ server });

    const response = await postPage(`http://127.0.0.1:${port}`, "work");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "extension not connected" });
  });

  it.each([
    ["before the create response", "before" as const],
    ["250ms after the create response", 250],
    ["1s after the create response", 1000],
  ])("binds the exact target when attach arrives %s", async (_label, attach) => {
    const { baseUrl } = await start({ attach });

    const response = await postPage(baseUrl, "work");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "work", targetId: "target-1" });
  });

  it("returns 504 when the exact attach never arrives", async () => {
    const { baseUrl } = await start({ attach: false }, 30);

    const response = await postPage(baseUrl, "work");

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Timed out waiting for target target-1 to attach after 30ms",
    });
  });

  it("keeps same-URL pages distinct by targetId and reuses a repeated name", async () => {
    const { baseUrl } = await start({ attach: "before" });

    const one = await (await postPage(baseUrl, "one")).json();
    const two = await (await postPage(baseUrl, "two")).json();
    const repeated = await (await postPage(baseUrl, "one")).json();

    expect(one).toMatchObject({ name: "one", targetId: "target-1" });
    expect(two).toMatchObject({ name: "two", targetId: "target-2" });
    expect(repeated).toEqual(one);
  });

  it("isolates temporary CDP sessions from the extension-owned page session", async () => {
    const { baseUrl, extension } = await start({ attach: "before" });
    const page = await (await postPage(baseUrl, "work")).json() as { targetId: string };
    const socket = await connectCdp(`${baseUrl.replace("http://", "ws://")}/cdp/test-client`);

    const attached = await autoAttachFirstPage(socket);
    const primarySessionId = attached.params?.sessionId;
    expect(typeof primarySessionId).toBe("string");

    const attachResponse = await sendCdpCommand(socket, "Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const temporarySessionId = attachResponse.result?.sessionId;
    expect(typeof temporarySessionId).toBe("string");
    expect(temporarySessionId).not.toBe(primarySessionId);

    const targetInfo = await sendCdpCommand(
      socket,
      "Target.getTargetInfo",
      {},
      temporarySessionId as string
    );
    expect(targetInfo.result?.targetInfo).toMatchObject({ targetId: page.targetId });

    const temporaryEvent = nextCdpMessage(
      socket,
      (message) => message.method === "Runtime.consoleAPICalled"
        && message.sessionId === temporarySessionId
    );
    extension.sendSessionEvent(page.targetId, "Runtime.consoleAPICalled", { type: "log" });
    await expect(temporaryEvent).resolves.toMatchObject({ sessionId: temporarySessionId });

    await sendCdpCommand(socket, "Target.detachFromTarget", {
      sessionId: temporarySessionId,
    });
    expect(extension.forwardedCommands).not.toContainEqual(
      expect.objectContaining({ method: "Target.detachFromTarget" })
    );

    await sendCdpCommand(socket, "Runtime.evaluate", { expression: "1" }, primarySessionId as string);
    expect(extension.forwardedCommands.at(-1)).toMatchObject({
      method: "Runtime.evaluate",
      sessionId: primarySessionId,
    });
    socket.close();
  });

  it("notifies primary and temporary sessions when the physical target detaches", async () => {
    const { baseUrl, extension } = await start({ attach: "before" });
    const page = await (await postPage(baseUrl, "work")).json() as { targetId: string };
    const socket = await connectCdp(`${baseUrl.replace("http://", "ws://")}/cdp/test-client`);

    const attached = await autoAttachFirstPage(socket);
    const primarySessionId = attached.params?.sessionId as string;
    const attachResponse = await sendCdpCommand(socket, "Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const temporarySessionId = attachResponse.result?.sessionId as string;
    expect(temporarySessionId).not.toBe(primarySessionId);

    const primaryDetached = nextCdpMessage(
      socket,
      (message) => message.method === "Target.detachedFromTarget"
        && message.params?.sessionId === primarySessionId
    );
    const temporaryDetached = nextCdpMessage(
      socket,
      (message) => message.method === "Target.detachedFromTarget"
        && message.params?.sessionId === temporarySessionId
    );
    extension.detachTarget(page.targetId);

    await expect(primaryDetached).resolves.toMatchObject({
      params: { sessionId: primarySessionId },
    });
    await expect(temporaryDetached).resolves.toMatchObject({
      params: { sessionId: temporarySessionId },
    });
    socket.close();
  });

  it("sends Target.closeTarget and waits for the matching detach", async () => {
    const { baseUrl, extension } = await start({ attach: "before", detach: 10 });
    await postPage(baseUrl, "work");

    const closed = await fetch(`${baseUrl}/pages/work`, { method: "DELETE" });
    const missing = await fetch(`${baseUrl}/pages/work`, { method: "DELETE" });

    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ success: true });
    expect(extension.closedTargets).toEqual(["target-1"]);
    expect(missing.status).toBe(404);
  });

  it("returns 504 and retains the mapping when detach never arrives", async () => {
    const { baseUrl } = await start({ attach: "before", detach: false }, 30);
    await postPage(baseUrl, "work");

    const response = await fetch(`${baseUrl}/pages/work`, { method: "DELETE" });
    const listed = await fetch(`${baseUrl}/pages`);

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "Timed out waiting for target target-1 to detach after 30ms",
    });
    expect(await listed.json()).toEqual({ pages: ["work"] });
  });

  it("rejects a pending attach immediately when the extension disconnects", async () => {
    const { baseUrl } = await start({ attach: false, disconnectAfterCreate: true }, 1000);

    const response = await postPage(baseUrl, "work");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "extension connection closed" });
  });
});

describe("relay Origin handshake boundary", () => {
  it("rejects a browser-origin CDP socket before registration or command routing", async () => {
    const { baseUrl, extension } = await start({ attach: "before" });
    const endpoint = `${baseUrl.replace("http://", "ws://")}/cdp/shared-client`;

    const rejected = await connectForPolicyClose(
      endpoint,
      "http://evil.example",
      JSON.stringify({ id: 1, method: "Runtime.enable" })
    );

    expect(rejected).toEqual({
      code: WEBSOCKET_POLICY_VIOLATION_CODE,
      reason: CDP_ORIGIN_POLICY_REASON,
      messages: [],
    });
    expect(extension.forwardedCommands).not.toContainEqual(
      expect.objectContaining({ method: "Runtime.enable" })
    );

    const trusted = await connectCdp(endpoint);
    await expect(sendCdpCommand(trusted, "Browser.getVersion")).resolves.toMatchObject({
      result: { product: "Chrome/Extension-Bridge" },
    });
    trusted.close();
  });

  it("rejects a browser-origin extension without replacing the current owner", async () => {
    const { baseUrl } = await start({ attach: "before" });
    const rejected = await connectForPolicyClose(
      `${baseUrl.replace("http://", "ws://")}/extension`,
      "http://evil.example",
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "evil-session",
            targetInfo: { targetId: "evil-target", type: "page", url: "about:blank" },
          },
        },
      })
    );

    expect(rejected).toEqual({
      code: WEBSOCKET_POLICY_VIOLATION_CODE,
      reason: EXTENSION_ORIGIN_POLICY_REASON,
      messages: [],
    });
    const response = await postPage(baseUrl, "still-owned");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ targetId: "target-1" });
  });

  it("accepts the Chrome extension Origin", async () => {
    const { baseUrl } = await start({ attach: "before" }, 1500, CHROME_EXTENSION_ORIGIN);

    const response = await postPage(baseUrl, "chrome-extension");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ targetId: "target-1" });
  });
});

function connectForPolicyClose(endpoint: string, origin: string, firstMessage: string) {
  return new Promise<{ code: number; reason: string; messages: string[] }>((resolve, reject) => {
    const socket = new NodeWebSocket(endpoint, { origin });
    const messages: string[] = [];
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Expected relay policy close"));
    }, 2000);
    socket.on("open", () => socket.send(firstMessage));
    socket.on("message", (data) => messages.push(String(data)));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString(), messages });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
