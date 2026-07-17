import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);

const targetModules = [
  "lib/paths.mjs",
  "lib/cli/main.mjs",
  "lib/cli/args.mjs",
  "lib/cli/prompts.mjs",
  "lib/config/store.mjs",
  "lib/config/jsonc.mjs",
  "lib/config/dotenv.mjs",
  "lib/config/toml.mjs",
  "lib/installer/install.mjs",
  "lib/installer/assets.mjs",
  "lib/installer/render.mjs",
  "lib/installer/links.mjs",
  "lib/installer/state.mjs",
  "lib/providers/claude.mjs",
  "lib/providers/codex.mjs",
  "lib/providers/pi.mjs",
  "lib/providers/skills.mjs",
  "lib/tools/cli-installer.mjs"
];

test("stage 1 target modules replace the legacy CLI implementation", () => {
  for (const modulePath of targetModules) {
    assert.equal(existsSync(new URL(modulePath, repoRoot)), true, modulePath);
  }
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
