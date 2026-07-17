import { afterEach, describe, expect, it, vi } from "vitest";

const websocket = vi.hoisted(() => ({
  factories: [] as Array<(context: unknown) => Record<string, (...args: any[]) => unknown>>,
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(() => ({
    listening: true,
    close: (callback: (error?: Error) => void) => callback(),
  })),
}));

vi.mock("@hono/node-ws", () => ({
  createNodeWebSocket: () => ({
    injectWebSocket: vi.fn(),
    upgradeWebSocket: (
      factory: (context: unknown) => Record<string, (...args: any[]) => unknown>
    ) => {
      websocket.factories.push(factory);
      return () => new Response();
    },
  }),
}));

import {
  CDP_ORIGIN_POLICY_REASON,
  EXTENSION_ORIGIN_POLICY_REASON,
  WEBSOCKET_POLICY_VIOLATION_CODE,
  isTrustedCdpOrigin,
  isTrustedExtensionOrigin,
  serveRelay,
} from "./relay.js";

function requestContext(clientId?: string, origin?: string) {
  return {
    req: {
      param: () => clientId,
      header: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined),
    },
  };
}

afterEach(() => {
  websocket.factories.length = 0;
  vi.restoreAllMocks();
});

describe("extension socket ownership", () => {
  it("ignores messages from a replaced extension socket", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await serveRelay();
    const cdpHandlers = websocket.factories[0]?.(requestContext("test-client"));
    const extensionHandlers = websocket.factories[1]?.(requestContext());
    expect(cdpHandlers).toBeDefined();
    expect(extensionHandlers).toBeDefined();

    const oldExtension = { send: vi.fn(), close: vi.fn() };
    const currentExtension = { send: vi.fn(), close: vi.fn() };
    extensionHandlers?.onOpen?.({}, oldExtension);
    extensionHandlers?.onOpen?.({}, currentExtension);

    const client = { send: vi.fn(), close: vi.fn() };
    cdpHandlers?.onOpen?.({}, client);
    extensionHandlers?.onMessage?.(
      {
        data: JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "stale-session",
              targetInfo: {
                targetId: "stale-target",
                type: "page",
                title: "stale",
                url: "about:blank",
                attached: true,
              },
            },
          },
        }),
      },
      oldExtension
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    await server.stop();
  });

  it("closes a non-object extension message without throwing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await serveRelay();
    const extensionHandlers = websocket.factories[1]?.(requestContext());
    const extension = { send: vi.fn(), close: vi.fn() };
    extensionHandlers?.onOpen?.({}, extension);

    expect(() => extensionHandlers?.onMessage?.({ data: "null" }, extension)).not.toThrow();
    expect(extension.close).toHaveBeenCalledWith(1003, "Invalid extension message");
    await server.stop();
  });
});

describe("Playwright socket ownership", () => {
  async function setup() {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await serveRelay();
    const cdpFactory = websocket.factories[0];
    const extensionHandlers = websocket.factories[1]?.(requestContext());
    expect(cdpFactory).toBeDefined();
    expect(extensionHandlers).toBeDefined();

    const extension = { send: vi.fn(), close: vi.fn() };
    extensionHandlers?.onOpen?.({}, extension);
    const context = requestContext("reused-client");
    return {
      server,
      extension,
      extensionHandlers,
      oldHandlers: cdpFactory?.(context),
      newHandlers: cdpFactory?.(context),
    };
  }

  it("ignores messages from an old socket after its client ID is reused", async () => {
    const { server, oldHandlers, newHandlers } = await setup();
    const oldSocket = { send: vi.fn(), close: vi.fn() };
    const newSocket = { send: vi.fn(), close: vi.fn() };
    oldHandlers?.onOpen?.({}, oldSocket);
    oldHandlers?.onClose?.({}, oldSocket);
    newHandlers?.onOpen?.({}, newSocket);

    await oldHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 1, method: "Browser.getVersion" }) },
      oldSocket
    );

    expect(newSocket.send).not.toHaveBeenCalled();
    await server.stop();
  });

  it("does not deliver an old socket's delayed response to the new owner", async () => {
    const { server, extension, extensionHandlers, oldHandlers, newHandlers } = await setup();
    const oldSocket = { send: vi.fn(), close: vi.fn() };
    const newSocket = { send: vi.fn(), close: vi.fn() };
    oldHandlers?.onOpen?.({}, oldSocket);

    const handling = oldHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 7, method: "Runtime.enable" }) },
      oldSocket
    );
    const extensionRequest = JSON.parse(extension.send.mock.calls[0]?.[0]) as { id: number };
    oldHandlers?.onClose?.({}, oldSocket);
    newHandlers?.onOpen?.({}, newSocket);
    extensionHandlers?.onMessage?.(
      { data: JSON.stringify({ id: extensionRequest.id, result: {} }) },
      extension
    );
    await handling;

    expect(newSocket.send).not.toHaveBeenCalled();
    await server.stop();
  });

  it("does not let a delayed old close remove the new owner", async () => {
    const { server, oldHandlers, newHandlers } = await setup();
    const oldSocket = { send: vi.fn(), close: vi.fn() };
    const newSocket = { send: vi.fn(), close: vi.fn() };
    oldHandlers?.onOpen?.({}, oldSocket);
    oldHandlers?.onClose?.({}, oldSocket);
    newHandlers?.onOpen?.({}, newSocket);

    oldHandlers?.onClose?.({}, oldSocket);
    await newHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 2, method: "Browser.getVersion" }) },
      newSocket
    );

    expect(newSocket.send).toHaveBeenCalledWith(
      expect.stringContaining('"product":"Chrome/Extension-Bridge"')
    );
    await server.stop();
  });

  it("ignores non-object CDP messages without rejecting or closing the owner", async () => {
    const { server, oldHandlers } = await setup();
    const socket = { send: vi.fn(), close: vi.fn() };
    oldHandlers?.onOpen?.({}, socket);

    await expect(oldHandlers?.onMessage?.({ data: "null" }, socket)).resolves.toBeUndefined();
    await oldHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 2, method: "Browser.getVersion" }) },
      socket
    );

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('"product":"Chrome/Extension-Bridge"')
    );
    await server.stop();
  });
});

describe("relay Origin policy", () => {
  const chromeExtensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("allows only originless CDP clients", () => {
    expect(isTrustedCdpOrigin(undefined)).toBe(true);
    for (const origin of [
      "http://evil.example",
      "https://evil.example",
      "null",
      chromeExtensionOrigin,
    ]) {
      expect(isTrustedCdpOrigin(origin)).toBe(false);
    }
  });

  it("allows originless protocol extensions and valid Chrome extension origins", () => {
    expect(isTrustedExtensionOrigin(undefined)).toBe(true);
    expect(isTrustedExtensionOrigin(chromeExtensionOrigin)).toBe(true);
    for (const origin of [
      "http://evil.example",
      "https://evil.example",
      "null",
      "chrome-extension://not-a-valid-extension-id",
    ]) {
      expect(isTrustedExtensionOrigin(origin)).toBe(false);
    }
  });

  it("closes a browser-origin CDP socket without registering or routing buffered messages", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await serveRelay();
    const extensionHandlers = websocket.factories[1]?.(requestContext());
    const rejectedHandlers = websocket.factories[0]?.(
      requestContext("shared-client", "http://evil.example")
    );
    const trustedHandlers = websocket.factories[0]?.(requestContext("shared-client"));
    const extension = { send: vi.fn(), close: vi.fn() };
    const rejected = { send: vi.fn(), close: vi.fn() };
    const trusted = { send: vi.fn(), close: vi.fn() };
    extensionHandlers?.onOpen?.({}, extension);

    rejectedHandlers?.onOpen?.({}, rejected);
    await rejectedHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 1, method: "Runtime.enable" }) },
      rejected
    );
    trustedHandlers?.onOpen?.({}, trusted);
    await trustedHandlers?.onMessage?.(
      { data: JSON.stringify({ id: 2, method: "Browser.getVersion" }) },
      trusted
    );

    expect(rejected.close).toHaveBeenCalledWith(
      WEBSOCKET_POLICY_VIOLATION_CODE,
      CDP_ORIGIN_POLICY_REASON
    );
    expect(extension.send).not.toHaveBeenCalled();
    expect(trusted.send).toHaveBeenCalledWith(
      expect.stringContaining('"product":"Chrome/Extension-Bridge"')
    );
    await server.stop();
  });

  it("closes a browser-origin extension without replacing the current owner", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const server = await serveRelay();
    const currentHandlers = websocket.factories[1]?.(requestContext());
    const rejectedHandlers = websocket.factories[1]?.(
      requestContext(undefined, "http://evil.example")
    );
    const cdpHandlers = websocket.factories[0]?.(requestContext("trusted-client"));
    const current = { send: vi.fn(), close: vi.fn() };
    const rejected = { send: vi.fn(), close: vi.fn() };
    const client = { send: vi.fn(), close: vi.fn() };
    currentHandlers?.onOpen?.({}, current);
    cdpHandlers?.onOpen?.({}, client);

    rejectedHandlers?.onOpen?.({}, rejected);
    rejectedHandlers?.onMessage?.(
      {
        data: JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "evil-session",
              targetInfo: { targetId: "evil-target", type: "page", url: "about:blank" },
            },
          },
        }),
      },
      rejected
    );

    expect(rejected.close).toHaveBeenCalledWith(
      WEBSOCKET_POLICY_VIOLATION_CODE,
      EXTENSION_ORIGIN_POLICY_REASON
    );
    expect(current.close).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    await server.stop();
  });
});
