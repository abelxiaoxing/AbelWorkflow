import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createNodeInsecureDispatcher,
  createProviderTlsFetch,
  installProviderTlsFetch,
  piInsecureTlsHeader
} from "../extensions/pi-gpt-responses-compat/tls-fetch.mjs";

function createRecorder(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    fetchImpl(input, init) {
      calls.push([input, init]);
      return Promise.resolve(result);
    }
  };
}

test("strict requests are forwarded without cloning input or init", async () => {
  const recorder = createRecorder();
  const input = new Request("https://relay.example/v1/responses");
  const init = { method: "POST", headers: { authorization: "Bearer secret" } };
  const wrapped = createProviderTlsFetch({
    fetchImpl: recorder.fetchImpl,
    runtime: "node",
    insecureDispatcher: { dispatch() {} }
  });

  await wrapped(input, init);

  assert.equal(recorder.calls.length, 1);
  assert.strictEqual(recorder.calls[0][0], input);
  assert.strictEqual(recorder.calls[0][1], init);
});

test("Node requests with the marker use only the injected dispatcher", async () => {
  const recorder = createRecorder();
  const insecureDispatcher = { dispatch() {} };
  const init = {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      [piInsecureTlsHeader]: "https://relay.example"
    }
  };
  const wrapped = createProviderTlsFetch({
    fetchImpl: recorder.fetchImpl,
    runtime: "node",
    insecureDispatcher
  });

  await wrapped("https://relay.example/v1/responses", init);

  const nextInit = recorder.calls[0][1];
  assert.strictEqual(nextInit.dispatcher, insecureDispatcher);
  assert.equal(nextInit.redirect, "manual");
  assert.equal(nextInit.headers.get(piInsecureTlsHeader), null);
  assert.equal(nextInit.headers.get("authorization"), "Bearer secret");
  assert.equal(init.headers[piInsecureTlsHeader], "https://relay.example");
});

test("Node insecure dispatcher preserves environment proxy routing options", () => {
  class EnvironmentDispatcher {
    constructor(options) {
      this.options = options;
    }

    dispatch() {}
  }
  class LegacyDispatcher {
    dispatch() {}
  }
  const target = {
    [Symbol.for("undici.globalDispatcher.2")]: new EnvironmentDispatcher({}),
    [Symbol.for("undici.globalDispatcher.1")]: new LegacyDispatcher()
  };

  const dispatcher = createNodeInsecureDispatcher(target);

  assert.ok(dispatcher instanceof EnvironmentDispatcher);
  assert.deepEqual(dispatcher.options, {
    allowH2: false,
    connect: { rejectUnauthorized: false },
    requestTls: { rejectUnauthorized: false }
  });
});

test("Node insecure dispatcher supports the legacy Undici global symbol", () => {
  class LegacyEnvironmentDispatcher {
    constructor(options) {
      this.options = options;
    }

    dispatch() {}
  }
  const target = {
    [Symbol.for("undici.globalDispatcher.1")]: new LegacyEnvironmentDispatcher({})
  };

  const dispatcher = createNodeInsecureDispatcher(target);

  assert.ok(dispatcher instanceof LegacyEnvironmentDispatcher);
  assert.deepEqual(dispatcher.options, {
    allowH2: false,
    connect: { rejectUnauthorized: false },
    requestTls: { rejectUnauthorized: false }
  });
});

test("Node insecure dispatcher initializes a lazy native fetch runtime", () => {
  class LazyEnvironmentDispatcher {
    constructor(options) {
      this.options = options;
    }

    dispatch() {}
  }
  const symbol = Symbol.for("undici.globalDispatcher.1");
  const target = {
    fetchCalls: 0,
    fetch() {
      this.fetchCalls += 1;
      this[symbol] = new LazyEnvironmentDispatcher({});
      return Promise.resolve(new Response(null));
    }
  };

  const dispatcher = createNodeInsecureDispatcher(target);

  assert.equal(target.fetchCalls, 1);
  assert.ok(dispatcher instanceof LazyEnvironmentDispatcher);
});

test("Bun requests with the marker use request-scoped TLS options", async () => {
  const recorder = createRecorder();
  const wrapped = createProviderTlsFetch({ fetchImpl: recorder.fetchImpl, runtime: "bun" });

  await wrapped("https://relay.example/v1/responses", {
    headers: { [piInsecureTlsHeader]: "https://relay.example" },
    tls: { serverName: "relay.example" }
  });

  const nextInit = recorder.calls[0][1];
  assert.deepEqual(nextInit.tls, {
    serverName: "relay.example",
    rejectUnauthorized: false
  });
  assert.equal(nextInit.headers.get(piInsecureTlsHeader), null);
  assert.equal(nextInit.redirect, "manual");
  assert.ok(!("dispatcher" in nextInit));
});

test("origin mismatches are stripped without bypassing TLS", async () => {
  const recorder = createRecorder();
  const wrapped = createProviderTlsFetch({
    fetchImpl: recorder.fetchImpl,
    runtime: "node",
    insecureDispatcher: { dispatch() {} }
  });

  await wrapped("https://relay.example/v1/responses", {
    headers: {
      [piInsecureTlsHeader]: "https://different.example",
      "x-existing": "keep"
    },
    redirect: "follow"
  });

  const nextInit = recorder.calls[0][1];
  assert.equal(nextInit.headers.get(piInsecureTlsHeader), null);
  assert.equal(nextInit.headers.get("x-existing"), "keep");
  assert.ok(!("dispatcher" in nextInit));
  assert.ok(!("tls" in nextInit));
  assert.equal(nextInit.redirect, "follow");
});

test("marked requests follow bounded same-origin redirects", async () => {
  const calls = [];
  const dispatcher = { dispatch() {} };
  const wrapped = createProviderTlsFetch({
    runtime: "node",
    insecureDispatcher: dispatcher,
    fetchImpl(input, init) {
      calls.push([input, init]);
      return Promise.resolve(calls.length === 1
        ? new Response(null, {
            status: 307,
            headers: { location: "/v1/responses/" }
          })
        : new Response("ok"));
    }
  });

  const response = await wrapped("https://relay.example/v1/responses", {
    method: "POST",
    body: "{}",
    headers: { [piInsecureTlsHeader]: "https://relay.example" }
  });

  assert.equal(await response.text(), "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "https://relay.example/v1/responses/");
  assert.equal(calls[1][1].method, "POST");
  assert.equal(calls[1][1].body, "{}");
  assert.strictEqual(calls[1][1].dispatcher, dispatcher);
});

test("marked requests reject cross-origin redirects", async () => {
  const recorder = createRecorder(new Response(null, {
    status: 307,
    headers: { location: "https://different.example/v1/responses" }
  }));
  const wrapped = createProviderTlsFetch({
    fetchImpl: recorder.fetchImpl,
    runtime: "bun"
  });

  await assert.rejects(
    wrapped("https://relay.example/v1/responses", {
      headers: { [piInsecureTlsHeader]: "https://relay.example" }
    }),
    /blocked cross-origin redirect/u
  );
  assert.equal(recorder.calls.length, 1);
});

test("markers on Request inputs are removed before dispatch", async () => {
  const recorder = createRecorder();
  const insecureDispatcher = { dispatch() {} };
  const input = new Request("https://relay.example/v1/responses", {
    headers: {
      [piInsecureTlsHeader]: "https://relay.example",
      accept: "application/json"
    }
  });
  const wrapped = createProviderTlsFetch({
    fetchImpl: recorder.fetchImpl,
    runtime: "node",
    insecureDispatcher
  });

  await wrapped(input);

  assert.strictEqual(recorder.calls[0][0], input);
  assert.equal(recorder.calls[0][1].headers.get(piInsecureTlsHeader), null);
  assert.equal(recorder.calls[0][1].headers.get("accept"), "application/json");
  assert.strictEqual(recorder.calls[0][1].dispatcher, insecureDispatcher);
  assert.equal(recorder.calls[0][1].redirect, "manual");
});

test("Node marked requests fail closed when no dispatcher is available", async () => {
  const recorder = createRecorder();
  const wrapped = createProviderTlsFetch({ fetchImpl: recorder.fetchImpl, runtime: "node" });

  await assert.rejects(
    wrapped("https://relay.example/v1/responses", {
      headers: { [piInsecureTlsHeader]: "https://relay.example" }
    }),
    /Undici dispatcher/u
  );
  assert.equal(recorder.calls.length, 0);
});

test("global installation is idempotent", async () => {
  const recorder = createRecorder();
  const target = { fetch: recorder.fetchImpl };
  const options = {
    target,
    runtime: "node",
    insecureDispatcher: { dispatch() {} }
  };

  const first = installProviderTlsFetch(options);
  const second = installProviderTlsFetch(options);

  assert.strictEqual(first, second);
  assert.strictEqual(target.fetch, first);
  await target.fetch("https://strict.example");
  assert.equal(recorder.calls.length, 1);
});

test("Pi extension does not disable TLS verification for the process", () => {
  const content = readFileSync(
    new URL("../extensions/pi-gpt-responses-compat/index.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(content, /NODE_TLS_REJECT_UNAUTHORIZED/u);
  assert.doesNotMatch(content, /import\("undici"\)/u);
  assert.match(content, /createNodeInsecureDispatcher/u);
  assert.match(content, /installProviderTlsFetch/u);
});
