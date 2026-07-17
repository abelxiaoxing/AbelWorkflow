import { describe, expect, it, vi } from "vitest";

import { createTargetRegistry, type ConnectedTarget } from "./target-registry.js";

function target(targetId: string, sessionId = `session-${targetId}`): ConnectedTarget {
  return {
    targetId,
    sessionId,
    targetInfo: {
      targetId,
      type: "page",
      title: targetId,
      url: "https://example.test/same",
      attached: true,
    },
  };
}

describe("target registry attach waiters", () => {
  it("returns an already attached exact target", async () => {
    const registry = createTargetRegistry();
    registry.attach(target("target-1"));

    await expect(registry.waitForAttach("target-1", 100)).resolves.toMatchObject({
      targetId: "target-1",
      sessionId: "session-target-1",
    });
  });

  it("resolves only the waiter for the attached targetId", async () => {
    const registry = createTargetRegistry();
    let firstSettled = false;
    const first = registry.waitForAttach("target-1", 1000).finally(() => {
      firstSettled = true;
    });
    const second = registry.waitForAttach("target-2", 1000);

    registry.attach(target("target-2"));
    await expect(second).resolves.toMatchObject({ targetId: "target-2" });
    expect(firstSettled).toBe(false);

    registry.attach(target("target-1"));
    await expect(first).resolves.toMatchObject({ targetId: "target-1" });
  });

  it("cleans a timed out waiter", async () => {
    vi.useFakeTimers();
    try {
      const registry = createTargetRegistry();
      const waiting = registry.waitForAttach("target-1", 250);
      const rejection = expect(waiting).rejects.toThrow(
        "Timed out waiting for target target-1 to attach after 250ms"
      );

      await vi.advanceTimersByTimeAsync(250);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);

      const next = registry.waitForAttach("target-1", 250);
      registry.attach(target("target-1"));
      await expect(next).resolves.toMatchObject({ targetId: "target-1" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("target registry detach waiters", () => {
  it("removes target and name mappings only for the detached session", async () => {
    const registry = createTargetRegistry();
    registry.attach(target("target-1"));
    registry.attach(target("target-2"));
    registry.bindName("one", "target-1");
    registry.bindName("two", "target-2");
    const waiting = registry.waitForDetach("target-1", 1000);

    expect(registry.detach("session-target-1")?.targetId).toBe("target-1");
    await expect(waiting).resolves.toBeUndefined();
    expect(registry.getByName("one")).toBeUndefined();
    expect(registry.getByName("two")?.targetId).toBe("target-2");
  });

  it("treats detach-before-wait as already complete", async () => {
    const registry = createTargetRegistry();
    registry.attach(target("target-1"));
    registry.detach("session-target-1");

    await expect(registry.waitForDetach("target-1", 100)).resolves.toBeUndefined();
  });

  it("times out without deleting an attached target", async () => {
    vi.useFakeTimers();
    try {
      const registry = createTargetRegistry();
      registry.attach(target("target-1"));
      registry.bindName("one", "target-1");
      const waiting = registry.waitForDetach("target-1", 100);
      const rejection = expect(waiting).rejects.toThrow(
        "Timed out waiting for target target-1 to detach after 100ms"
      );

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(registry.getByName("one")?.targetId).toBe("target-1");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("target registry disconnect cleanup", () => {
  it("rejects pending attach and detach waiters and clears all state", async () => {
    vi.useFakeTimers();
    try {
      const registry = createTargetRegistry();
      registry.attach(target("attached"));
      registry.bindName("work", "attached");
      const attach = registry.waitForAttach("pending", 1000);
      const detach = registry.waitForDetach("attached", 1000);
      const attachRejection = expect(attach).rejects.toThrow("extension disconnected");
      const detachRejection = expect(detach).rejects.toThrow("extension disconnected");

      registry.disconnect(new Error("extension disconnected"));

      await attachRejection;
      await detachRejection;
      expect(registry.list()).toEqual([]);
      expect(registry.getByTargetId("attached")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
