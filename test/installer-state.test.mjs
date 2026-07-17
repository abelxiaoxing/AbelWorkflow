import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildInstallMetadata,
  finalizeProviderInstallMetadata,
  getPreviousClaudePermissionProfile,
  getPreviousManagedCodexAgentFiles,
  getPreviousManagedCodexAuthKeys,
  readInstallMetadata,
  writeInstallMetadata
} from "../lib/installer/state.mjs";

const agentHashes = {
  "reviewer.toml": "b".repeat(64),
  "worker.toml": "a".repeat(64)
};

test("Codex agent ownership roundtrips through install metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-installer-state-"));
  const paths = {
    agentsDir: root,
    installMetadataName: ".abelworkflow-install.json"
  };
  try {
    const metadata = buildInstallMetadata({
      packageVersion: "1.0.0",
      managedCodexAgentFiles: agentHashes
    });
    await writeInstallMetadata(paths, metadata);

    assert.deepEqual((await readInstallMetadata(paths)).managedCodexAgentFiles, {
      "reviewer.toml": "b".repeat(64),
      "worker.toml": "a".repeat(64)
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema v2 metadata rebuild preserves exact Codex agent ownership when deployment is skipped", () => {
  const previousMetadata = {
    schemaVersion: 2,
    managedCodexAgentFiles: {
      ...agentHashes,
      "../outside.toml": "c".repeat(64),
      "invalid.toml": "not-a-hash"
    },
    managedCodexAuthKeys: ["KEEP_AUTH_KEY"]
  };

  assert.deepEqual(getPreviousManagedCodexAgentFiles(previousMetadata), agentHashes);
  const rebuilt = buildInstallMetadata({ previousMetadata, packageVersion: "1.0.1" });
  assert.deepEqual(rebuilt.managedCodexAgentFiles, agentHashes);
  assert.deepEqual(rebuilt.managedCodexAuthKeys, ["KEEP_AUTH_KEY"]);
});

test("published schema v1 metadata cannot claim schema v2 Codex agent ownership", () => {
  for (const previousMetadata of [
    {
      managedCodexAgentFiles: agentHashes,
      managedCodexAuthKeys: ["LEGACY_KEY"],
      claudePermissionProfile: "trusted"
    },
    {
      schemaVersion: 1,
      managedCodexAgentFiles: agentHashes,
      managedCodexAuthKeys: ["LEGACY_KEY"],
      claudePermissionProfile: "trusted"
    }
  ]) {
    assert.deepEqual(getPreviousManagedCodexAgentFiles(previousMetadata), {});
    assert.deepEqual(getPreviousManagedCodexAuthKeys(previousMetadata), []);
    assert.equal(getPreviousClaudePermissionProfile(previousMetadata), "standard");
    assert.deepEqual(buildInstallMetadata({
      previousMetadata,
      packageVersion: "1.0.0"
    }).managedCodexAgentFiles, {});
  }
});

test("provider metadata finalization migrates only published v1 fields", () => {
  const linkedTarget = {
    sourcePath: "/source",
    kind: "file",
    mode: "symlink"
  };
  const finalized = finalizeProviderInstallMetadata({
    previousMetadata: {
      package: "abelworkflow",
      installedAt: "legacy-time",
      features: { augmentContextEngine: true },
      managedChildren: { commands: ["legacy.md"] },
      managedClaudePermissions: ["Write", 42],
      linkedTargets: { "/target": linkedTarget },
      packageVersion: "legacy-version",
      managedFiles: { "AGENTS.md": "c".repeat(64) },
      managedCodexAuthKeys: ["LEGACY_KEY"],
      managedCodexAgentFiles: agentHashes,
      claudePermissionProfile: "trusted",
      unknown: true
    },
    packageVersion: "1.0.0",
    overrides: {
      managedCodexAuthKeys: [],
      managedCodexAgentFiles: {}
    }
  });

  assert.deepEqual(finalized, {
    schemaVersion: 2,
    packageVersion: "1.0.0",
    features: { augmentContextEngine: true },
    managedFiles: {},
    managedClaudePermissions: ["Write"],
    managedCodexAuthKeys: [],
    managedCodexAgentFiles: {},
    claudePermissionProfile: "standard",
    linkedTargets: { "/target": linkedTarget }
  });
});

test("provider metadata finalization preserves valid schema v2 fields", () => {
  const previousMetadata = {
    schemaVersion: 2,
    packageVersion: "1.0.0",
    installedAt: "stable-time",
    features: { augmentContextEngine: false },
    managedFiles: { "AGENTS.md": "c".repeat(64) },
    managedClaudePermissions: ["Bash"],
    managedCodexAuthKeys: ["CODEX_KEY"],
    managedCodexAgentFiles: agentHashes,
    claudePermissionProfile: "trusted",
    linkedTargets: {
      "/target": { sourcePath: "/source", kind: "file", mode: "symlink" }
    }
  };

  assert.deepEqual(finalizeProviderInstallMetadata({
    previousMetadata,
    packageVersion: "2.0.0",
    overrides: {
      managedCodexAuthKeys: ["CODEX_KEY"],
      managedCodexAgentFiles: agentHashes
    }
  }), previousMetadata);
});

test("direct Claude finalization records an explicit v2 profile safely", () => {
  const finalized = finalizeProviderInstallMetadata({
    previousMetadata: {
      schemaVersion: 1,
      features: { augmentContextEngine: false },
      managedClaudePermissions: ["legacy-safe"],
      claudePermissionProfile: "trusted",
      managedCodexAuthKeys: ["LEGACY_KEY"]
    },
    packageVersion: "1.0.0",
    overrides: {
      claudePermissionProfile: "trusted",
      managedClaudePermissions: ["Bash", "Write"]
    }
  });

  assert.equal(finalized.schemaVersion, 2);
  assert.equal(finalized.claudePermissionProfile, "trusted");
  assert.deepEqual(finalized.managedClaudePermissions, ["Bash", "Write"]);
  assert.deepEqual(finalized.managedCodexAuthKeys, []);
});
