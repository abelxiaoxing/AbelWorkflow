import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureWorkflowPresent,
  installWorkflow,
  packageVersionFor
} from "../lib/installer/install.mjs";
import { hashBytes } from "../lib/installer/assets.mjs";
import { readInstallMetadata, writeInstallMetadata } from "../lib/installer/state.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-install-"));
  const homeDir = join(root, "home");
  const packageRoot = join(root, "source");
  const agentsDir = join(root, "deploy");
  const paths = {
    homeDir,
    packageRoot,
    agentsDir,
    workflowTemplateRoot: join(packageRoot, "lib", "templates", "workflow"),
    installMetadataName: ".abelworkflow-install.json",
    piAgentDir: join(homeDir, ".pi", "agent")
  };
  try {
    await writeFixtureFile(packageRoot, "package.json", `${JSON.stringify({ version: "1.0.0" })}\n`);
    await writeFixtureFile(paths.workflowTemplateRoot, "AGENTS.md", "policy={{CODEBASE_RETRIEVAL_POLICY}}\n");
    await writeFixtureFile(paths.workflowTemplateRoot, "commands/abel-init.md", "# init\n");
    await writeFixtureFile(paths.workflowTemplateRoot, "gitignore.template", "tmp/\n");
    await writeFixtureFile(packageRoot, "README.md", "# AbelWorkflow\n");
    await writeFixtureFile(packageRoot, "skills/example/SKILL.md", "# Example\n");
    await writeFixtureFile(packageRoot, "extensions/example/index.ts", "export default {};\n");
    await run({ root, paths });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureFile(root, relativePath, content) {
  const target = join(root, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

const noClaudeSettings = async () => [];

async function withTestPlatform(platform, run) {
  const previousPlatform = process.env.ABELWORKFLOW_TEST_PLATFORM;
  process.env.ABELWORKFLOW_TEST_PLATFORM = platform;
  try {
    return await run();
  } finally {
    if (previousPlatform === undefined) delete process.env.ABELWORKFLOW_TEST_PLATFORM;
    else process.env.ABELWORKFLOW_TEST_PLATFORM = previousPlatform;
  }
}

test("package version lookup trusts only a valid schema v2 value", async () => {
  await withFixture(async ({ paths }) => {
    assert.equal(await packageVersionFor(paths, { packageVersion: "legacy-spoof" }), "1.0.0");
    assert.equal(await packageVersionFor(paths, {
      schemaVersion: 2,
      packageVersion: ""
    }), "1.0.0");
    assert.equal(await packageVersionFor(paths, {
      schemaVersion: 2,
      packageVersion: "0.9.0"
    }), "0.9.0");
  });
});

test("installWorkflow returns a complete report, writes metadata last, and repeats with zero changes", async () => {
  await withFixture(async ({ paths }) => {
    await writeFixtureFile(paths.agentsDir, ".skill-lock.json", "{\"user\":true}\n");
    const first = await installWorkflow({
      paths,
      relinkOnly: false,
      force: false,
      featureOverrides: { augmentContextEngine: false },
      ensureClaudeSettings: noClaudeSettings
    });
    assert.ok(first.created.length > 0);
    assert.ok(first.linked.length > 0);
    assert.deepEqual(first.conflicts, []);
    const metadata = await readInstallMetadata(paths);
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.packageVersion, "1.0.0");
    assert.equal(Object.hasOwn(metadata, "managedChildren"), false);
    assert.equal(await readFile(join(paths.agentsDir, ".skill-lock.json"), "utf8"), "{\"user\":true}\n");

    const metadataPath = join(paths.agentsDir, paths.installMetadataName);
    const fixedTime = new Date("2022-01-01T00:00:00.000Z");
    await utimes(metadataPath, fixedTime, fixedTime);
    const second = await installWorkflow({
      paths,
      relinkOnly: false,
      force: false,
      featureOverrides: {},
      ensureClaudeSettings: noClaudeSettings
    });

    assert.deepEqual(second.created, []);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.removed, []);
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(second.linked, []);
    assert.equal((await stat(metadataPath)).mtimeMs, fixedTime.getTime());
    assert.deepEqual(await readInstallMetadata(paths), metadata);
  });
});

test("ensureWorkflowPresent completes a deployment that only contains AGENTS.md", async () => {
  await withFixture(async ({ paths }) => {
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", "existing policy\n");

    const result = await ensureWorkflowPresent(paths);

    assert.equal(
      await readFile(join(paths.agentsDir, "skills/example/SKILL.md"), "utf8"),
      "# Example\n"
    );
    assert.ok(result.created.includes("skills/example/SKILL.md"));
  });
});

test("ensureWorkflowPresent rejects the removed agentsDir string overload", async () => {
  await withFixture(async ({ paths }) => {
    await assert.rejects(
      ensureWorkflowPresent(paths.agentsDir),
      /Paths/u
    );
    await assert.rejects(stat(paths.agentsDir), (error) => error.code === "ENOENT");
  });
});

test("installWorkflow ignores the removed flat augmentContextEngine option", async () => {
  await withFixture(async ({ paths }) => {
    await installWorkflow({
      paths,
      relinkOnly: false,
      force: false,
      augmentContextEngine: true,
      ensureClaudeSettings: noClaudeSettings
    });

    assert.match(
      await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"),
      /Use local codebase retrieval/u
    );
    assert.deepEqual((await readInstallMetadata(paths)).features, {
      augmentContextEngine: false
    });
  });
});

test("failed link phase never writes completion metadata", async () => {
  await withFixture(async ({ paths }) => {
    await writeFixtureFile(paths.homeDir, ".claude/commands", "blocking file\n");

    await assert.rejects(installWorkflow({
      paths,
      relinkOnly: false,
      force: true,
      featureOverrides: { augmentContextEngine: false },
      ensureClaudeSettings: noClaudeSettings
    }), /conflict/u);

    await assert.rejects(
      readFile(join(paths.agentsDir, paths.installMetadataName)),
      (error) => error.code === "ENOENT"
    );
    assert.match(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), /Use local codebase retrieval/u);
  });
});

test("relink-only requires an existing deployment and does not create it", async () => {
  await withFixture(async ({ paths }) => {
    await assert.rejects(installWorkflow({
      paths,
      relinkOnly: true,
      force: false,
      featureOverrides: {},
      ensureClaudeSettings: noClaudeSettings
    }), /install first/u);
    await assert.rejects(stat(paths.agentsDir), (error) => error.code === "ENOENT");
  });
});

test("relink-only does not infer v1 ownership or later delete unknown files", async () => {
  await withFixture(async ({ paths }) => {
    const legacyCommand = join(paths.agentsDir, "commands", "removed.md");
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", "legacy agents\n");
    await writeFixtureFile(paths.agentsDir, "commands/removed.md", "legacy command\n");
    await writeInstallMetadata(paths, {
      package: "abelworkflow",
      features: { augmentContextEngine: false },
      managedChildren: { commands: ["removed.md"] },
      managedClaudePermissions: [],
      linkedTargets: {}
    });

    await installWorkflow({
      paths,
      relinkOnly: true,
      force: false,
      featureOverrides: {},
      ensureClaudeSettings: noClaudeSettings
    });

    const migrated = await readInstallMetadata(paths);
    assert.equal(migrated.schemaVersion, 2);
    assert.deepEqual(migrated.managedFiles, {});
    assert.equal(Object.hasOwn(migrated, "managedChildren"), false);
    assert.deepEqual(migrated.features, { augmentContextEngine: false });
    assert.equal(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), "legacy agents\n");
    assert.equal(await readFile(legacyCommand, "utf8"), "legacy command\n");

    const installed = await installWorkflow({
      paths,
      relinkOnly: false,
      force: false,
      featureOverrides: {},
      ensureClaudeSettings: noClaudeSettings
    });

    assert.ok(installed.conflicts.includes("AGENTS.md"));
    assert.equal(installed.removed.includes("commands/removed.md"), false);
    assert.equal(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), "legacy agents\n");
    assert.equal(await readFile(legacyCommand, "utf8"), "legacy command\n");
  });
});

test("relink-only upgrades identical Windows v1 copies with target hashes", {
  concurrency: false
}, async () => {
  await withTestPlatform("win32", () => withFixture(async ({ paths }) => {
    const source = join(paths.agentsDir, "AGENTS.md");
    const target = join(paths.homeDir, ".codex", "AGENTS.md");
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", "managed\n");
    await writeFixtureFile(paths.homeDir, ".codex/AGENTS.md", "managed\n");
    await writeInstallMetadata(paths, {
      package: "abelworkflow",
      features: { augmentContextEngine: false },
      linkedTargets: {
        [target]: { sourcePath: source, kind: "file", mode: "copy" }
      }
    });

    const result = await installWorkflow({
      paths,
      relinkOnly: true,
      force: false,
      featureOverrides: {},
      ensureClaudeSettings: noClaudeSettings
    });
    const metadata = await readInstallMetadata(paths);

    assert.ok(result.unchanged.includes(target));
    assert.equal(metadata.schemaVersion, 2);
    assert.deepEqual(metadata.linkedTargets[target], {
      sourcePath: source,
      kind: "file",
      mode: "copy",
      targetHash: hashBytes(Buffer.from("managed\n"))
    });
    assert.equal(await readFile(target, "utf8"), "managed\n");
  }));
});
