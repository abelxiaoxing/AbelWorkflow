import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const commandUrl = new URL("../lib/templates/workflow/commands/abel-implement.md", import.meta.url);

function readCommand() {
  return readFileSync(commandUrl, "utf8");
}

test("abel-implement performs the ordered readiness preflight before writes", () => {
  const content = readCommand();
  const preflight = content.slice(0, content.indexOf("**TDD Cycle (per task)**"));
  const orderedMarkers = [
    "Explicit argument takes precedence",
    "openspec status --change <change-name> --json",
    "openspec schema which <schemaName> --json",
    "apply.tracks",
    "Every artifact id in `applyRequires` must have status `done`",
    "openspec validate <change-name> --strict --type change",
    "openspec instructions apply --change <change-name> --json",
    "Run and record affected baseline tests and the full test suite before any write"
  ];

  let offset = -1;
  for (const marker of orderedMarkers) {
    const next = preflight.indexOf(marker);
    assert.ok(next > offset, marker);
    offset = next;
  }

  for (const field of ["schemaName", "changeRoot", "artifactPaths", "applyRequires", "artifacts"]) {
    assert.match(preflight, new RegExp(`\\b${field}\\b`, "u"), field);
  }
  assert.match(preflight, /ask only when the argument is missing or cannot be resolved uniquely/u);
  assert.doesNotMatch(preflight, /Run `openspec view`.*ask the user/su);
  assert.match(preflight, /Gate A and Gate B summaries/u);
  assert.match(preflight, /Requirement.*Scenario.*Verification.*Task/su);
  assert.match(preflight, /cannot be proven in the current conversation.*user confirmation/su);
  assert.match(preflight, /existing failures.*target Red/su);
  assert.match(preflight, /schema\.yaml/u);
  assert.match(preflight, /Resolve `apply\.tracks` relative to `changeRoot`/u);
  assert.match(preflight, /one concrete existing regular file inside `changeRoot`/u);
  assert.match(preflight, /command, exit status, and normalized failure identities/u);
  assert.doesNotMatch(preflight, /openspec validate <change-name> --strict(?! --type change)/u);
  assert.match(preflight, /STOP.*\/abel-design --change <change-name>/su);
});

test("abel-implement consumes each task verification contract for TDD", () => {
  const content = readCommand();

  for (const field of [
    "verification type",
    "Red command and expected failure reason",
    "Green expected behavior",
    "affected-suite command",
    "target scope/files"
  ]) assert.match(content, new RegExp(field, "iu"), field);

  assert.match(content, /Red must fail because of the target defect/u);
  assert.match(content, /failure reason differs or the command is invalid.*STOP.*\/abel-design --change <change-name>/su);
  assert.match(content, /non-behavior-change task.*failing executable static verification/su);
  assert.match(content, /manual-only task.*not implementation-ready.*STOP.*\/abel-design --change <change-name>/isu);
  assert.match(content, /ordinary indented bullets.*never Markdown checkboxes/su);
  assert.match(content, /concrete tracking file resolved from schema `apply\.tracks`/u);
  assert.match(content, /task ID's checkbox.*exactly one match/su);
  assert.doesNotMatch(content, /tracked artifact named by the apply instructions/u);
  assert.doesNotMatch(content, /tasks\.md/u);
  assert.match(content, /Red Phase.*failing executable verification ONLY/su);
  assert.match(content, /Refactor Phase.*target and affected verification green.*no new full-suite failures/su);
  assert.match(content, /Mandatory.*task's executable verification after EVERY code change/su);
  assert.doesNotMatch(content, /failing tests ONLY|keeping ALL tests passing|Run tests after EVERY code change/u);
  assert.match(content, /Verification: \{verification_context\}/u);
  assert.doesNotMatch(content, /pass test:|Test: \{test_code\}|Run test →/u);
  assert.match(content, /same full-suite command.*normalized failure identities.*no new failures/su);
  assert.match(content, /target tests.*green.*full test suite.*no new failures/su);
  assert.equal([...content.matchAll(/\*\*Guardrails\*\*/gu)].length, 1);
});
