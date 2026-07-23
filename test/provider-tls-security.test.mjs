import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const productionSources = [
  "../lib/providers/claude.mjs",
  "../lib/providers/codex.mjs",
  "../lib/providers/pi.mjs",
  "../extensions/pi-gpt-responses-compat/index.ts"
];

test("Provider configuration exposes no TLS verification bypass", () => {
  for (const relativePath of productionSources) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\binsecureTls\b/u, relativePath);
    assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/u, relativePath);
    assert.doesNotMatch(source, /跳过[^\n]*(?:TLS|SSL)|(?:TLS|SSL)[^\n]*跳过/iu, relativePath);
  }

  assert.equal(
    existsSync(new URL("../extensions/pi-gpt-responses-compat/tls-fetch.mjs", import.meta.url)),
    false
  );
});
