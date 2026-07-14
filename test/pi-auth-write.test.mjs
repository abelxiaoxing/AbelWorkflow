import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { updatePiAuthFile } from "../lib/cli.mjs";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "abelworkflow-pi-auth-"));
  const authPath = join(root, ".pi", "agent", "auth.json");
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  return { root, authPath };
}

function writeAuth(path, data, mode = 0o600) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

test("updatePiAuthFile creates auth.json with mode 0600", {
  skip: process.platform === "win32"
}, async () => {
  const { root, authPath } = createFixture();
  try {
    await updatePiAuthFile(authPath, "new-key");

    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.equal(existsSync(`${authPath}.lock`), false);
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {
      gpt: { type: "api_key", key: "new-key" }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePiAuthFile tightens existing auth and backup permissions", {
  skip: process.platform === "win32"
}, async () => {
  const { root, authPath } = createFixture();
  try {
    writeAuth(authPath, { other: { type: "api_key", key: "other-key" } }, 0o644);

    await updatePiAuthFile(authPath, "new-key");

    const backupName = readdirSync(join(root, ".pi", "agent"))
      .find((name) => name.startsWith("auth.json.bak."));
    assert.ok(backupName);
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, ".pi", "agent", backupName)).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePiAuthFile rereads and merges auth.json inside the Pi lock", async () => {
  const { root, authPath } = createFixture();
  try {
    writeAuth(authPath, {
      other: { type: "api_key", key: "old-other" },
      gpt: { type: "api_key", key: "old-key", env: { HTTPS_PROXY: "keep" } }
    });
    const release = await lockfile.lock(authPath, { realpath: false });
    let settled = false;
    const updating = updatePiAuthFile(authPath, "new-key").then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);
    writeAuth(authPath, {
      other: { type: "api_key", key: "fresh-other" },
      added: { type: "api_key", key: "fresh-added" },
      gpt: { type: "api_key", key: "concurrent-key", env: { HTTPS_PROXY: "keep" } }
    });
    await release();
    await updating;

    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), {
      other: { type: "api_key", key: "fresh-other" },
      added: { type: "api_key", key: "fresh-added" },
      gpt: { type: "api_key", key: "new-key", env: { HTTPS_PROXY: "keep" } }
    });
    assert.equal(existsSync(`${authPath}.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePiAuthFile rejects invalid auth.json without overwriting it", async () => {
  const { root, authPath } = createFixture();
  try {
    writeFileSync(authPath, "{ invalid\n", { encoding: "utf8", mode: 0o600 });

    await assert.rejects(updatePiAuthFile(authPath, "new-key"), SyntaxError);
    assert.equal(readFileSync(authPath, "utf8"), "{ invalid\n");
    assert.equal(existsSync(`${authPath}.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
