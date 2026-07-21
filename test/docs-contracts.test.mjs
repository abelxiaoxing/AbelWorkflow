import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { renderWorkflowTemplate } from "../lib/installer/render.mjs";

const repoRoot = new URL("../", import.meta.url);
const workflowCommandsRoot = new URL("../lib/templates/workflow/commands/", import.meta.url);
const migrationGuideUrl = "https://github.com/abelxiaoxing/AbelWorkflow/blob/master/docs/migration-1.0.md";
const developmentContext = `Development context: work is currently in the development phase, and this is a development repository.
Do not retain runtime user state in the repository or shipped artifacts, and do not preserve compatibility layers for unreleased behavior.
Prefer deleting obsolete code paths; keep code and prompts concise and avoid over-engineering.
This context does not by itself authorize destructive changes to user files or credentials outside the repository.`;

function read(path, root = repoRoot) {
  return readFileSync(new URL(path, root), "utf8");
}

function commandNames(root) {
  return readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const match = read(name, root).match(/^---\n[\s\S]*?^name:\s*(\S+)\s*$/mu);
      assert.ok(match, `${name} is missing frontmatter name`);
      return match[1];
    })
    .sort();
}

test("README documents every official workflow and OpenSpec command", () => {
  const readme = read("README.md");
  const expected = [
    "abel-design",
    "abel-diagnose",
    "abel-implement",
    "abel-init"
  ];

  assert.deepEqual(commandNames(workflowCommandsRoot), expected);
  for (const name of expected) assert.match(readme, new RegExp(`/${name}\\b`, "u"));
  for (const command of [
    "/opsx:propose",
    "/opsx:explore",
    "/opsx:apply",
    "/opsx:update",
    "/opsx:sync",
    "/opsx:archive",
    "openspec view",
    "openspec status"
  ]) {
    assert.ok(readme.includes(command), command);
  }
  for (const removed of ["/abel-research", "/abel-plan", "/opsx:new", "/opsx:ff"]) {
    assert.equal(readme.includes(removed), false, removed);
  }
});

test("documentation and deployable templates contain no legacy workflow or OpenCode claims", () => {
  const paths = [
    "README.md",
    "lib/templates/workflow/commands/abel-diagnose.md",
    "lib/templates/workflow/commands/abel-implement.md",
    "lib/templates/codex/config-base.toml"
  ];

  for (const path of paths) {
    const content = read(path);
    assert.doesNotMatch(content, /\/oc:/u, path);
    assert.doesNotMatch(content, /\bOpenCode\b/u, path);
  }
});

test("README documents the 1.0 runtime and source-install contracts", () => {
  const readme = read("README.md");

  assert.match(readme, /Node\.js\s*22|Node\.js.*>=?\s*22/iu);
  assert.match(readme, /~\/src\/AbelWorkflow/u);
  assert.match(readme, /npm ci --prefix skills\/dev-browser/u);
  assert.match(readme, /npm run build/u);
  assert.match(readme, /install --agents-dir ~\/\.agents/u);
  assert.match(readme, /standard/u);
  assert.match(readme, /trusted/u);
  assert.match(readme, /auth\.json/u);
  assert.match(readme, /node dist\/scripts\/start\.js/u);
  assert.deepEqual(
    [...readme.matchAll(/\[[^\]]*迁移指南\]\(([^)]+)\)/gu)].map((match) => match[1]),
    [migrationGuideUrl, migrationGuideUrl]
  );
});

test("1.0 migration guide covers every state and runtime migration boundary", () => {
  const migration = read("docs/migration-1.0.md");
  const requiredPatterns = [
    /Node\.js\s*22|Node\.js.*>=?\s*22/iu,
    /~\/src\/AbelWorkflow/u,
    /~\/\.agents/u,
    /metadata v2/iu,
    /--force/u,
    /\.skill-lock\.json/u,
    /Pi\s*0\.80\.0/iu,
    /auth\.json/u,
    /models\.json/u,
    /standard/u,
    /trusted/u,
    /context7-api\.cjs/u,
    /node dist\/scripts\/start\.js/u,
    /\.abelworkflow\.bak\./u,
    /3\s*份/u,
    /回滚/u
  ];

  for (const pattern of requiredPatterns) assert.match(migration, pattern);
});

test("1.0 docs define conservative v1 ownership and Prompt Enhancer migration", () => {
  const documents = [
    read("docs/migration-1.0.md"),
    read("docs/abelworkflow-v1-refactor-plan.md")
  ];

  for (const document of documents) {
    assert.match(document, /只迁移.*`features`.*`managedClaudePermissions`.*`linkedTargets`/su);
    assert.match(document, /`managedChildren` 不迁移为 asset 所有权/u);
    assert.match(document, /与当前 source 内容完全相同.*接管/su);
    assert.match(document, /其余已有路径.*冲突/u);
    assert.match(document, /`--force` 仅备份并替换当前 manifest 精确声明的路径/u);
    assert.match(document, /stale 路径.*保留/u);

    assert.match(document, /只接受.*`PE_API_URL`.*`PE_API_KEY`.*`PE_MODEL`.*`--url`.*`--api-key`.*`--model`/su);
    assert.match(document, /不再隐式读取.*`OPENAI_API_KEY`.*`ANTHROPIC_API_KEY`/su);
    assert.match(document, /移除 Anthropic fallback/u);
    assert.match(document, /保留.*`OPENAI_API_KEY`.*`ANTHROPIC_API_KEY`/su);
  }

  assert.doesNotMatch(documents[0], /读取 v1 metadata 的 features、managedChildren/u);
  assert.doesNotMatch(documents[1], /"managedChildren": \{\}/u);
  assert.doesNotMatch(documents[1], /继续读取现有 features、managedChildren/u);
});

test("dev-browser docs keep temporary artifacts outside the installed skill", () => {
  const skill = read("skills/dev-browser/SKILL.md");

  assert.doesNotMatch(skill, /`tmp\//u);
  assert.doesNotMatch(skill, /node tmp\//u);
  assert.match(skill, /installed `dev-browser` skill directory as read-only/u);
  assert.match(skill, /OS temporary directory or task workspace/u);
  assert.match(skill, /delete files you created when the task ends/u);
  assert.match(skill, /import \{ tmpdir \} from "node:os";/u);
  assert.match(skill, /import \{ join \} from "node:path";/u);
  assert.match(skill, /pathToFileURL/u);
  assert.match(skill, /process\.argv\[2\]/u);
  assert.match(skill, /join\(tmpdir\(\), "dev-browser-screenshot\.png"\)/u);
});

test("modern UI document reports implemented and deferred behavior accurately", () => {
  const proposal = read("docs/modern-ui-proposal.md");

  assert.match(proposal, /状态：部分实施/u);
  assert.match(proposal, /Stepper.*未实现/isu);
  assert.match(proposal, /不属于 AbelWorkflow 1\.0/u);
  assert.doesNotMatch(proposal, /Windows 明文/u);
});

test("workflow commands render fully and Codex agents use the baseline model", () => {
  for (const name of readdirSync(workflowCommandsRoot)) {
    const source = read(name, workflowCommandsRoot);
    for (const augmentContextEngine of [false, true]) {
      assert.doesNotMatch(
        renderWorkflowTemplate(source, { augmentContextEngine }),
        /\{\{[^{}]+\}\}/u,
        `${name}: ${augmentContextEngine}`
      );
    }
  }

  const baseModel = read("lib/templates/codex/config-base.toml").match(/^model\s*=\s*"([^"]+)"/mu)?.[1];
  assert.ok(baseModel);
  for (const name of readdirSync(new URL("../lib/templates/codex/agents/", import.meta.url))) {
    const model = read(name, new URL("../lib/templates/codex/agents/", import.meta.url))
      .match(/^model\s*=\s*"([^"]+)"/mu)?.[1];
    assert.equal(model, baseModel, name);
  }
});

test("repository and every Codex agent template carry the development context", async (t) => {
  const paths = [
    "AGENTS.md",
    "lib/templates/workflow/AGENTS.md",
    "lib/templates/codex/config-base.toml",
    "lib/templates/codex/agents/default.toml",
    "lib/templates/codex/agents/explorer.toml",
    "lib/templates/codex/agents/planner.toml",
    "lib/templates/codex/agents/reviewer.toml",
    "lib/templates/codex/agents/worker.toml"
  ];

  for (const path of paths) {
    await t.test(path, () => assert.ok(read(path).includes(developmentContext), path));
  }

  assert.match(
    read("lib/templates/codex/config-base.toml"),
    /Copy this development context into every subagent task\./u
  );
});
