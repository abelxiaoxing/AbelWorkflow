import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  readJsonFileSafe,
  readJsoncFileSafe,
  updateLockedJson,
  writeJson,
  writeText
} from "../lib/config/store.mjs";

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-store-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function backupNames(root, filename) {
  return (await readdir(root))
    .filter((name) => name.startsWith(`${filename}.abelworkflow.bak.`))
    .sort();
}

test("writeText creates sensitive files atomically with mode 0600", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const target = join(root, "private", "auth.json");
    let renamedFrom;
    const result = await writeText(target, "{}\n", {
      sensitive: true,
      renameFile: async (source, destination) => {
        renamedFrom = source;
        assert.equal(destination, target);
        const { rename } = await import("node:fs/promises");
        await rename(source, destination);
      }
    });

    assert.equal(result.status, "created");
    assert.equal(dirname(renamedFrom), dirname(target));
    assert.equal((await stat(renamedFrom).catch(() => null)), null);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
});

test("same content is unchanged without backup or mtime update", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "settings.json");
    await writeText(target, "{}\n");
    const fixedTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(target, fixedTime, fixedTime);

    const result = await writeText(target, "{}\n");

    assert.equal(result.status, "unchanged");
    assert.equal((await stat(target)).mtimeMs, fixedTime.getTime());
    assert.deepEqual(await backupNames(root, "settings.json"), []);
  });
});

test("sensitive permission repair does not create a backup", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const target = join(root, "auth.json");
    await writeFile(target, "{}\n", { mode: 0o644 });
    await chmod(target, 0o644);

    const result = await writeText(target, "{}\n", { sensitive: true });

    assert.equal(result.status, "permission-repaired");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await backupNames(root, "auth.json"), []);
  });
});

test("changed sensitive content creates a restricted backup and retains only three new backups", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const target = join(root, "models.json");
    const legacyBackup = `${target}.bak.legacy`;
    await writeFile(legacyBackup, "legacy\n", { mode: 0o644 });
    await writeText(target, "0\n", { sensitive: true });

    for (let index = 1; index <= 4; index += 1) {
      const result = await writeText(target, `${index}\n`, { sensitive: true, backupLimit: 3 });
      assert.equal(result.status, "updated");
    }

    const backups = await backupNames(root, "models.json");
    assert.equal(backups.length, 3);
    for (const backup of backups) {
      assert.equal((await stat(join(root, backup))).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(legacyBackup, "utf8"), "legacy\n");
  });
});

test("backup pruning preserves near-match user paths and prunes only generated backups", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "settings.json");
    const userFile = `${target}.abelworkflow.bak.000-user-file`;
    const userDirectory = `${target}.abelworkflow.bak.001-user-directory`;
    const sentinel = join(userDirectory, "sentinel.txt");
    await writeFile(target, "0\n", "utf8");
    await writeFile(userFile, "user file\n", "utf8");
    await mkdir(userDirectory);
    await writeFile(sentinel, "user directory\n", "utf8");

    for (let index = 1; index <= 4; index += 1) {
      await writeText(target, `${index}\n`, { backupLimit: 3 });
    }

    assert.equal(await readFile(userFile, "utf8"), "user file\n");
    assert.equal(await readFile(sentinel, "utf8"), "user directory\n");
    assert.equal((await readdir(root)).filter((name) => (
      /^settings\.json\.abelworkflow\.bak\.\d+-\d+-\d{10}$/u.test(name)
    )).length, 3);
  });
});

test("JSON and JSONC parse errors include the path and never fall back", async () => {
  await withTempDir(async (root) => {
    for (const [name, reader] of [
      ["invalid.json", readJsonFileSafe],
      ["invalid.jsonc", readJsoncFileSafe]
    ]) {
      const target = join(root, name);
      await writeFile(target, "{ invalid", "utf8");
      await assert.rejects(reader(target, { fallback: true }), (error) => {
        assert.match(error.message, new RegExp(target.replaceAll("\\", "\\\\"), "u"));
        return true;
      });
      assert.equal(await readFile(target, "utf8"), "{ invalid");
    }
  });
});

test("unterminated JSONC block comments include the path and preserve the original bytes", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "unterminated.jsonc");
    const original = Buffer.from(`{"stable": true}\r\n/* user comment`, "utf8");
    await writeFile(target, original);

    await assert.rejects(readJsoncFileSafe(target, { fallback: true }), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.match(error.message, new RegExp(target.replaceAll("\\", "\\\\"), "u"));
      assert.match(error.message, /unterminated block comment/iu);
      return true;
    });
    assert.deepEqual(await readFile(target), original);
  });
});

test("only ENOENT returns a JSON fallback", async () => {
  await withTempDir(async (root) => {
    assert.deepEqual(await readJsonFileSafe(join(root, "missing.json"), { missing: true }), { missing: true });
    await mkdir(join(root, "directory.json"));
    await assert.rejects(readJsonFileSafe(join(root, "directory.json"), {}), (error) => error.code !== "ENOENT");
  });
});

test("rename failure preserves the original and cleans the same-directory temporary file", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "state.json");
    await writeJson(target, { stable: true });

    await assert.rejects(writeJson(target, { stable: false }, {
      renameFile: async () => {
        const error = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
    }), /simulated rename failure/u);

    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { stable: true });
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".abelworkflow.tmp.")), []);
  });
});

test("writeJson rejects invalid existing JSON with its path and preserves the bytes", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "invalid.json");
    await writeFile(target, "{ invalid\n", "utf8");

    await assert.rejects(writeJson(target, { valid: true }), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.match(error.message, new RegExp(target.replaceAll("\\", "\\\\"), "u"));
      return true;
    });
    assert.equal(await readFile(target, "utf8"), "{ invalid\n");
  });
});

test("failed sensitive replacement still tightens the existing target before backup", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const target = join(root, "auth.json");
    await writeFile(target, "{}\n", { mode: 0o644 });
    await chmod(target, 0o644);

    await assert.rejects(writeText(target, "{\"changed\":true}\n", {
      sensitive: true,
      renameFile: async () => {
        throw new Error("simulated rename failure");
      }
    }), /simulated rename failure/u);

    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const backups = await backupNames(root, "auth.json");
    assert.equal(backups.length, 1);
    assert.equal((await stat(join(root, backups[0]))).mode & 0o777, 0o600);
  });
});

test("sensitive writes reject symlinks without chmod or mutation of the external target", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (root) => {
    const external = join(root, "external.json");
    const target = join(root, "auth.json");
    await writeFile(external, "{}\n", { mode: 0o644 });
    await chmod(external, 0o644);
    await symlink(external, target);

    await assert.rejects(writeText(target, "{\"changed\":true}\n", { sensitive: true }), (error) => {
      assert.match(error.message, new RegExp(target.replaceAll("\\", "\\\\"), "u"));
      return true;
    });

    assert.equal(await readFile(external, "utf8"), "{}\n");
    assert.equal((await stat(external)).mode & 0o777, 0o644);
  });
});

test("updateLockedJson validates before atomically updating", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "locked.json");
    await writeFile(target, "{ invalid", "utf8");
    await assert.rejects(
      updateLockedJson(target, (value) => ({ ...value, updated: true })),
      new RegExp(target.replaceAll("\\", "\\\\"), "u")
    );
    assert.equal(await readFile(target, "utf8"), "{ invalid");

    await rm(target);
    await writeJson(target, { count: 1 });
    const result = await updateLockedJson(target, (value) => ({ count: value.count + 1 }));
    assert.equal(result.status, "updated");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { count: 2 });
  });
});
