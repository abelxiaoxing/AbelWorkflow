import type { PageDescriptor } from "./page-api.js";

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  [key: string]: unknown;
}

export interface ConnectedTarget {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createTargetRegistry() {
  const byTargetId = new Map<string, ConnectedTarget>();
  const bySessionId = new Map<string, ConnectedTarget>();
  const names = new Map<string, string>();
  const attachWaiters = new Map<string, Set<Pending<ConnectedTarget>>>();
  const detachWaiters = new Map<string, Set<Pending<void>>>();

  function attach(target: ConnectedTarget) {
    const previousTarget = byTargetId.get(target.targetId);
    if (previousTarget) {
      bySessionId.delete(previousTarget.sessionId);
    }

    const previousSession = bySessionId.get(target.sessionId);
    if (previousSession && previousSession.targetId !== target.targetId) {
      removeTarget(previousSession);
    }

    byTargetId.set(target.targetId, target);
    bySessionId.set(target.sessionId, target);
    resolveWaiters(attachWaiters, target.targetId, target);
  }

  function detach(sessionId: string): ConnectedTarget | undefined {
    const target = bySessionId.get(sessionId);
    if (!target) return undefined;
    removeTarget(target);
    return target;
  }

  function removeTarget(target: ConnectedTarget) {
    bySessionId.delete(target.sessionId);
    byTargetId.delete(target.targetId);
    for (const [name, targetId] of names) {
      if (targetId === target.targetId) names.delete(name);
    }
    resolveWaiters(detachWaiters, target.targetId, undefined);
  }

  function updateTargetInfo(targetInfo: TargetInfo): ConnectedTarget | undefined {
    const target = byTargetId.get(targetInfo.targetId);
    if (!target) return undefined;
    target.targetInfo = targetInfo;
    return target;
  }

  function bindName(name: string, targetId: string) {
    if (!byTargetId.has(targetId)) {
      throw new Error(`Target ${targetId} is not attached`);
    }
    names.set(name, targetId);
  }

  function getByName(name: string): ConnectedTarget | undefined {
    const targetId = names.get(name);
    return targetId ? byTargetId.get(targetId) : undefined;
  }

  function list(): PageDescriptor[] {
    const pages: PageDescriptor[] = [];
    for (const [name, targetId] of names) {
      if (byTargetId.has(targetId)) pages.push({ name, targetId });
    }
    return pages;
  }

  function waitForAttach(targetId: string, timeoutMs: number): Promise<ConnectedTarget> {
    const existing = byTargetId.get(targetId);
    if (existing) return Promise.resolve(existing);
    return waitFor(
      attachWaiters,
      targetId,
      timeoutMs,
      `Timed out waiting for target ${targetId} to attach after ${timeoutMs}ms`
    );
  }

  function waitForDetach(targetId: string, timeoutMs: number): Promise<void> {
    if (!byTargetId.has(targetId)) return Promise.resolve();
    return waitFor(
      detachWaiters,
      targetId,
      timeoutMs,
      `Timed out waiting for target ${targetId} to detach after ${timeoutMs}ms`
    );
  }

  function disconnect(error: Error) {
    rejectAll(attachWaiters, error);
    rejectAll(detachWaiters, error);
    byTargetId.clear();
    bySessionId.clear();
    names.clear();
  }

  return {
    attach,
    detach,
    updateTargetInfo,
    bindName,
    getByName,
    getByTargetId: (targetId: string) => byTargetId.get(targetId),
    getBySessionId: (sessionId: string) => bySessionId.get(sessionId),
    targets: () => [...byTargetId.values()],
    list,
    waitForAttach,
    waitForDetach,
    disconnect,
  };
}

function waitFor<T>(
  waiters: Map<string, Set<Pending<T>>>,
  key: string,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending: Pending<T>;
    pending = {
      resolve,
      reject,
      timer: setTimeout(() => {
        removeWaiter(waiters, key, pending);
        reject(new Error(timeoutMessage));
      }, timeoutMs),
    };
    const entries = waiters.get(key) ?? new Set<Pending<T>>();
    entries.add(pending);
    waiters.set(key, entries);
  });
}

function removeWaiter<T>(
  waiters: Map<string, Set<Pending<T>>>,
  key: string,
  pending: Pending<T>
) {
  const entries = waiters.get(key);
  entries?.delete(pending);
  if (entries?.size === 0) waiters.delete(key);
}

function resolveWaiters<T>(
  waiters: Map<string, Set<Pending<T>>>,
  key: string,
  value: T
) {
  const entries = waiters.get(key);
  if (!entries) return;
  waiters.delete(key);
  for (const pending of entries) {
    clearTimeout(pending.timer);
    pending.resolve(value);
  }
}

function rejectAll<T>(waiters: Map<string, Set<Pending<T>>>, error: Error) {
  for (const entries of waiters.values()) {
    for (const pending of entries) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
  waiters.clear();
}
