import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep, win32 } from "node:path";
import test from "node:test";
import { hashBytes } from "../lib/utils.mjs";
import { createPaths } from "../lib/paths.mjs";
import {
  ensureManagedLink,
  getCommandNames,
  isWithinManagedRoot,
  linkClaude,
  linkCodex,
  linkPi,
  pruneManagedTargets
} from "../lib/installer/links.mjs";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-links-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const oldManagedHash = hashBytes(Buffer.from("old managed\n"));

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

async function createProviderSources(paths) {
  await mkdir(join(paths.agentsDir, "commands"), { recursive: true });
  await mkdir(join(paths.agentsDir, "skills", "example"), { recursive: true });
  await mkdir(join(paths.agentsDir, "extensions", "example"), { recursive: true });
  await writeFile(join(paths.agentsDir, "AGENTS.md"), "agents\n", "utf8");
  await writeFile(join(paths.agentsDir, "commands", "abel-init.md"), "init\n", "utf8");
  await writeFile(join(paths.agentsDir, "skills", "example", "SKILL.md"), "skill\n", "utf8");
  await writeFile(join(paths.agentsDir, "extensions", "example", "index.ts"), "extension\n", "utf8");
}

const providerRootCases = [
  {
    label: "Claude",
    blockedSegments: [".claude"],
    targetSegments: [".claude", "CLAUDE.md"],
    sourceSegments: ["AGENTS.md"],
    linkProvider: linkClaude
  },
  {
    label: "Codex",
    blockedSegments: [".codex"],
    targetSegments: [".codex", "AGENTS.md"],
    sourceSegments: ["AGENTS.md"],
    linkProvider: linkCodex
  },
  {
    label: "Pi root",
    blockedSegments: [".pi"],
    targetSegments: [".pi", "agent", "AGENTS.md"],
    sourceSegments: ["AGENTS.md"],
    linkProvider: linkPi
  },
  {
    label: "Pi agent",
    blockedSegments: [".pi", "agent"],
    targetSegments: [".pi", "agent", "AGENTS.md"],
    sourceSegments: ["AGENTS.md"],
    linkProvider: linkPi
  }
];

test("command enumeration skips symbolic-link loops without removing them", {
  skip: process.platform === "win32"
}, async () => {
  await withTempDir(async (root) => {
    const commandsDir = join(root, "commands");
    const loopPath = join(commandsDir, "loop.md");
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, "managed.md"), "managed\n", "utf8");
    await symlink(loopPath, loopPath, "file");

    assert.deepEqual(await getCommandNames(commandsDir), ["managed.md"]);
    assert.equal((await lstat(loopPath)).isSymbolicLink(), true);
  });
});

async function createHardlinkFixture(root) {
  const sourceRoot = join(root, "sources");
  const targetDir = join(root, "targets");
  const source = join(sourceRoot, "managed.md");
  const target = join(targetDir, "managed.md");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(source, "old managed\n", "utf8");
  await link(source, target);
  return { sourceRoot, targetDir, source, target };
}

function previousHardlinkState(sourcePath, targetPath, targetHash = oldManagedHash) {
  return {
    [targetPath]: {
      sourcePath,
      kind: "file",
      mode: "hardlink",
      ...(targetHash ? { targetHash } : {})
    }
  };
}

test("unknown link collisions are preserved normally and force replaces only the exact target", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "agents", "commands", "abel-init.md");
    const target = join(root, "home", ".codex", "prompts", "abel-init.md");
    const sibling = join(root, "home", ".codex", "prompts", "user.md");
    await mkdir(join(source, ".."), { recursive: true });
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(source, "managed\n", "utf8");
    await writeFile(target, "user collision\n", "utf8");
    await writeFile(sibling, "user sibling\n", "utf8");

    const normal = await ensureManagedLink(target, source, "file", {}, { force: false });
    assert.equal(normal.status, "conflict");
    assert.equal(await readFile(target, "utf8"), "user collision\n");

    const forced = await ensureManagedLink(target, source, "file", {}, { force: true });
    assert.equal(forced.status, "linked");
    assert.equal(await readFile(target, "utf8"), "managed\n");
    assert.equal(await readFile(sibling, "utf8"), "user sibling\n");
    assert.equal((await readdir(join(target, "..")))
      .some((name) => name.startsWith("abel-init.md.abelworkflow.bak.")), true);

    const repeated = await ensureManagedLink(target, source, "file", {
      [target]: forced
    }, { force: false });
    assert.equal(repeated.status, "unchanged");
  });
});

test("unchanged disconnected hard links update after atomic source replacement", async () => {
  await withTempDir(async (root) => {
    const { sourceRoot, source, target } = await createHardlinkFixture(root);
    const previous = previousHardlinkState(source, target);
    const connected = await ensureManagedLink(target, source, "file", previous, { force: false });
    assert.equal(connected.status, "unchanged");
    const replacement = join(sourceRoot, "replacement.md");
    await writeFile(replacement, "new managed\n", "utf8");
    await rename(replacement, source);
    assert.equal(await readFile(target, "utf8"), "old managed\n");

    const result = await ensureManagedLink(target, source, "file", previous, { force: false });

    assert.equal(result.status, "linked");
    assert.equal(await readFile(target, "utf8"), "new managed\n");
    assert.equal(result.targetHash, hashBytes(Buffer.from("new managed\n")));
  });
});

test("modified connected hard links cannot refresh recorded ownership", async () => {
  await withTempDir(async (root) => {
    const { sourceRoot, targetDir, source, target } = await createHardlinkFixture(root);
    const previous = previousHardlinkState(source, target);
    await writeFile(target, "user edit\n", "utf8");

    const result = await ensureManagedLink(target, source, "file", previous, { force: false });

    assert.deepEqual(result, { targetPath: target, status: "conflict" });
    assert.equal(await readFile(source, "utf8"), "user edit\n");

    await rm(source);
    const pruned = await pruneManagedTargets(targetDir, sourceRoot, [], previous, { force: false });
    assert.deepEqual(pruned, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  });
});

test("unchanged disconnected hard links are pruned after source deletion", async () => {
  await withTempDir(async (root) => {
    const { sourceRoot, targetDir, source, target } = await createHardlinkFixture(root);
    const previous = previousHardlinkState(source, target);
    await rm(source);

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], previous, { force: false });

    assert.deepEqual(results, [{ targetPath: target, status: "removed" }]);
    await assert.rejects(readFile(target), (error) => error.code === "ENOENT");
  });
});

test("modified disconnected hard-link targets remain conflicts", async () => {
  await withTempDir(async (root) => {
    const { sourceRoot, targetDir, source, target } = await createHardlinkFixture(root);
    const previous = previousHardlinkState(source, target);
    await rm(source);
    await writeFile(target, "user edit\n", "utf8");

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], previous, { force: false });

    assert.deepEqual(results, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  });
});

test("disconnected hard links without a recorded hash remain conflicts", async () => {
  await withTempDir(async (root) => {
    const { sourceRoot, targetDir, source, target } = await createHardlinkFixture(root);
    const previous = previousHardlinkState(source, target, null);
    await rm(source);

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], previous, { force: false });

    assert.deepEqual(results, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(target, "utf8"), "old managed\n");
  });
});

test("modified managed copies conflict using the recorded target hash", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "source.md");
    const target = join(root, "target.md");
    await writeFile(source, "new source\n", "utf8");
    await writeFile(target, "user edit\n", "utf8");
    const previous = {
      [target]: {
        sourcePath: source,
        kind: "file",
        mode: "copy",
        targetHash: hashBytes(Buffer.from("old managed\n"))
      }
    };

    const result = await ensureManagedLink(target, source, "file", previous, { force: false });

    assert.equal(result.status, "conflict");
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  });
});

test("copy metadata without a target hash cannot authorize file replacement", async () => {
  await withTempDir(async (root) => {
    const source = join(root, "source.md");
    const target = join(root, "target.md");
    await writeFile(source, "new source\n", "utf8");
    await writeFile(target, "user edit\n", "utf8");
    const previous = {
      [target]: {
        sourcePath: source,
        kind: "file",
        mode: "copy"
      }
    };

    const result = await ensureManagedLink(target, source, "file", previous, { force: false });

    assert.equal(result.status, "conflict");
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  });
});

test("identical Windows v1 managed copies are adopted with a v2 target hash", {
  concurrency: false
}, async () => {
  await withTestPlatform("win32", () => withTempDir(async (root) => {
    const source = join(root, "source.md");
    const target = join(root, "target.md");
    await writeFile(source, "managed\n", "utf8");
    await writeFile(target, "managed\n", "utf8");
    const previous = {
      [target]: {
        sourcePath: source,
        kind: "file",
        mode: "copy"
      }
    };

    const result = await ensureManagedLink(target, source, "file", previous, { force: false });

    assert.equal(result.status, "unchanged");
    assert.equal(result.mode, "copy");
    assert.equal(result.targetHash, hashBytes(Buffer.from("managed\n")));
    assert.equal(await readFile(target, "utf8"), "managed\n");
  }));
});

test("unverified Windows v1 copies remain conflicts even with force", {
  concurrency: false
}, async () => {
  await withTestPlatform("win32", () => withTempDir(async (root) => {
    const source = join(root, "source.md");
    const modifiedTarget = join(root, "modified.md");
    const missingSource = join(root, "missing.md");
    const missingSourceTarget = join(root, "missing-source.md");
    await writeFile(source, "managed\n", "utf8");
    await writeFile(modifiedTarget, "user edit\n", "utf8");
    await writeFile(missingSourceTarget, "user file\n", "utf8");

    const modified = await ensureManagedLink(modifiedTarget, source, "file", {
      [modifiedTarget]: { sourcePath: source, kind: "file", mode: "copy" }
    }, { force: true });
    const missing = await ensureManagedLink(missingSourceTarget, missingSource, "file", {
      [missingSourceTarget]: { sourcePath: missingSource, kind: "file", mode: "copy" }
    }, { force: true });

    assert.equal(modified.status, "conflict");
    assert.equal(missing.status, "conflict");
    assert.equal(await readFile(modifiedTarget, "utf8"), "user edit\n");
    assert.equal(await readFile(missingSourceTarget, "utf8"), "user file\n");
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".abelworkflow.bak.")), []);
  }));
});

test("copy metadata without a target hash cannot authorize file pruning", async () => {
  await withTempDir(async (root) => {
    const targetDir = join(root, "targets");
    const sourceRoot = join(root, "sources");
    const source = join(sourceRoot, "removed.md");
    const target = join(targetDir, "removed.md");
    await mkdir(targetDir, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(target, "user file\n", "utf8");

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], {
      [target]: {
        sourcePath: source,
        kind: "file",
        mode: "copy"
      }
    }, { force: false });

    assert.deepEqual(results, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(target, "utf8"), "user file\n");
  });
});

test("unverified Windows v1 copies cannot authorize forced pruning", {
  concurrency: false
}, async () => {
  await withTestPlatform("win32", () => withTempDir(async (root) => {
    const targetDir = join(root, "targets");
    const sourceRoot = join(root, "sources");
    const source = join(sourceRoot, "removed.md");
    const target = join(targetDir, "removed.md");
    await mkdir(targetDir, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(target, "user file\n", "utf8");

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], {
      [target]: { sourcePath: source, kind: "file", mode: "copy" }
    }, { force: true });

    assert.deepEqual(results, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(target, "utf8"), "user file\n");
    assert.deepEqual((await readdir(targetDir))
      .filter((name) => name.includes(".abelworkflow.bak.")), []);
  }));
});

test("copy metadata without a target hash cannot authorize directory pruning", async () => {
  await withTempDir(async (root) => {
    const targetDir = join(root, "targets");
    const sourceRoot = join(root, "sources");
    const source = join(sourceRoot, "removed-skill");
    const target = join(targetDir, "removed-skill");
    const userFile = join(target, "user.md");
    await mkdir(target, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(userFile, "user directory\n", "utf8");

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], {
      [target]: {
        sourcePath: source,
        kind: "dir",
        mode: "copy"
      }
    }, { force: false });

    assert.deepEqual(results, [{ targetPath: target, status: "conflict" }]);
    assert.equal(await readFile(userFile, "utf8"), "user directory\n");
  });
});

test("pruning removes only unchanged recorded targets and preserves unknown siblings", async () => {
  await withTempDir(async (root) => {
    const targetDir = join(root, "targets");
    const sourceRoot = join(root, "sources");
    const owned = join(targetDir, "owned.md");
    const edited = join(targetDir, "edited.md");
    const unknown = join(targetDir, "unknown.md");
    await mkdir(targetDir, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(owned, "owned\n", "utf8");
    await writeFile(edited, "user edit\n", "utf8");
    await writeFile(unknown, "unknown\n", "utf8");
    const previous = {
      [owned]: {
        sourcePath: join(sourceRoot, "owned.md"),
        kind: "file",
        mode: "copy",
        targetHash: hashBytes(Buffer.from("owned\n"))
      },
      [edited]: {
        sourcePath: join(sourceRoot, "edited.md"),
        kind: "file",
        mode: "copy",
        targetHash: hashBytes(Buffer.from("old managed\n"))
      }
    };

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], previous, { force: false });

    assert.ok(results.some((result) => result.targetPath === owned && result.status === "removed"));
    assert.ok(results.some((result) => result.targetPath === edited && result.status === "conflict"));
    await assert.rejects(readFile(owned), (error) => error.code === "ENOENT");
    assert.equal(await readFile(edited, "utf8"), "user edit\n");
    assert.equal(await readFile(unknown, "utf8"), "unknown\n");
  });
});

test("pruning ignores metadata targets that do not resolve to direct children", async () => {
  await withTempDir(async (root) => {
    const configDir = join(root, "home", ".codex");
    const targetDir = join(configDir, "skills");
    const sourceRoot = join(root, "agents", "skills");
    const sentinel = join(configDir, "config.toml");
    const traversalTarget = `${targetDir}${sep}..`;
    await mkdir(targetDir, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(sentinel, "preserve\n", "utf8");

    const results = await pruneManagedTargets(targetDir, sourceRoot, [], {
      [traversalTarget]: {
        sourcePath: join(sourceRoot, "missing"),
        kind: "dir",
        mode: "copy"
      }
    });

    assert.deepEqual(results, []);
    assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
    assert.deepEqual(await readdir(targetDir), []);
  });
});

test("managed-root containment rejects Windows cross-drive paths", () => {
  assert.equal(isWithinManagedRoot("D:\\deploy\\skills\\example", "C:\\deploy\\skills", win32), false);
  assert.equal(isWithinManagedRoot("C:\\deploy\\skills\\example", "C:\\deploy\\skills", win32), true);
});

test("provider links reject directory symlinks and Windows junctions before creating external files", async () => {
  await withTempDir(async (root) => {
    for (const [index, providerCase] of providerRootCases.entries()) {
      const caseRoot = join(root, String(index));
      const paths = createPaths({
        homeDir: join(caseRoot, "home"),
        agentsDir: join(caseRoot, "deploy"),
        packageRoot: join(caseRoot, "source")
      });
      const outside = join(caseRoot, "outside");
      const blockedRoot = join(paths.homeDir, ...providerCase.blockedSegments);
      await createProviderSources(paths);
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "sentinel.txt"), "preserve\n", "utf8");
      await mkdir(dirname(blockedRoot), { recursive: true });
      await symlink(outside, blockedRoot, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        providerCase.linkProvider(paths, {}, { force: false }),
        /Provider root conflict/u,
        providerCase.label
      );
      assert.deepEqual(await readdir(outside), ["sentinel.txt"]);
    }
  });
});

test("provider links reject linked roots before forced stale-target cleanup", async () => {
  await withTempDir(async (root) => {
    for (const [index, providerCase] of providerRootCases.entries()) {
      const caseRoot = join(root, String(index));
      const paths = createPaths({
        homeDir: join(caseRoot, "home"),
        agentsDir: join(caseRoot, "deploy"),
        packageRoot: join(caseRoot, "source")
      });
      const outside = join(caseRoot, "outside");
      const blockedRoot = join(paths.homeDir, ...providerCase.blockedSegments);
      const targetPath = join(paths.homeDir, ...providerCase.targetSegments);
      const sourcePath = join(paths.agentsDir, ...providerCase.sourceSegments);
      const outsideTarget = join(outside, ...providerCase.targetSegments.slice(providerCase.blockedSegments.length));
      await mkdir(dirname(outsideTarget), { recursive: true });
      await writeFile(outsideTarget, "user file\n", "utf8");
      await mkdir(dirname(blockedRoot), { recursive: true });
      await symlink(outside, blockedRoot, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        providerCase.linkProvider(paths, {
          [targetPath]: { sourcePath, kind: "file", mode: "copy" }
        }, { force: true }),
        /Provider root conflict/u,
        providerCase.label
      );
      assert.equal(await readFile(outsideTarget, "utf8"), "user file\n");
      assert.deepEqual((await readdir(dirname(outsideTarget)))
        .filter((name) => name.includes(".abelworkflow.bak.")), []);
    }
  });
});

test("provider links reject non-directory roots without replacing them", async () => {
  await withTempDir(async (root) => {
    for (const [index, providerCase] of providerRootCases.entries()) {
      const caseRoot = join(root, String(index));
      const paths = createPaths({
        homeDir: join(caseRoot, "home"),
        agentsDir: join(caseRoot, "deploy"),
        packageRoot: join(caseRoot, "source")
      });
      const blockedRoot = join(paths.homeDir, ...providerCase.blockedSegments);
      await mkdir(dirname(blockedRoot), { recursive: true });
      await writeFile(blockedRoot, "user file\n", "utf8");

      await assert.rejects(
        providerCase.linkProvider(paths, {}, { force: true }),
        /Provider root conflict/u,
        providerCase.label
      );
      assert.equal(await readFile(blockedRoot, "utf8"), "user file\n");
    }
  });
});

test("link providers use injected Paths roots and accept normal provider directories", async () => {
  await withTempDir(async (root) => {
    const paths = createPaths({
      homeDir: join(root, "home"),
      agentsDir: join(root, "deploy"),
      packageRoot: join(root, "source")
    });
    await createProviderSources(paths);
    await mkdir(join(paths.homeDir, ".claude"), { recursive: true });
    await mkdir(join(paths.homeDir, ".codex"), { recursive: true });
    await mkdir(join(paths.homeDir, ".pi", "agent"), { recursive: true });

    const results = [
      ...await linkClaude(paths, {}, { force: false }),
      ...await linkCodex(paths, {}, { force: false }),
      ...await linkPi(paths, {}, { force: false })
    ];

    assert.ok(results.every((result) => result.targetPath.startsWith(paths.homeDir)));
    assert.equal(await readFile(join(paths.homeDir, ".claude", "CLAUDE.md"), "utf8"), "agents\n");
    assert.equal(await readFile(join(paths.homeDir, ".codex", "AGENTS.md"), "utf8"), "agents\n");
    assert.equal(await readFile(join(paths.piAgentDir, "AGENTS.md"), "utf8"), "agents\n");
  });
});
