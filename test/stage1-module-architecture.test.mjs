import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);

test("legacy monolithic CLI modules stay deleted", () => {
  assert.equal(existsSync(new URL("lib/cli.mjs", repoRoot)), false);
  assert.equal(existsSync(new URL("lib/cli/logic.mjs", repoRoot)), false);
});

test("bin delegates exit handling to cli/main without calling process.exit", () => {
  const content = readFileSync(new URL("bin/abelworkflow.mjs", repoRoot), "utf8");
  assert.match(content, /from "\.\.\/lib\/cli\/main\.mjs"/u);
  assert.match(content, /process\.exitCode/u);
  assert.doesNotMatch(content, /process\.exit\s*\(/u);
});

test("main exposes the runtime-injected Promise<number> contract", async () => {
  const { main } = await import("../lib/cli/main.mjs");
  const runtime = {
    defaultAgentsDir: "/tmp/agents",
    inputIsTTY: false,
    outputIsTTY: false,
    resolvePath: (value) => value
  };
  assert.equal(await main(["--help"], runtime), 0);
});

test("lib module dependencies are acyclic and providers do not import installer internals", () => {
  const libUrl = new URL("lib/", repoRoot);
  const libPath = fileURLToPath(libUrl);
  const modules = [];
  const visitDirectory = (directoryUrl) => {
    for (const entry of readdirSync(directoryUrl, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name, directoryUrl);
      if (entry.isDirectory()) visitDirectory(new URL(`${entry.name}/`, directoryUrl));
      else if (entry.name.endsWith(".mjs")) modules.push(entryUrl);
    }
  };
  visitDirectory(libUrl);

  const graph = new Map();
  for (const moduleUrl of modules) {
    const modulePath = fileURLToPath(moduleUrl);
    const moduleName = relative(libPath, modulePath);
    const content = readFileSync(moduleUrl, "utf8");
    if (moduleName.startsWith("providers/") || moduleName.startsWith("tools/")) {
      assert.doesNotMatch(content, /from\s+["'][^"']*(?:cli|installer)\//u, moduleName);
    }
    const dependencies = [];
    for (const match of content.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
      const dependencyUrl = new URL(match[1], moduleUrl);
      const dependencyName = relative(libPath, fileURLToPath(dependencyUrl));
      if (!dependencyName.startsWith("..")) dependencies.push(dependencyName);
    }
    graph.set(moduleName, dependencies);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (moduleName, chain = []) => {
    if (visiting.has(moduleName)) {
      assert.fail(`circular dependency: ${[...chain, moduleName].join(" -> ")}`);
    }
    if (visited.has(moduleName)) return;
    visiting.add(moduleName);
    for (const dependency of graph.get(moduleName) ?? []) visit(dependency, [...chain, moduleName]);
    visiting.delete(moduleName);
    visited.add(moduleName);
  };
  for (const moduleName of graph.keys()) visit(moduleName);
});
