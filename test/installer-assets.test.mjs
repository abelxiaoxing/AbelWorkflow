import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncManagedFiles } from "../lib/installer/assets.mjs";
import { hashBytes } from "../lib/utils.mjs";
import {
  buildInstallMetadata,
  readInstallMetadata,
  writeInstallMetadata
} from "../lib/installer/state.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-assets-"));
  const packageRoot = join(root, "source");
  const agentsDir = join(root, "deploy");
  const workflowTemplateRoot = join(packageRoot, "lib", "templates", "workflow");
  const paths = {
    packageRoot,
    agentsDir,
    workflowTemplateRoot,
    installMetadataName: ".abelworkflow-install.json"
  };
  try {
    await writeFixtureFile(packageRoot, "package.json", `${JSON.stringify({ version: "1.0.0" })}\n`);
    await writeFixtureFile(workflowTemplateRoot, "AGENTS.md", "policy=Use local codebase retrieval\n");
    await writeFixtureFile(workflowTemplateRoot, "commands/abel-init.md", "# init\n");
    await writeFixtureFile(workflowTemplateRoot, "gitignore.template", "tmp/\n");
    await writeFixtureFile(packageRoot, "README.md", "# AbelWorkflow\n");
    await writeFixtureFile(packageRoot, "skills/example/SKILL.md", "# Example\n");
    await writeFixtureFile(packageRoot, "skills/example/gitignore.template", ".env\n");
    await writeFixtureFile(packageRoot, "extensions/example/index.ts", "export default {};\n");
    await writeFixtureFile(packageRoot, ".skill-lock.json", "{\"source\":true}\n");
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

async function persistSyncMetadata(paths, syncResult, previousMetadata = syncResult.previousMetadata) {
  const metadata = buildInstallMetadata({
    previousMetadata,
    packageVersion: syncResult.packageVersion,
    managedFiles: syncResult.managedFiles,
    linkedTargets: previousMetadata.linkedTargets ?? {}
  });
  await writeInstallMetadata(paths, metadata);
  return metadata;
}

test("asset sync copies immutable templates and never manages user state", async () => {
  await withFixture(async ({ paths }) => {
    const sourceAgents = await readFile(join(paths.workflowTemplateRoot, "AGENTS.md"), "utf8");
    await writeFixtureFile(paths.agentsDir, ".skill-lock.json", "{\"user\":true}\n");
    await writeFixtureFile(paths.agentsDir, "skills/user/SKILL.md", "# User\n");

    const result = await syncManagedFiles({
      paths,
      force: false
    });

    assert.equal(await readFile(join(paths.workflowTemplateRoot, "AGENTS.md"), "utf8"), sourceAgents);
    assert.match(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), /Use local codebase retrieval/u);
    assert.equal(await readFile(join(paths.agentsDir, ".skill-lock.json"), "utf8"), "{\"user\":true}\n");
    assert.equal(await readFile(join(paths.agentsDir, "skills/user/SKILL.md"), "utf8"), "# User\n");
    assert.equal(await readFile(join(paths.agentsDir, ".gitignore"), "utf8"), "tmp/\n");
    assert.equal(
      await readFile(join(paths.agentsDir, "skills/example/.gitignore"), "utf8"),
      ".env\n"
    );
    await assert.rejects(
      readFile(join(paths.agentsDir, "gitignore.template")),
      (error) => error.code === "ENOENT"
    );
    assert.equal(Object.hasOwn(result.managedFiles, ".skill-lock.json"), false);
    assert.ok(result.report.created.includes("AGENTS.md"));
  });
});

test("dev-browser dist is managed while generated skill state stays excluded", async () => {
  await withFixture(async ({ paths }) => {
    const entrypoint = "skills/dev-browser/dist/scripts/start.js";
    const excluded = [
      "skills/example/dist/cache.js",
      "skills/dev-browser/profiles/session.json",
      "skills/dev-browser/tmp/script.mjs"
    ];
    await writeFixtureFile(paths.packageRoot, entrypoint, "export {};\n");
    for (const relativePath of excluded) {
      await writeFixtureFile(paths.packageRoot, relativePath, "excluded\n");
    }

    const result = await syncManagedFiles({
      paths
      });

    assert.equal(
      await readFile(join(paths.agentsDir, entrypoint), "utf8"),
      "export {};\n"
    );
    assert.match(result.managedFiles[entrypoint], /^[a-f0-9]{64}$/u);
    for (const relativePath of excluded) {
      await assert.rejects(
        readFile(join(paths.agentsDir, relativePath)),
        (error) => error.code === "ENOENT"
      );
      assert.equal(Object.hasOwn(result.managedFiles, relativePath), false);
    }
  });
});

test("metadata v2 hashes and repeated sync are stable with zero writes", async () => {
  await withFixture(async ({ paths }) => {
    const first = await syncManagedFiles({ paths });
    const metadata = await persistSyncMetadata(paths, first);
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.packageVersion, "1.0.0");
    assert.match(metadata.managedFiles["AGENTS.md"], /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(metadata, "managedChildren"), false);
    assert.equal(Object.hasOwn(first, "managedChildren"), false);
    assert.equal(Object.hasOwn(metadata, "updatedAt"), false);

    const metadataPath = join(paths.agentsDir, paths.installMetadataName);
    const fixedTime = new Date("2021-01-01T00:00:00.000Z");
    await utimes(metadataPath, fixedTime, fixedTime);
    const second = await syncManagedFiles({ paths });
    const secondMetadata = await persistSyncMetadata(paths, second);

    assert.deepEqual(second.report.created, []);
    assert.deepEqual(second.report.updated, []);
    assert.deepEqual(second.report.conflicts, []);
    assert.equal(second.report.unchanged.length, Object.keys(second.managedFiles).length);
    assert.deepEqual(secondMetadata, metadata);
    assert.equal((await stat(metadataPath)).mtimeMs, fixedTime.getTime());
  });
});

test("partial sync backs up and updates only changed files", async () => {
  await withFixture(async ({ paths }) => {
    const first = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, first);
    const unchangedPath = join(paths.agentsDir, "commands", "abel-init.md");
    const changedPath = join(paths.agentsDir, "README.md");
    const fixedTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(unchangedPath, fixedTime, fixedTime);
    await utimes(changedPath, fixedTime, fixedTime);
    await writeFixtureFile(paths.packageRoot, "README.md", "# AbelWorkflow updated\n");

    const result = await syncManagedFiles({ paths });

    assert.deepEqual(result.report.updated, ["README.md"]);
    assert.ok(result.report.unchanged.includes("commands/abel-init.md"));
    assert.equal((await stat(unchangedPath)).mtimeMs, fixedTime.getTime());
    assert.notEqual((await stat(changedPath)).mtimeMs, fixedTime.getTime());
    assert.equal(
      (await readdirNames(paths.agentsDir)).filter((name) => name.startsWith("README.md.abelworkflow.bak.")).length,
      1
    );
    assert.equal(
      (await readdirNames(join(paths.agentsDir, "commands")))
        .some((name) => name.startsWith("abel-init.md.abelworkflow.bak.")),
      false
    );
  });
});

for (const { label, relativePath, force } of [
  { label: "parent traversal", relativePath: "../victim", force: false },
  { label: "Windows parent traversal", relativePath: "..\\victim", force: true },
  { label: "POSIX absolute path", relativePath: "/victim", force: true },
  { label: "Windows absolute path", relativePath: "C:\\victim", force: true },
  { label: "noncanonical manifest alias", relativePath: "commands/./abel-init.md", force: false }
]) {
  test(`metadata v2 rejects ${label} before filesystem mutation`, async () => {
    await withFixture(async ({ root, paths }) => {
      const victimPath = join(root, "victim");
      const commandPath = join(paths.agentsDir, "commands", "abel-init.md");
      await writeFile(victimPath, "outside\n", "utf8");
      await writeFixtureFile(paths.agentsDir, "AGENTS.md", "deployed agents\n");
      await writeFixtureFile(paths.agentsDir, "commands/abel-init.md", "deployed command\n");
      await writeInstallMetadata(paths, {
        schemaVersion: 2,
        managedFiles: {
          [relativePath]: hashBytes(Buffer.from(
            relativePath === "../victim" ? "outside\n" : "deployed command\n"
          ))
        }
      });

      await assert.rejects(
        syncManagedFiles({ paths, force }),
        /Invalid managed file path/u
      );

      assert.equal(await readFile(victimPath, "utf8"), "outside\n");
      assert.equal(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), "deployed agents\n");
      assert.equal(await readFile(commandPath, "utf8"), "deployed command\n");
      await assert.rejects(
        readFile(join(paths.agentsDir, "README.md")),
        (error) => error.code === "ENOENT"
      );
    });
  });
}

test("v1 metadata ignores legacy ownership paths without inspecting external files", async () => {
  await withFixture(async ({ root, paths }) => {
    const victimPath = join(root, "victim");
    await writeFile(victimPath, "outside\n", "utf8");
    await writeInstallMetadata(paths, {
      package: "abelworkflow",
      managedChildren: { "..": ["victim"] }
    });

    const result = await syncManagedFiles({
      paths,
      force: false
    });

    assert.equal(await readFile(victimPath, "utf8"), "outside\n");
    assert.ok(result.report.created.includes("AGENTS.md"));
  });
});

test("metadata v2 rejects symlinked ancestors that escape the deployment root", async () => {
  await withFixture(async ({ root, paths }) => {
    const outsideDir = join(root, "outside");
    const victimPath = join(outsideDir, "victim");
    await mkdir(paths.agentsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(victimPath, "outside\n", "utf8");
    await symlink(
      outsideDir,
      join(paths.agentsDir, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeInstallMetadata(paths, {
      schemaVersion: 2,
      managedFiles: {
        "escape/victim": hashBytes(Buffer.from("outside\n"))
      }
    });

    await assert.rejects(
      syncManagedFiles({ paths, force: false }),
      /Invalid managed file path/u
    );
    assert.equal(await readFile(victimPath, "utf8"), "outside\n");
    await assert.rejects(
      readFile(join(paths.agentsDir, "README.md")),
      (error) => error.code === "ENOENT"
    );
  });
});

test("v1 metadata treats legacy files as unknown ownership and preserves prior settings", async () => {
  await withFixture(async ({ paths }) => {
    const sourceAgents = await readFile(join(paths.workflowTemplateRoot, "AGENTS.md"), "utf8");
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", sourceAgents);
    await writeFixtureFile(paths.agentsDir, "commands/abel-init.md", "user init\n");
    await writeFixtureFile(paths.agentsDir, "commands/removed.md", "user legacy command\n");
    await writeInstallMetadata(paths, {
      package: "abelworkflow",
      features: { augmentContextEngine: false },
      managedChildren: { commands: ["abel-init.md", "removed.md"] },
      managedClaudePermissions: ["mcp__augment-context-engine"],
      linkedTargets: { "/target": { sourcePath: "/source", kind: "file", mode: "copy" } }
    });

    const result = await syncManagedFiles({ paths });
    const metadata = await persistSyncMetadata(paths, result);

    assert.ok(result.report.unchanged.includes("AGENTS.md"));
    assert.ok(result.report.conflicts.includes("commands/abel-init.md"));
    assert.equal(await readFile(join(paths.agentsDir, "commands/abel-init.md"), "utf8"), "user init\n");
    assert.equal(await readFile(join(paths.agentsDir, "commands/removed.md"), "utf8"), "user legacy command\n");
    assert.equal(result.report.removed.includes("commands/removed.md"), false);
    assert.equal(Object.hasOwn(result.managedFiles, "commands/abel-init.md"), false);
    assert.equal(Object.hasOwn(result.managedFiles, "commands/removed.md"), false);
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(Object.hasOwn(metadata, "managedChildren"), false);
    assert.equal(Object.hasOwn(metadata, "features"), false);
    assert.equal(Object.hasOwn(metadata, "managedClaudePermissions"), false);
    assert.deepEqual(metadata.linkedTargets, { "/target": { sourcePath: "/source", kind: "file", mode: "copy" } });
  });
});

test("force backs up v1 collisions without deleting legacy stale paths", async () => {
  await withFixture(async ({ paths }) => {
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", "user agents\n");
    await writeFixtureFile(paths.agentsDir, "commands/removed.md", "user legacy command\n");
    await writeInstallMetadata(paths, {
      package: "abelworkflow",
      managedChildren: { commands: ["removed.md"] }
    });

    const result = await syncManagedFiles({
      paths,
      force: true
    });

    assert.ok(result.report.updated.includes("AGENTS.md"));
    assert.equal(await readFile(join(paths.agentsDir, "commands/removed.md"), "utf8"), "user legacy command\n");
    const backupName = (await readdirNames(paths.agentsDir))
      .find((name) => name.startsWith("AGENTS.md.abelworkflow.bak."));
    assert.ok(backupName);
    assert.equal(await readFile(join(paths.agentsDir, backupName), "utf8"), "user agents\n");
  });
});

test("user-modified managed files conflict normally and force only exact manifest paths", async () => {
  await withFixture(async ({ paths }) => {
    const first = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, first);
    await writeFixtureFile(paths.agentsDir, "AGENTS.md", "user agents\n");
    await writeFixtureFile(paths.agentsDir, ".skill-lock.json", "{\"user\":true}\n");
    await writeFixtureFile(paths.agentsDir, "unknown.txt", "keep\n");

    const normal = await syncManagedFiles({ paths, force: false });
    assert.equal(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), "user agents\n");
    assert.ok(normal.report.conflicts.includes("AGENTS.md"));
    assert.equal(normal.managedFiles["AGENTS.md"], first.managedFiles["AGENTS.md"]);

    const forced = await syncManagedFiles({ paths, force: true });
    assert.match(await readFile(join(paths.agentsDir, "AGENTS.md"), "utf8"), /Use local codebase retrieval/u);
    assert.ok(forced.report.updated.includes("AGENTS.md"));
    assert.equal(await readFile(join(paths.agentsDir, ".skill-lock.json"), "utf8"), "{\"user\":true}\n");
    assert.equal(await readFile(join(paths.agentsDir, "unknown.txt"), "utf8"), "keep\n");
    assert.equal((await readdirNames(paths.agentsDir)).some((name) => name.startsWith("AGENTS.md.abelworkflow.bak.")), true);
  });
});

test("unowned collisions are not claimed and force never moves obstructing directories", async () => {
  await withFixture(async ({ paths }) => {
    await writeFixtureFile(paths.agentsDir, "README.md", "user readme\n");
    await mkdir(join(paths.agentsDir, "AGENTS.md"), { recursive: true });
    await writeFixtureFile(join(paths.agentsDir, "AGENTS.md"), ".env", "SECRET=keep\n");

    const normal = await syncManagedFiles({
      paths,
      force: false
    });
    assert.ok(normal.report.conflicts.includes("README.md"));
    assert.equal(Object.hasOwn(normal.managedFiles, "README.md"), false);

    const result = await syncManagedFiles({
      paths,
      force: true
    });

    assert.ok(result.report.conflicts.includes("AGENTS.md"));
    assert.equal(Object.hasOwn(result.managedFiles, "AGENTS.md"), false);
    assert.equal(await readFile(join(paths.agentsDir, "AGENTS.md", ".env"), "utf8"), "SECRET=keep\n");
    assert.match(await readFile(join(paths.agentsDir, "README.md"), "utf8"), /AbelWorkflow/u);
    assert.equal(result.managedFiles["README.md"].length, 64);
  });
});

test("managed asset symlinks conflict normally and are backed up before forced replacement", {
  skip: process.platform === "win32"
}, async () => {
  await withFixture(async ({ root, paths }) => {
    const linkedPath = join(root, "user-readme.md");
    const targetPath = join(paths.agentsDir, "README.md");
    await writeFile(linkedPath, "user readme\n", "utf8");
    await mkdir(paths.agentsDir, { recursive: true });
    await symlink(linkedPath, targetPath, "file");

    const normal = await syncManagedFiles({
      paths,
      force: false
    });

    assert.ok(normal.report.conflicts.includes("README.md"));
    assert.equal((await lstat(targetPath)).isSymbolicLink(), true);

    const forced = await syncManagedFiles({
      paths,
      force: true
    });

    assert.ok(forced.report.updated.includes("README.md"));
    assert.equal((await lstat(targetPath)).isFile(), true);
    assert.equal(await readFile(targetPath, "utf8"), "# AbelWorkflow\n");
    assert.equal(await readFile(linkedPath, "utf8"), "user readme\n");
    const backupName = (await readdirNames(paths.agentsDir))
      .find((name) => name.startsWith("README.md.abelworkflow.bak."));
    assert.ok(backupName);
    const backupPath = join(paths.agentsDir, backupName);
    assert.equal((await lstat(backupPath)).isSymbolicLink(), true);
    assert.equal(await readlink(backupPath), linkedPath);
  });
});

test("removed managed files are deleted only when unchanged or forced", async () => {
  await withFixture(async ({ paths }) => {
    const commandPath = join(paths.agentsDir, "commands", "abel-init.md");
    const sourceCommandPath = join(paths.workflowTemplateRoot, "commands", "abel-init.md");
    const first = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, first);
    await rm(sourceCommandPath);

    const removed = await syncManagedFiles({ paths });
    assert.ok(removed.report.removed.includes("commands/abel-init.md"));
    await assert.rejects(readFile(commandPath), (error) => error.code === "ENOENT");

    await writeFile(sourceCommandPath, "# restored\n", "utf8");
    const restored = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, restored);
    await writeFile(commandPath, "user command\n", "utf8");
    await rm(sourceCommandPath);

    const conflicted = await syncManagedFiles({ paths });
    assert.ok(conflicted.report.conflicts.includes("commands/abel-init.md"));
    assert.equal(
      conflicted.managedFiles["commands/abel-init.md"],
      restored.managedFiles["commands/abel-init.md"]
    );
    assert.equal(await readFile(commandPath, "utf8"), "user command\n");
    await persistSyncMetadata(paths, conflicted);

    const forced = await syncManagedFiles({ paths, force: true });
    assert.ok(forced.report.removed.includes("commands/abel-init.md"));
    assert.equal((await readdirNames(join(paths.agentsDir, "commands")))
      .some((name) => name.startsWith("abel-init.md.abelworkflow.bak.")), true);
  });
});

test("pathPrefix syncs and prunes only matching managed files", async () => {
  await withFixture(async ({ paths }) => {
    const first = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, first);
    await rm(join(paths.workflowTemplateRoot, "commands/abel-init.md"));
    await writeFixtureFile(paths.packageRoot, "skills/example/SKILL.md", "# Example v2\n");

    const result = await syncManagedFiles({ paths, pathPrefix: "skills/example/" });

    assert.deepEqual(result.report.updated, ["skills/example/SKILL.md"]);
    assert.deepEqual(result.report.removed, []);
    assert.equal(
      await readFile(join(paths.agentsDir, "skills/example/SKILL.md"), "utf8"),
      "# Example v2\n"
    );
    assert.equal(
      await readFile(join(paths.agentsDir, "commands/abel-init.md"), "utf8"),
      "# init\n"
    );
    assert.ok(Object.hasOwn(result.managedFiles, "commands/abel-init.md"));
    assert.ok(Object.hasOwn(result.managedFiles, "README.md"));
    assert.equal(result.managedFiles["AGENTS.md"], first.managedFiles["AGENTS.md"]);
  });
});

test("force preserves an obstructing directory at a stale managed file path and drops ownership", async () => {
  await withFixture(async ({ paths }) => {
    const relativePath = "commands/abel-init.md";
    const targetPath = join(paths.agentsDir, relativePath);
    const first = await syncManagedFiles({ paths });
    await persistSyncMetadata(paths, first);
    await rm(targetPath);
    await mkdir(targetPath, { recursive: true });
    await writeFixtureFile(targetPath, ".env", "SECRET=keep\n");
    await rm(join(paths.workflowTemplateRoot, relativePath));

    const result = await syncManagedFiles({ paths, force: true });

    assert.ok(result.report.conflicts.includes(relativePath));
    assert.ok(result.report.preserved.includes(relativePath));
    assert.equal(Object.hasOwn(result.managedFiles, relativePath), false);
    assert.equal(await readFile(join(targetPath, ".env"), "utf8"), "SECRET=keep\n");
  });
});

async function readdirNames(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

test("the repository does not publish or own a root user skill lock", async () => {
  const repoRoot = new URL("../", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", repoRoot), "utf8"));
  assert.equal(packageJson.files.includes(".skill-lock.json"), false);
  await assert.rejects(access(new URL(".skill-lock.json", repoRoot), constants.F_OK), (error) => error.code === "ENOENT");
});
