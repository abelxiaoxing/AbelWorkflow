export const piInsecureTlsHeader = "x-abelworkflow-insecure-tls";

const installedFetchMarker = Symbol.for("abelworkflow.pi-provider-tls-fetch");
const undiciGlobalDispatchers = [
  Symbol.for("undici.globalDispatcher.2"),
  Symbol.for("undici.globalDispatcher.1")
];
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;

function getMarkedHeaders(input, init) {
  const source = init?.headers !== undefined
    ? init.headers
    : typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined;
  if (source === undefined) return null;

  const headers = new Headers(source);
  if (!headers.has(piInsecureTlsHeader)) return null;
  const allowedOrigin = headers.get(piInsecureTlsHeader);
  headers.delete(piInsecureTlsHeader);
  return { allowedOrigin, headers };
}

function getRequestUrl(input) {
  return typeof Request !== "undefined" && input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.href
      : input;
}

function getRequestOrigin(input) {
  try {
    return new URL(getRequestUrl(input)).origin;
  } catch {
    return null;
  }
}

function redirectRequestInit(input, init, status) {
  const method = String(init.method ?? (
    typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"
  )).toUpperCase();
  const switchToGet = status === 303 && method !== "HEAD"
    || (status === 301 || status === 302) && method === "POST";
  if (!switchToGet) {
    if (typeof Request !== "undefined" && input instanceof Request && method !== "GET" && method !== "HEAD") {
      throw new Error("Pi insecure TLS cannot safely replay a redirected Request body");
    }
    return init;
  }

  const headers = new Headers(init.headers);
  for (const name of ["content-encoding", "content-language", "content-length", "content-location", "content-type"]) {
    headers.delete(name);
  }
  const nextInit = { ...init, method: "GET", headers };
  delete nextInit.body;
  return nextInit;
}

async function fetchWithSameOriginRedirects({ fetchOnce, input, init, allowedOrigin }) {
  let nextInput = input;
  let nextInit = init;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchOnce(nextInput, nextInit);
    const location = redirectStatuses.has(response?.status) ? response.headers?.get?.("location") : null;
    if (!location) return response;
    if (redirectCount === maxRedirects) {
      await response.body?.cancel?.();
      throw new Error(`Pi insecure TLS exceeded ${maxRedirects} same-origin redirects`);
    }

    const target = new URL(location, getRequestUrl(nextInput));
    if (target.origin !== allowedOrigin) {
      await response.body?.cancel?.();
      throw new Error(`Pi insecure TLS blocked cross-origin redirect to ${target.origin}`);
    }
    await response.body?.cancel?.();
    nextInit = redirectRequestInit(nextInput, nextInit, response.status);
    nextInput = target.href;
  }
}

function applyNodeDispatcher(fetchImpl, input, init, dispatcherSource) {
  let dispatcher;
  try {
    dispatcher = typeof dispatcherSource === "function" ? dispatcherSource() : dispatcherSource;
  } catch (error) {
    return Promise.reject(error);
  }

  if (dispatcher && typeof dispatcher.then === "function") {
    return dispatcher.then((resolved) => applyNodeDispatcher(fetchImpl, input, init, resolved));
  }
  if (!dispatcher || typeof dispatcher.dispatch !== "function") {
    return Promise.reject(new Error("Pi insecure TLS requires an injected Undici dispatcher"));
  }
  return fetchImpl(input, { ...init, dispatcher });
}

function getUndiciDispatcherConstructor(target) {
  return undiciGlobalDispatchers
    .map((symbol) => target[symbol]?.constructor)
    .find((constructor) => typeof constructor === "function");
}

function initializeUndiciGlobalDispatcher(target) {
  if (typeof target.fetch !== "function") return;
  try {
    void Promise.resolve(target.fetch("data:,")).catch(() => {});
  } catch {
  }
}

export function createNodeInsecureDispatcher(target = globalThis) {
  let Dispatcher = getUndiciDispatcherConstructor(target);
  if (typeof Dispatcher !== "function") {
    initializeUndiciGlobalDispatcher(target);
    Dispatcher = getUndiciDispatcherConstructor(target);
  }
  if (typeof Dispatcher !== "function") {
    throw new Error("Pi insecure TLS requires the active Undici dispatcher");
  }
  return new Dispatcher({
    allowH2: false,
    connect: { rejectUnauthorized: false },
    requestTls: { rejectUnauthorized: false }
  });
}

export function createProviderTlsFetch({
  fetchImpl = globalThis.fetch,
  runtime = typeof globalThis.Bun === "undefined" ? "node" : "bun",
  insecureDispatcher
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  return function providerTlsFetch(input, init) {
    const marked = getMarkedHeaders(input, init);
    if (!marked) return fetchImpl(input, init);

    const nextInit = { ...(init ?? {}), headers: marked.headers };
    if (!marked.allowedOrigin || getRequestOrigin(input) !== marked.allowedOrigin) {
      return fetchImpl(input, nextInit);
    }

    nextInit.redirect = "manual";
    const fetchOnce = runtime === "bun"
      ? (nextInput, redirectInit) => {
          const tls = redirectInit.tls && typeof redirectInit.tls === "object" ? redirectInit.tls : {};
          return fetchImpl(nextInput, {
            ...redirectInit,
            tls: { ...tls, rejectUnauthorized: false }
          });
        }
      : (nextInput, redirectInit) => applyNodeDispatcher(
          fetchImpl,
          nextInput,
          redirectInit,
          insecureDispatcher
        );

    return fetchWithSameOriginRedirects({
      fetchOnce,
      input,
      init: nextInit,
      allowedOrigin: marked.allowedOrigin
    });
  };
}

export function installProviderTlsFetch({ target = globalThis, ...options } = {}) {
  if (target.fetch?.[installedFetchMarker]) return target.fetch;

  const wrapped = createProviderTlsFetch({
    ...options,
    fetchImpl: target.fetch.bind(target)
  });
  Object.defineProperty(wrapped, installedFetchMarker, { value: true });
  target.fetch = wrapped;
  return wrapped;
}
