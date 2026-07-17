import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

async function npmPackFileNames() {
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "package contract must run through an npm script");
  const result = spawnSync(
    process.execPath,
    [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_cache: join(tmpdir(), "abelworkflow-package-contract-cache"),
        npm_config_update_notifier: "false"
      }
    }
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `npm pack failed: ${result.error?.message ?? result.stderr.slice(-2000)}`
  );
  assert.notEqual(result.stdout.trim(), "", "npm pack must return a JSON report");
  const payload = JSON.parse(result.stdout);
  const reports = Array.isArray(payload) ? payload : Object.values(payload);
  assert.equal(reports.length, 1);
  return reports[0].files.map(({ path }) => path).sort();
}

test("package configuration has one runtime-only publication boundary", () => {
  const packageJson = readJson("package.json");

  for (const path of [
    "bin",
    "lib",
    "README.md",
    "extensions",
    "skills/dev-browser/dist",
    "skills/dev-browser/package-lock.json",
    "skills/dev-browser/package.json",
    "skills/grok-search/scripts/groksearch_entry.py"
  ]) {
    assert.equal(packageJson.files.includes(path), true, `missing package allowlist entry: ${path}`);
  }
  assert.equal(packageJson.files.includes("skills"), false);
  assert.equal(packageJson.scripts.prepack, "npm run build");
  assert.equal(
    packageJson.scripts["check:package"],
    "node --test test/package-contents.test.mjs"
  );
  assert.equal(existsSync(join(repoRoot, ".npmignore")), false);
  assert.equal(existsSync(join(repoRoot, "skills", ".npmignore")), false);
});

test("npm pack contains required runtime files and excludes development or user state", async () => {
  const files = await npmPackFileNames();
  const required = [
    "README.md",
    "bin/abelworkflow.mjs",
    "extensions/pi-gpt-responses-compat/index.ts",
    "lib/cli/main.mjs",
    "lib/templates/workflow/AGENTS.md",
    "lib/templates/workflow/gitignore.template",
    "skills/context7-auto-research/context7-api.cjs",
    "skills/dev-browser/dist/scripts/start.js",
    "skills/dev-browser/dist/src/client.js",
    "skills/dev-browser/package-lock.json",
    "skills/dev-browser/package.json",
    "skills/grok-search/SKILL.md",
    "skills/grok-search/gitignore.template"
  ];

  for (const path of required) {
    assert.equal(files.includes(path), true, `missing required package file: ${path}`);
  }

  const forbidden = files.filter((path) =>
    (path === ".skill-lock.json" || path.endsWith("/.skill-lock.json")) ||
    path === "AGENTS.md" ||
    path.endsWith("/.gitignore") ||
    path.startsWith("commands/") ||
    path.startsWith("docs/") ||
    path.startsWith("test/") ||
    path.includes("/node_modules/") ||
    path.includes("/profiles/") ||
    path.includes("/tmp/") ||
    path.includes("/__pycache__/") ||
    path.endsWith(".pyc") ||
    path.endsWith("/.env") ||
    path.endsWith("/bun.lock") ||
    path.startsWith("skills/dev-browser/src/") ||
    path.startsWith("skills/dev-browser/scripts/") ||
    path.endsWith(".test.ts") ||
    path.endsWith("vitest.config.ts") ||
    path.endsWith("tsconfig.json")
  );

  assert.deepEqual(forbidden, []);
});

test("CLI characterization tests are split by responsibility", () => {
  for (const file of [
    "test/cli-args.test.mjs",
    "test/cli-prompts.test.mjs",
    "test/cli-tools.test.mjs",
    "test/config-formats.test.mjs"
  ]) {
    assert.equal(existsSync(join(repoRoot, file)), true, `missing responsibility test: ${file}`);
  }
  assert.equal(existsSync(join(repoRoot, "test/cli-contracts.test.mjs")), false);
});
