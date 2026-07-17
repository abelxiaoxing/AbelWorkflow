import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, win32 } from "node:path";
import test from "node:test";

import { containsPath, createPaths } from "../lib/paths.mjs";

function withTempDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "abelworkflow-paths-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("createPaths resolves roots to absolute paths", () => {
  withTempDirectory((directory) => {
    const homeDir = relative(process.cwd(), join(directory, "home"));
    const packageRoot = relative(process.cwd(), join(directory, "source"));
    const agentsDir = relative(process.cwd(), join(directory, "deployment"));

    const paths = createPaths({ homeDir, packageRoot, agentsDir });

    assert.equal(paths.homeDir, resolve(homeDir));
    assert.equal(paths.packageRoot, resolve(packageRoot));
    assert.equal(paths.agentsDir, resolve(agentsDir));
    assert.equal(paths.workflowTemplateRoot, join(resolve(packageRoot), "lib", "templates", "workflow"));
  });
});

test("createPaths rejects equal and nested source/deployment roots even with force", () => {
  withTempDirectory((directory) => {
    const source = join(directory, "source");
    const deployment = join(directory, "deployment");
    const cases = [
      { packageRoot: source, agentsDir: source },
      { packageRoot: source, agentsDir: join(source, ".agents") },
      { packageRoot: source, agentsDir: join(source, "..deploy") },
      { packageRoot: join(deployment, "source"), agentsDir: deployment },
      { packageRoot: join(deployment, "..source"), agentsDir: deployment }
    ];

    for (const roots of cases) {
      assert.throws(
        () => createPaths({ ...roots, force: true }),
        (error) => error instanceof Error
          && /手动迁移/u.test(error.message)
          && /--force/u.test(error.message),
        JSON.stringify(roots)
      );
    }
  });
});

test("containsPath uses path-segment boundaries with Windows semantics", () => {
  assert.equal(containsPath("C:\\source", "C:\\source\\..deploy", win32), true);
  assert.equal(containsPath("C:\\source", "C:\\source-sibling", win32), false);
  assert.equal(containsPath("C:\\source", "D:\\source\\deploy", win32), false);
});

test("createPaths rejects existing filesystem aliases", () => {
  withTempDirectory((directory) => {
    const source = join(directory, "source");
    const alias = join(directory, "source-alias");
    mkdirSync(source, { recursive: true });
    symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");

    assert.throws(
      () => createPaths({ packageRoot: source, agentsDir: alias }),
      /手动迁移/u
    );
  });
});
