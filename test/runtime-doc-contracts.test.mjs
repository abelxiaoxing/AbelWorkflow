import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = new URL("../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const forbiddenPatterns = [
  new RegExp(["RUNTIME_", "CONTRACT\\.md"].join(""), "u"),
  new RegExp(["\\bAsk", "UserQuestions\\b"].join(""), "u")
];
const ignoredDirectories = new Set([".git", "node_modules"]);

function getDocumentFiles(directory, prefix = "") {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...getDocumentFiles(join(directory, entry.name), `${prefix}${entry.name}/`));
      }
      continue;
    }

    if (/\.(md|toml)$/u.test(entry.name)) {
      files.push(`${prefix}${entry.name}`);
    }
  }

  return files;
}

test("document files do not reference removed runtime-contract placeholders", () => {
  const offenders = [];

  for (const relativePath of getDocumentFiles(repoRootPath)) {
    const content = readFileSync(join(repoRootPath, relativePath), "utf8");
    const matches = forbiddenPatterns
      .filter((pattern) => pattern.test(content))
      .map((pattern) => pattern.source);

    if (matches.length > 0) {
      offenders.push(`${relativePath}: ${matches.join(", ")}`);
    }
  }

  assert.deepEqual(offenders, []);
});

function runContext7Help(scriptPath) {
  return spawnSync(process.execPath, [scriptPath, "--help"], {
    encoding: "utf8"
  });
}

test("Context7 uses an explicit CommonJS runtime under the root module scope", () => {
  const skillDirectory = join(repoRootPath, "skills", "context7-auto-research");
  const cjsPath = join(skillDirectory, "context7-api.cjs");
  const skill = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");

  assert.equal(existsSync(join(skillDirectory, "context7-api.js")), false);
  assert.equal(existsSync(cjsPath), true);
  assert.doesNotMatch(skill, /context7-api\.js/u);
  assert.match(skill, /context7-api\.cjs/u);

  const result = runContext7Help(cjsPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(`${result.stdout}${result.stderr}`, /context7-api\.cjs/u);
});

test("Context7 CommonJS runtime works from an isolated type-module copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "abelworkflow-context7-"));
  const skillDirectory = join(directory, "context7-auto-research");
  try {
    writeFileSync(join(directory, "package.json"), "{\"type\":\"module\"}\n");
    cpSync(join(repoRootPath, "skills", "context7-auto-research"), skillDirectory, { recursive: true });

    const result = runContext7Help(join(skillDirectory, "context7-api.cjs"));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}${result.stderr}`, /context7-api\.cjs/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Context7 keeps the first empty dotenv assignment", () => {
  const directory = mkdtempSync(join(tmpdir(), "abelworkflow-context7-env-"));
  const scriptPath = join(directory, "context7-api.cjs");
  const preloadPath = join(directory, "https-preload.cjs");
  try {
    cpSync(join(repoRootPath, "skills", "context7-auto-research", "context7-api.cjs"), scriptPath);
    writeFileSync(join(directory, ".env"), "CONTEXT7_API_KEY=\nCONTEXT7_API_KEY=stale\n");
    writeFileSync(preloadPath, [
      "const https = require('https');",
      "const { EventEmitter } = require('events');",
      "https.get = (_url, options, callback) => {",
      "  process.stdout.write(`authorization=${options.headers.Authorization ?? ''}\\n`);",
      "  const response = new EventEmitter();",
      "  response.statusCode = 200;",
      "  process.nextTick(() => {",
      "    callback(response);",
      "    response.emit('data', '{}');",
      "    response.emit('end');",
      "  });",
      "  return { setTimeout() {}, on() {}, destroy() {} };",
      "};",
      ""
    ].join("\n"));

    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, scriptPath, "search", "react", "query"],
      {
        encoding: "utf8",
        env: { ...process.env, CONTEXT7_API_KEY: "" }
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^authorization=$/mu);
    assert.doesNotMatch(result.stdout, /Bearer stale/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
