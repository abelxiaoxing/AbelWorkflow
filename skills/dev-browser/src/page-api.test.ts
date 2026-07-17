import { describe, expect, it, vi } from "vitest";

import {
  PageBackendError,
  createPageApi,
  type PageBackend,
  type PageDescriptor,
  type Viewport,
} from "./page-api.js";

function createBackend() {
  const pages = new Map<string, PageDescriptor>();
  let nextTarget = 1;
  const backend: PageBackend = {
    async list() {
      return [...pages.values()];
    },
    async getOrCreate(name: string, _viewport?: Viewport) {
      const existing = pages.get(name);
      if (existing) return existing;
      const page = { name, targetId: `target-${nextTarget++}` };
      pages.set(name, page);
      return page;
    },
    async close(name: string) {
      return pages.delete(name);
    },
  };
  return { backend, pages };
}

describe("createPageApi", () => {
  it("lists, reuses, and closes named pages with stable response shapes", async () => {
    const { backend } = createBackend();
    const app = createPageApi({ backend, wsEndpoint: "ws://browser.test/cdp" });

    const empty = await app.request("/pages");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ pages: [] });

    const create = () =>
      app.request("/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "work", viewport: { width: 1280, height: 720 } }),
      });
    const first = await create();
    const second = await create();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      wsEndpoint: "ws://browser.test/cdp",
      name: "work",
      targetId: "target-1",
    });
    expect(await second.json()).toEqual({
      wsEndpoint: "ws://browser.test/cdp",
      name: "work",
      targetId: "target-1",
    });

    const listed = await app.request("/pages");
    expect(await listed.json()).toEqual({ pages: ["work"] });

    const closed = await app.request("/pages/work", { method: "DELETE" });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ success: true });

    const missing = await app.request("/pages/work", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "page not found" });
  });

  it.each([
    [{}, "name is required and must be a string"],
    [{ name: 1 }, "name is required and must be a string"],
    [{ name: "" }, "name cannot be empty"],
    [{ name: "x".repeat(257) }, "name must be 256 characters or less"],
    [{ name: "work", viewport: null }, "viewport must have positive integer width and height"],
    [
      { name: "work", viewport: { width: 0, height: 720 } },
      "viewport must have positive integer width and height",
    ],
    [
      { name: "work", viewport: { width: 1280.5, height: 720 } },
      "viewport must have positive integer width and height",
    ],
  ])("rejects invalid page input %#", async (body, message) => {
    const { backend } = createBackend();
    const app = createPageApi({ backend, wsEndpoint: "ws://browser.test/cdp" });
    const response = await app.request("/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  });

  it("returns a consistent error for invalid JSON", async () => {
    const { backend } = createBackend();
    const app = createPageApi({ backend, wsEndpoint: "ws://browser.test/cdp" });
    const response = await app.request("/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body must be valid JSON" });
  });

  it("rejects browser-origin and non-JSON page mutations before backend calls", async () => {
    const getOrCreate = vi.fn(async () => ({ name: "work", targetId: "target-1" }));
    const close = vi.fn(async () => true);
    const backend: PageBackend = { list: async () => [], getOrCreate, close };
    const app = createPageApi({ backend, wsEndpoint: "ws://browser.test/cdp" });

    const crossSite = await app.request("/pages", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ name: "cross-site" }),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "browser-origin requests are not allowed" });

    const nonJson = await app.request("/pages", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "non-json" }),
    });
    expect(nonJson.status).toBe(415);
    expect(await nonJson.json()).toEqual({ error: "content-type must be application/json" });

    const crossSiteDelete = await app.request("/pages/work", {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(crossSiteDelete.status).toBe(403);
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves explicit backend availability and timeout statuses", async () => {
    const unavailable = vi.fn().mockRejectedValue(
      new PageBackendError(503, "extension not connected")
    );
    const backend: PageBackend = {
      list: async () => [],
      getOrCreate: unavailable,
      close: async () => {
        throw new PageBackendError(504, "target detach timed out");
      },
    };
    const app = createPageApi({ backend, wsEndpoint: "ws://browser.test/cdp" });

    const create = await app.request("/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "work" }),
    });
    expect(create.status).toBe(503);
    expect(await create.json()).toEqual({ error: "extension not connected" });

    const close = await app.request("/pages/work", { method: "DELETE" });
    expect(close.status).toBe(504);
    expect(await close.json()).toEqual({ error: "target detach timed out" });
  });
});
