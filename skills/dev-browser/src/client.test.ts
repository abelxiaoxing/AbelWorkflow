import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, findPageByTargetId } from "./client.js";

const { connectOverCDP } = vi.hoisted(() => ({ connectOverCDP: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { connectOverCDP } }));

afterEach(() => {
  vi.unstubAllGlobals();
  connectOverCDP.mockReset();
});

describe("findPageByTargetId", () => {
  it("selects the exact target when two pages have the same URL", async () => {
    const first = { id: "target-1", url: () => "https://example.test/same" };
    const second = { id: "target-2", url: () => "https://example.test/same" };
    const context = {
      pages: () => [first, second],
      async newCDPSession(page: typeof first) {
        return {
          send: vi.fn().mockResolvedValue({ targetInfo: { targetId: page.id } }),
          detach: vi.fn().mockResolvedValue(undefined),
        };
      },
    };
    const browser = { contexts: () => [context] };

    await expect(findPageByTargetId(browser, "target-2")).resolves.toBe(second);
  });

  it("returns null instead of falling back to a URL or the first page", async () => {
    const first = { id: "target-1", url: () => "https://example.test/same" };
    const context = {
      pages: () => [first],
      async newCDPSession(page: typeof first) {
        return {
          send: vi.fn().mockResolvedValue({ targetInfo: { targetId: page.id } }),
          detach: vi.fn().mockResolvedValue(undefined),
        };
      },
    };

    await expect(
      findPageByTargetId({ contexts: () => [context] }, "target-missing")
    ).resolves.toBeNull();
  });
});

describe("server mode validation", () => {
  it("treats an absent mode as legacy standalone", async () => {
    const page = { id: "target-1" };
    connectOverCDP.mockResolvedValue({
      isConnected: () => true,
      contexts: () => [
        {
          pages: () => [page],
          newCDPSession: async () => ({
            send: async () => ({ targetInfo: { targetId: "target-1" } }),
            detach: async () => undefined,
          }),
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).endsWith("/pages")
                ? { targetId: "target-1" }
                : { wsEndpoint: "ws://browser.test/cdp" }
            ),
            { status: 200 }
          )
        )
      )
    );
    const client = await connect("http://browser.test");

    await expect(client.getServerInfo()).resolves.toEqual({
      wsEndpoint: "ws://browser.test/cdp",
      mode: "standalone",
      extensionConnected: undefined,
    });
    await expect(client.page("work")).resolves.toBe(page);
    expect(connectOverCDP).toHaveBeenCalledWith("ws://browser.test/cdp");
  });

  it.each([
    ["unsupported", "legacy", '"legacy"'],
    ["null", null, "null"],
  ])("rejects an explicit %s server mode", async (_label, mode, received) => {
    const body = { wsEndpoint: "ws://browser.test/cdp", mode };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).endsWith("/pages")
                ? { targetId: "target-1" }
                : body
            ),
            { status: 200 }
          )
        )
      )
    );
    const client = await connect("http://browser.test");
    const expected =
      `Invalid dev-browser server mode: expected "standalone" or "extension", received ${received}`;

    await expect(client.getServerInfo()).rejects.toThrow(expected);
    await expect(client.page("work")).rejects.toThrow(expected);
    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  it("rejects an empty websocket endpoint from info and page connection paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              String(input).endsWith("/pages")
                ? { targetId: "target-1" }
                : { wsEndpoint: "", mode: "standalone" }
            ),
            { status: 200 }
          )
        )
      )
    );
    const client = await connect("http://browser.test");
    const expected =
      "Invalid dev-browser wsEndpoint: expected a non-empty string, received \"\"";

    await expect(client.getServerInfo()).rejects.toThrow(expected);
    await expect(client.page("work")).rejects.toThrow(expected);
    expect(connectOverCDP).not.toHaveBeenCalled();
  });
});
