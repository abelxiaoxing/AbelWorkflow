import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderWorkflowTemplate } from "../lib/installer/render.mjs";

const repoRoot = new URL("../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

test("abel-design has the required entry and decision boundaries", () => {
  const content = read("lib/templates/workflow/commands/abel-design.md");
  const behaviorStart = content.indexOf("## Phase 2");
  const technicalStart = content.indexOf("## Phase 4");
  const behavior = content.slice(behaviorStart, technicalStart);
  const technical = content.slice(technicalStart);

  assert.match(content, /^---\nname: abel-design$/mu);
  assert.match(content, /argument-hint: \[requirement \| --change <change_name>\]/u);
  assert.match(content, /Before Gate A: strictly read-only/u);
  assert.doesNotMatch(content, /\/opsx:new/u);
  assert.match(content, /openspec new change <change-name>/u);
  assert.match(behavior, /multiple rounds allowed/u);
  assert.match(behavior, /Cover WHAT only/u);
  assert.match(behavior, /route them to Phase 4/u);
  assert.doesNotMatch(behavior, /JWT|bcrypt/u);
  assert.match(technical, /JWT vs session/u);
  assert.match(technical, /bcrypt cost factor/u);
});

test("abel-design is schema-driven, gated, and resumable", () => {
  const content = read("lib/templates/workflow/commands/abel-design.md");

  for (const term of [
    "Decision Ledger",
    "Artifact Plan",
    "BLOCKING_DECISIONS",
    "existingOutputPaths",
    "applyRequires",
    "apply.tracks",
    "Requirement → Scenario → Verification → Task"
  ]) assert.match(content, new RegExp(term, "u"), term);

  assert.match(content, /technical or mixed → Gate B/u);
  assert.match(content, /An incompatible schema must fail closed before creation/u);
  assert.match(content, /Mandatory loop for EVERY artifact write/u);
  assert.match(content, /openspec status --change <change-name> --json/u);
  assert.match(content, /openspec instructions <artifact-id> --change <change-name> --json/u);
  assert.match(content, /create exactly one ready artifact/u);
  assert.match(content, /edit one done artifact explicitly targeted by an approved loop-back\/consistency repair/u);
  assert.match(content, /Rerun status after every write/u);
  assert.match(content, /process newly unlocked artifacts topologically/u);
  assert.match(content, /Never infer user approval from artifact existence/u);
  assert.match(content, /Every artifact id listed in `applyRequires` is `done`/u);
  assert.match(content, /non-empty concrete `apply\.tracks`.*exactly one artifact's `generates`/su);
  assert.equal(
    [...content.matchAll(/openspec validate <change-name> --strict --type change/gu)].length,
    2
  );
  assert.doesNotMatch(content, /openspec validate <change-name> --strict(?! --type change)/u);
  assert.doesNotMatch(content, /\bisComplete\b/u);
});

test("abel-design defines applicable PBT and executable task verification", () => {
  const content = read("lib/templates/workflow/commands/abel-design.md");
  const phaseFour = content.slice(content.indexOf("## Phase 4"), content.indexOf("## ⛔ Gate B"));

  assert.match(phaseFour, /stable reference: `<spec-path>#<requirement-heading>\/<scenario-heading>`/u);
  assert.match(phaseFour, /MUST extract a property \+ falsification strategy/u);
  assert.match(phaseFour, /record why PBT does not apply/u);
  for (const field of [
    "Verification type: property | example | E2E | static",
    "Red command + expected failure reason",
    "Green expected behavior",
    "Affected-suite verification command",
    "Target scope/files"
  ]) assert.ok(phaseFour.includes(field), field);
  assert.match(phaseFour, /Manual-only verification is not implementation-ready/u);
  assert.match(phaseFour, /MUST NOT pass Gate B or Exit/u);
  assert.doesNotMatch(phaseFour, /Manual-only verification requires explicit user approval/u);
  assert.doesNotMatch(phaseFour, /^\s+- \[[ x]\]/mu);
});

test("abel-design renders cleanly for both retrieval feature states", () => {
  const source = read("lib/templates/workflow/commands/abel-design.md");

  for (const augmentContextEngine of [false, true]) {
    const rendered = renderWorkflowTemplate(source, { augmentContextEngine });
    assert.doesNotMatch(rendered, /\{\{[^{}]+\}\}/u);
  }
});

test("workflow documentation exposes design and the complete core command profile", () => {
  const documents = [
    read("README.md"),
    read("AGENTS.md"),
    read("lib/templates/workflow/AGENTS.md")
  ];
  const coreCommands = ["propose", "explore", "apply", "update", "sync", "archive"];

  for (const document of documents) {
    assert.match(document, /\/abel-design\b/u);
    assert.doesNotMatch(document, /abel-research|abel-plan|\/opsx:new|\/opsx:ff/u);
    for (const command of coreCommands) assert.ok(document.includes(`/opsx:${command}`), command);
    for (const command of ["openspec view", "openspec status"]) assert.ok(document.includes(command), command);
  }
});
