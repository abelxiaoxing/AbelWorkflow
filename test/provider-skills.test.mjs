import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureContext7Env,
  configureGrokSearchEnv,
  grokDefaults,
  readSkillEnvFile,
  updateSkillEnvFile
} from "../lib/providers/skills.mjs";
import { createPaths } from "../lib/paths.mjs";

const grokRoot = new URL("../skills/grok-search/", import.meta.url);

async function backupNames(directory) {
  return (await readdir(directory)).filter((name) => name.includes(".abelworkflow.bak."));
}

test("reading an existing skill env repairs its private mode", {
  skip: process.platform === "win32"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  await writeFile(target, "EXISTING=value\n", { mode: 0o644 });

  assert.deepEqual(await readSkillEnvFile(target), { EXISTING: "value" });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await backupNames(directory), []);
});

test("skill env updates preserve unknown fields and secure files and backups", {
  skip: process.platform === "win32"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  await writeFile(target, "UNKNOWN_FIELD=keep\nGROK_MODEL=old\n", { mode: 0o644 });

  const result = await updateSkillEnvFile(target, { GROK_MODEL: "new" });

  assert.equal(result.status, "updated");
  assert.deepEqual(
    Object.fromEntries((await readFile(target, "utf8")).trim().split("\n").map((line) => line.split("="))),
    { GROK_MODEL: "new", UNKNOWN_FIELD: "keep" }
  );
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const backups = await backupNames(directory);
  assert.equal(backups.length, 1);
  assert.equal((await stat(join(directory, backups[0]))).mode & 0o777, 0o600);
});

test("identical skill env update does not rewrite or create a backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  await writeFile(target, "EXISTING=value\n", { mode: 0o600 });
  const before = await stat(target);

  const result = await updateSkillEnvFile(target, { EXISTING: "value" });
  const after = await stat(target);

  assert.equal(result.status, "unchanged");
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await backupNames(directory), []);
});

test("skill env updates preserve unknown quoted credentials byte-for-byte", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  const unknownLines = [
    "# user credentials",
    `UNKNOWN_TOKEN='secret with "quote"'`,
    `UNKNOWN_BACKSLASH='secret\\path'`
  ];
  await writeFile(target, [...unknownLines, "GROK_MODEL=old", ""].join("\n"), { mode: 0o600 });

  await updateSkillEnvFile(target, { GROK_MODEL: "new" });

  const content = await readFile(target, "utf8");
  assert.ok(content.startsWith(`${unknownLines.join("\n")}\n`));
  assert.match(content, /^GROK_MODEL=new$/mu);
  assert.deepEqual(await readSkillEnvFile(target), {
    UNKNOWN_TOKEN: `secret with "quote"`,
    UNKNOWN_BACKSLASH: "secret\\path",
    GROK_MODEL: "new"
  });
});

test("managed quoted credentials roundtrip without needless rewrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  const original = `GROK_API_KEY='secret\\path with "quote"'\n`;
  await writeFile(target, original, { mode: 0o600 });

  const unchanged = await updateSkillEnvFile(target, {
    GROK_API_KEY: `secret\\path with "quote"`
  });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(await readFile(target, "utf8"), original);

  await updateSkillEnvFile(target, { GROK_API_KEY: `new\\path with "quote"` });
  assert.equal((await readSkillEnvFile(target)).GROK_API_KEY, `new\\path with "quote"`);
});

test("duplicate skill env assignments preserve the first runtime value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  await writeFile(target, "GROK_API_KEY=first\nGROK_API_KEY=second\n", { mode: 0o600 });

  const existing = await readSkillEnvFile(target);
  assert.equal(existing.GROK_API_KEY, "first");

  await updateSkillEnvFile(target, { GROK_API_KEY: existing.GROK_API_KEY });
  assert.equal(await readFile(target, "utf8"), "GROK_API_KEY=first\n");
});

test("an empty first skill env assignment blocks stale duplicate credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abelworkflow-skill-env-"));
  const target = join(directory, ".env");
  await writeFile(target, "GROK_API_KEY=\nGROK_API_KEY=stale\n", { mode: 0o600 });

  const existing = await readSkillEnvFile(target);
  assert.equal(existing.GROK_API_KEY, "");

  await updateSkillEnvFile(target, { GROK_API_KEY: existing.GROK_API_KEY });
  assert.equal(await readFile(target, "utf8"), "");
});

test("Grok installer and env example use the packaged runtime default", async () => {
  const defaults = JSON.parse(await readFile(new URL("defaults.json", grokRoot), "utf8"));
  const example = await readFile(new URL(".env.example", grokRoot), "utf8");
  const configuredModel = example.match(/^GROK_MODEL=(.+)$/mu)?.[1];

  assert.equal(defaults.model, "grok-4.20-non-reasoning");
  assert.equal(grokDefaults.model, defaults.model);
  assert.equal(configuredModel, defaults.model);
});

test("skill configuration forwards the complete custom Paths object", async () => {
  const root = join(tmpdir(), "abelworkflow-custom-paths");
  const paths = createPaths({
    homeDir: join(root, "home"),
    packageRoot: join(root, "package"),
    agentsDir: join(root, "deployment")
  });

  for (const configure of [
    configureGrokSearchEnv,
    configureContext7Env
  ]) {
    const sentinel = new Error("stop after path capture");
    let received;

    await assert.rejects(
      configure(paths, async (input) => {
        received = input;
        throw sentinel;
      }, {}),
      (error) => error === sentinel
    );

    assert.equal(received, paths);
    assert.equal(received.homeDir, join(root, "home"));
    assert.equal(received.packageRoot, join(root, "package"));
  }
});
