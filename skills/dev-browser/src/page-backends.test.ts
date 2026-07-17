import { describe, expect, it, vi } from "vitest";

import { createExtensionPageBackend } from "./relay.js";
import { createStandalonePageBackend } from "./standalone.js";
import { createTargetRegistry } from "./target-registry.js";
import { PageBackendError, type PageBackend } from "./page-api.js";

function standaloneBackend(): PageBackend {
  let nextTarget = 1;
  const context = {
    async newPage() {
      const listeners: Array<() => void> = [];
      const page = {
        targetId: `target-${nextTarget++}`,
        async setViewportSize() {},
        async close() {
          for (const listener of listeners) listener();
        },
        on(event: string, listener: () => void) {
          if (event === "close") listeners.push(listener);
        },
      };
      return page;
    },
    async newCDPSession(page: { targetId: string }) {
      return {
        async send() {
          return { targetInfo: { targetId: page.targetId } };
        },
        async detach() {},
      };
    },
  };
  return createStandalonePageBackend(context);
}

function extensionBackend(): PageBackend {
  const registry = createTargetRegistry();
  let nextTarget = 1;
  return createExtensionPageBackend({
    registry,
    isConnected: () => true,
    timeoutMs: 100,
    async sendCommand(method, params) {
      if (method === "Target.createTarget") {
        const targetId = `target-${nextTarget++}`;
        registry.attach({
          targetId,
          sessionId: `session-${targetId}`,
          targetInfo: {
            targetId,
            type: "page",
            title: targetId,
            url: "about:blank",
            attached: true,
          },
        });
        return { targetId };
      }
      if (method === "Target.closeTarget") {
        registry.detach(`session-${String(params?.targetId)}`);
        return { success: true };
      }
      return {};
    },
  });
}

describe.each([
  ["standalone", standaloneBackend],
  ["extension", extensionBackend],
] as const)("%s PageBackend contract", (_mode, createBackend) => {
  it("reuses names, lists descriptors, and closes physical targets", async () => {
    const backend = createBackend();

    const [first, repeated] = await Promise.all([
      backend.getOrCreate("one"),
      backend.getOrCreate("one"),
    ]);
    const second = await backend.getOrCreate("two");

    expect(repeated).toEqual(first);
    expect(second.targetId).not.toBe(first.targetId);
    await expect(backend.list()).resolves.toEqual([first, second]);
    await expect(backend.close("one")).resolves.toBe(true);
    await expect(backend.close("one")).resolves.toBe(false);
    await expect(backend.list()).resolves.toEqual([second]);
  });
});

describe("extension PageBackend cleanup", () => {
  it("closes the created target when waiting for its attach times out", async () => {
    const registry = createTargetRegistry();
    const sendCommand = vi.fn(async (method: string) =>
      method === "Target.createTarget"
        ? { targetId: "created-target" }
        : { success: true }
    );
    const backend = createExtensionPageBackend({
      registry,
      isConnected: () => true,
      sendCommand,
      timeoutMs: 1,
    });

    await expect(backend.getOrCreate("work")).rejects.toMatchObject({
      name: "PageBackendError",
      status: 504,
      message: "Timed out waiting for target created-target to attach after 1ms",
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, "Target.closeTarget", {
      targetId: "created-target",
    });
  });

  it("preserves the attach timeout when target cleanup fails", async () => {
    const registry = createTargetRegistry();
    const sendCommand = vi.fn(async (method: string) => {
      if (method === "Target.createTarget") return { targetId: "created-target" };
      throw new PageBackendError(503, "extension connection closed during cleanup");
    });
    const backend = createExtensionPageBackend({
      registry,
      isConnected: () => true,
      sendCommand,
      timeoutMs: 1,
    });

    await expect(backend.getOrCreate("work")).rejects.toMatchObject({
      name: "PageBackendError",
      status: 504,
      message: "Timed out waiting for target created-target to attach after 1ms",
    });
  });
});
