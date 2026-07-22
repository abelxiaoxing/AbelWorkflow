import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { presentInstallReport } from "../lib/cli/main.mjs";

function captureOutput() {
  const messages = [];
  const warnings = [];
  return {
    messages,
    warnings,
    output: {
      message: (value) => messages.push(value),
      warn: (value) => warnings.push(value)
    }
  };
}

test("install report presenter lists conflicts and non-conflict preserved paths once", () => {
  const { messages, warnings, output } = captureOutput();
  presentInstallReport({
    created: ["created.md"],
    updated: ["updated.md"],
    unchanged: ["unchanged.md"],
    preserved: ["AGENTS.md", "/home/test/.codex/prompts/abel-init.md", "profiles/session"],
    conflicts: ["AGENTS.md", "/home/test/.codex/prompts/abel-init.md"],
    removed: ["removed.md"],
    linked: ["/home/test/.claude/commands/abel-init.md"]
  }, output);

  assert.equal(
    messages[0],
    "安装摘要：新增 1，更新 1，未变 1，删除 1，链接 1，保留 3，冲突 2"
  );
  assert.equal(warnings.length, 1);
  assert.equal(messages[1], "已更新 1 个文件：\n- updated.md");
  assert.equal(messages[2], "已跳过 1 个未变化文件：\n- unchanged.md");
  assert.match(warnings[0], /检测到 2 个冲突/u);
  assert.match(warnings[0], /AGENTS\.md/u);
  assert.match(warnings[0], /\/home\/test\/\.codex\/prompts\/abel-init\.md/u);
  assert.match(warnings[0], /在原安装命令中加入 `--force`/u);
  assert.doesNotMatch(warnings[0], /abelworkflow install --force/u);
  assert.equal(
    messages[3],
    "另有 1 个非冲突路径已保留：\n- profiles/session"
  );

  const details = `${warnings[0]}\n${messages[3]}`;
  assert.equal(details.split("AGENTS.md").length - 1, 1);
  assert.equal(details.split("/home/test/.codex/prompts/abel-init.md").length - 1, 1);
  assert.equal(details.split("profiles/session").length - 1, 1);
});

test("all managed workflow install entry points use the reporting wrapper", () => {
  const source = readFileSync(new URL("../lib/cli/main.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/\binstallManagedWorkflow\(/gu)?.length, 1);
  assert.match(source, /async function runManagedInstall[\s\S]*?await installManagedWorkflow\(/u);
  assert.equal(source.match(/\brunManagedInstall\(/gu)?.length, 4);
});

test("CLI forwards canonical Paths", () => {
  const source = readFileSync(new URL("../lib/cli/main.mjs", import.meta.url), "utf8");

  for (const configureName of [
    "configureGrokSearchEnv",
    "configureContext7Env",
    "configurePromptEnhancerEnv"
  ]) {
    assert.equal(source.match(new RegExp(`${configureName}\\(options\\.paths`, "gu"))?.length, 2);
    assert.match(
      source,
      new RegExp(`${configureName}\\(options\\.paths, ensureWorkflowPresentWithReport, promptApi\\)`, "u")
    );
    assert.doesNotMatch(source, new RegExp(`${configureName}\\(options\\.agentsDir`, "u"));
  }
  assert.match(
    source,
    /"pi-api": async \(\) => configurePiApi\(options\.paths, ensurePiResourcesLinkedWithReport, promptApi\)/u
  );
});

test("direct provider configuration finalizes install metadata through schema v2", () => {
  const source = readFileSync(new URL("../lib/cli/main.mjs", import.meta.url), "utf8");

  assert.equal(source.match(/finalizeProviderInstallMetadata\(\{/gu)?.length, 2);
  assert.equal(source.match(/packageVersionFor\(paths, metadata\)/gu)?.length, 2);
  assert.doesNotMatch(
    source,
    /writeInstallMetadata\(paths,\s*\{\s*\.\.\.metadata,\s*managedCodexAuthKeys:/u
  );
});
