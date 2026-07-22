import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function assertTrackable(relativePath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", relativePath],
    { cwd: repoRoot }
  );

  assert.equal(result.status, 1, `${relativePath} must not be ignored by Git`);
}

test("the npm-only repository has exactly its two supported lockfiles", () => {
  const requiredPaths = [
    "package-lock.json",
    "skills/dev-browser/package-lock.json"
  ];

  for (const relativePath of requiredPaths) {
    assert.equal(existsSync(new URL(`../${relativePath}`, import.meta.url)), true);
    assertTrackable(relativePath);
  }
  assert.equal(existsSync(new URL("../bun.lock", import.meta.url)), false);
});

test("root quality scripts cover every repository test boundary", () => {
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(packageJson.engines.node, ">=22");
  assert.match(packageJson.packageManager, /^npm@/u);
  assert.equal(packageJson.scripts["test:node"], "node --test test/*.test.mjs");
  assert.match(packageJson.scripts["test:python"], /unittest discover/u);
  assert.match(packageJson.scripts["test:dev-browser"], /skills\/dev-browser/u);
  assert.equal(packageJson.scripts.check.split(" && ")[0], "npm run build");

  for (const script of [
    "build",
    "test:node",
    "test:python",
    "test:dev-browser",
    "typecheck",
    "check:docs",
    "check:package"
  ]) {
    assert.match(packageJson.scripts.check, new RegExp(`npm run ${script}`));
  }
});

test("the package version is synchronized with the root lock", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});

test("CI runs checks with real Node on the required platform matrix", () => {
  const workflow = read(".github/workflows/ci.yml");
  const standaloneIntegration = read("skills/dev-browser/src/standalone.integration.test.ts");

  assert.match(workflow, /actions\/setup-node@/u);
  assert.match(workflow, /ubuntu-latest/u);
  assert.match(workflow, /windows-latest/u);
  assert.match(workflow, /node-version: 22/u);
  assert.match(workflow, /node-version: 24/u);
  assert.doesNotMatch(workflow, /\b(?:bun|oven-sh)\b/u);
  assert.match(workflow, /npm ci/u);
  assert.doesNotMatch(workflow, /^\s*-\s+run:\s+npm run build\s*$/mu);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm pack --dry-run --json/u);

  const browserInstall = workflow.indexOf("npx playwright install --with-deps chromium");
  assert.ok(browserInstall > workflow.indexOf("npm ci --prefix skills/dev-browser"));
  assert.ok(browserInstall < workflow.indexOf("npm run check"));
  assert.match(workflow, /working-directory:\s*skills\/dev-browser/u);
  assert.match(standaloneIntegration, /process\.env\.CI/u);
  assert.match(standaloneIntegration, /Playwright Chromium is required in CI/u);
});
