import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { installWorkflow } from "../lib/installer/install.mjs";
import { ensureManagedLink } from "../lib/installer/links.mjs";
import {
  buildInstallMetadata,
  readInstallMetadata,
  writeInstallMetadata
} from "../lib/installer/state.mjs";
import { createPaths } from "../lib/paths.mjs";
import { hashBytes } from "../lib/utils.mjs";

function linkedTargetsFromResults(results) {
  return Object.fromEntries(results
    .filter((result) => result.sourcePath)
    .map((result) => [result.targetPath, {
      sourcePath: result.sourcePath,
      kind: result.kind,
      mode: result.mode,
      ...(result.targetHash ? { targetHash: result.targetHash } : {})
    }]));
}

const repoRoot = new URL("../", import.meta.url);
const currentCommands = ["abel-design.md", "abel-diagnose.md", "abel-implement.md", "abel-init.md"];
const legacyCommands = ["abel-plan.md", "abel-research.md"];

async function writeFixtureFile(root, relativePath, content) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-command-upgrade-"));
  const packageRoot = join(root, "source");
  const homeDir = join(root, "home");
  const agentsDir = join(root, "deploy");
  try {
    await cp(
      new URL("lib/templates/workflow/", repoRoot),
      join(packageRoot, "lib", "templates", "workflow"),
      { recursive: true }
    );
    await writeFixtureFile(packageRoot, "package.json", "{\"version\":\"3.0.0\"}\n");
    await writeFixtureFile(packageRoot, "README.md", "# fixture\n");
    const paths = createPaths({ homeDir, packageRoot, agentsDir });
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function providerCommandPaths(paths, commandName) {
  return [
    join(paths.homeDir, ".claude", "commands", commandName),
    join(paths.homeDir, ".codex", "prompts", commandName),
    join(paths.homeDir, ".pi", "agent", "prompts", commandName)
  ];
}

async function entryExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function install(paths, force = false) {
  return installWorkflow({
    paths,
    force,
    relinkOnly: false
  });
}

async function createLegacyV2Install(paths, commandNames) {
  const managedFiles = {};
  const linkResults = [];
  for (const commandName of commandNames) {
    const relativePath = `commands/${commandName}`;
    const content = `managed ${commandName}\n`;
    const sourcePath = join(paths.agentsDir, relativePath);
    await writeFixtureFile(paths.agentsDir, relativePath, content);
    managedFiles[relativePath] = hashBytes(Buffer.from(content));
    for (const targetPath of providerCommandPaths(paths, commandName)) {
      await mkdir(dirname(targetPath), { recursive: true });
      linkResults.push(await ensureManagedLink(targetPath, sourcePath, "file", {}, { force: false }));
    }
  }
  await writeInstallMetadata(paths, buildInstallMetadata({
    packageVersion: "2.0.0",
    managedFiles,
    linkedTargets: linkedTargetsFromResults(linkResults)
  }));
}

async function assertProviderEntries(paths, commandName, expected) {
  for (const targetPath of providerCommandPaths(paths, commandName)) {
    assert.equal(await entryExists(targetPath), expected, targetPath);
  }
}

test("fresh install deploys only the four current commands to every provider", async () => {
  await withFixture(async (paths) => {
    await install(paths);
    assert.deepEqual((await readdir(join(paths.agentsDir, "commands"))).sort(), currentCommands);
    for (const commandName of currentCommands) await assertProviderEntries(paths, commandName, true);
    for (const commandName of legacyCommands) await assertProviderEntries(paths, commandName, false);
  });
});

test("v2 unchanged legacy commands and their owned provider entries are removed", async () => {
  await withFixture(async (paths) => {
    await createLegacyV2Install(paths, legacyCommands);
    const report = await install(paths);

    for (const commandName of legacyCommands) {
      assert.equal(await entryExists(join(paths.agentsDir, "commands", commandName)), false);
      assert.ok(report.removed.includes(`commands/${commandName}`));
      await assertProviderEntries(paths, commandName, false);
    }
  });
});

test("v2 user-modified legacy command conflicts and keeps every provider entry", async () => {
  await withFixture(async (paths) => {
    const commandName = "abel-research.md";
    const commandPath = join(paths.agentsDir, "commands", commandName);
    await createLegacyV2Install(paths, [commandName]);
    await writeFile(commandPath, "user research command\n", "utf8");

    const report = await install(paths);
    assert.ok(report.conflicts.includes(`commands/${commandName}`));
    assert.equal(await readFile(commandPath, "utf8"), "user research command\n");
    await assertProviderEntries(paths, commandName, true);
    const metadata = await readInstallMetadata(paths);
    assert.ok(metadata.managedFiles[`commands/${commandName}`]);
  });
});

test("force backs up a modified legacy command and prunes owned provider entries", async () => {
  await withFixture(async (paths) => {
    const commandName = "abel-plan.md";
    const commandsDir = join(paths.agentsDir, "commands");
    const commandPath = join(commandsDir, commandName);
    await createLegacyV2Install(paths, [commandName]);
    await writeFile(commandPath, "user plan command\n", "utf8");

    await install(paths, true);
    assert.equal(await entryExists(commandPath), false);
    assert.equal(
      (await readdir(commandsDir)).some((name) => name.startsWith(`${commandName}.abelworkflow.bak.`)),
      true
    );
    await assertProviderEntries(paths, commandName, false);
    const metadata = await readInstallMetadata(paths);
    assert.equal(Object.hasOwn(metadata.managedFiles, `commands/${commandName}`), false);
  });
});
