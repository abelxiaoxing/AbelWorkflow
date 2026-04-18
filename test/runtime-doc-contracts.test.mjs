import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
