import { existsSync } from "node:fs";
import { createServer } from "node:net";

import { chromium } from "playwright";
import { expect, it } from "vitest";

import { connect } from "./client.js";
import { serve } from "./standalone.js";

const browserExecutableExists = existsSync(chromium.executablePath());
if (process.env.CI && !browserExecutableExists) {
  throw new Error(
    "Playwright Chromium is required in CI; run `npx playwright install --with-deps chromium`"
  );
}
const browserTest = browserExecutableExists ? it : it.skip;

browserTest("runs the named-page contract against real headless Chromium", async () => {
  const [port, cdpPort] = await freePorts();
  const server = await serve({ host: "127.0.0.1", port, cdpPort, headless: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = await connect(baseUrl);

  try {
    const create = (name: string) =>
      fetch(`${baseUrl}/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((response) => response.json() as Promise<{ targetId: string }>);
    const firstDescriptor = await create("one");
    const secondDescriptor = await create("two");
    expect(firstDescriptor.targetId).not.toBe(secondDescriptor.targetId);
    await expect(create("one")).resolves.toEqual(firstDescriptor);

    const first = await client.page("one");
    const second = await client.page("two");
    const sameUrl = "data:text/html,<title>same</title>";
    await first.goto(sameUrl);
    await second.goto(sameUrl);
    await first.evaluate(() => {
      (globalThis as typeof globalThis & { pageMarker?: string }).pageMarker = "one";
    });
    await second.evaluate(() => {
      (globalThis as typeof globalThis & { pageMarker?: string }).pageMarker = "two";
    });
    await expect(
      first.evaluate(
        () => (globalThis as typeof globalThis & { pageMarker?: string }).pageMarker
      )
    ).resolves.toBe("one");
    await expect(
      second.evaluate(
        () => (globalThis as typeof globalThis & { pageMarker?: string }).pageMarker
      )
    ).resolves.toBe("two");

    await expect(client.list()).resolves.toEqual(["one", "two"]);
    await client.close("one");
    expect(first.isClosed()).toBe(true);
    const missing = await fetch(`${baseUrl}/pages/one`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  } finally {
    await client.disconnect();
    await server.stop();
  }
}, 60_000);

async function freePorts(): Promise<[number, number]> {
  const first = await reservePort();
  let second = await reservePort();
  while (second === first) second = await reservePort();
  return [first, second];
}

function reservePort(): Promise<number> {
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
