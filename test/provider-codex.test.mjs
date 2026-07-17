import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexConfigContent,
  deployBundledCodexAgents,
  mergeCodexAuthData,
  persistCodexConfiguration,
  resolveExistingCodexApiConfig
} from "../lib/providers/codex.mjs";
import {
  buildInstallMetadata,
  getPreviousManagedCodexAuthKeys
} from "../lib/installer/state.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const developmentContext = `## Development Context

Development context: work is currently in the development phase, and this is a development repository.
Do not retain runtime user state in the repository or shipped artifacts, and do not preserve compatibility layers for unreleased behavior.
Prefer deleting obsolete code paths; keep code and prompts concise and avoid over-engineering.
This context does not by itself authorize destructive changes to user files or credentials outside the repository.

`;

function withoutDevelopmentContext(content) {
  return content.replace(developmentContext, "");
}

async function writeFixtureFile(root, relativePath, content) {
  const target = join(root, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function withCodexAgentFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-codex-agents-"));
  const paths = {
    homeDir: join(root, "home"),
    codexTemplateAgentsPath: join(root, "templates")
  };
  try {
    await mkdir(paths.codexTemplateAgentsPath, { recursive: true });
    await run({ root, paths, targetDir: join(paths.homeDir, ".codex", "agents") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex auth merge preserves unknown fields and deletes only recorded managed keys", () => {
  const auth = {
    OPENAI_API_KEY: "old-managed",
    OLD_ABEL_KEY: "old-managed",
    USER_API_KEY: "user-owned",
    tokens: { access_token: "keep-token" },
    providers: { custom: { token: "keep-provider" } },
    unknown: { nested: true }
  };
  const next = mergeCodexAuthData(auth, "NEW_ABEL_KEY", "new-secret", [
    "OPENAI_API_KEY",
    "OLD_ABEL_KEY"
  ]);

  assert.deepEqual(next, {
    NEW_ABEL_KEY: "new-secret",
    USER_API_KEY: "user-owned",
    tokens: { access_token: "keep-token" },
    providers: { custom: { token: "keep-provider" } },
    unknown: { nested: true }
  });
  assert.deepEqual(auth.tokens, { access_token: "keep-token" });
});

test("Codex auth clearing keeps unrelated and unrecorded keys", () => {
  const next = mergeCodexAuthData({
    CURRENT_KEY: "old-managed",
    STALE_BUT_UNRECORDED: "keep"
  }, "CURRENT_KEY", undefined, ["CURRENT_KEY"]);

  assert.deepEqual(next, { STALE_BUT_UNRECORDED: "keep" });
});

test("Codex auth refuses env keys that collide with structured auth state", () => {
  for (const envKey of ["tokens", "providers"]) {
    const auth = { [envKey]: { userOwned: true }, KEEP: "value" };
    assert.throws(
      () => mergeCodexAuthData(auth, envKey, "new-secret"),
      /conflicts with structured Codex auth state/iu
    );
    assert.deepEqual(auth, { [envKey]: { userOwned: true }, KEEP: "value" });
    assert.throws(
      () => resolveExistingCodexApiConfig(`model_provider = "custom"

[model_providers.custom]
temp_env_key = "${envKey}"
`, auth),
      /conflicts with structured Codex auth state/iu
    );
  }
});

test("Codex custom provider does not reuse a personal OpenAI API key", () => {
  const existing = resolveExistingCodexApiConfig(`model_provider = "custom"

[model_providers.custom]
temp_env_key = "CUSTOM_API_KEY"
`, {
    OPENAI_API_KEY: "personal-secret"
  });

  assert.equal(existing.envKey, "CUSTOM_API_KEY");
  assert.equal(existing.apiKey, "");
  assert.equal("legacyEnvKeys" in existing, false);
});

test("Codex derives custom provider env keys without reusing personal OpenAI credentials", () => {
  for (const requiresOpenAiAuth of ["", "requires_openai_auth = true\n"]) {
    const existing = resolveExistingCodexApiConfig(`model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://custom.example/v1"
${requiresOpenAiAuth}`, {
      OPENAI_API_KEY: "personal-secret"
    });

    assert.match(existing.envKey, /^ABELWORKFLOW_PROVIDER_[A-F0-9]{64}_API_KEY$/u);
    assert.equal(existing.apiKey, "");
  }
});

test("Codex derives and reads the OpenAI provider env key", () => {
  const existing = resolveExistingCodexApiConfig(`model_provider = "openai"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
`, {
    OPENAI_API_KEY: "openai-secret"
  });

  assert.equal(existing.envKey, "OPENAI_API_KEY");
  assert.equal(existing.apiKey, "openai-secret");
});

test("Codex managed auth key ownership survives installer metadata rebuilds", () => {
  const previousMetadata = {
    schemaVersion: 2,
    managedCodexAuthKeys: ["OLD_MANAGED_KEY"]
  };
  assert.deepEqual(getPreviousManagedCodexAuthKeys(previousMetadata), ["OLD_MANAGED_KEY"]);
  assert.deepEqual(buildInstallMetadata({
    previousMetadata,
    packageVersion: "1.0.0"
  }).managedCodexAuthKeys, ["OLD_MANAGED_KEY"]);
});

test("Codex config migrates exact published developer instructions", async () => {
  const template = await readFile(new URL("../lib/templates/codex/config-base.toml", import.meta.url), "utf8");
  const published = withoutDevelopmentContext(template)
    .replace("`/abel-*`", "`/oc:*`")
    .replace("- Copy this development context into every subagent task.\n", "");
  assert.equal(sha256(published), "12e1e68407fc3e8aa60da2bedca71ec1aefa7c11c6a0d8821d5f4dcc5ccbd681");
  const current = published.replace(
    "network_access = true\n",
    "network_access = true\nuser_setting = \"keep\"\n"
  );

  const result = buildCodexConfigContent(current, {
    templateContent: template,
    mergeMissingTemplateDefaults: true,
    includeSubagentDefaults: true,
    providerId: "abelworkflow",
    providerName: "AbelWorkflow",
    baseUrl: "https://example.com/v1",
    envKey: "ABELWORKFLOW_API_KEY"
  });

  assert.match(result, /## Development Context/u);
  assert.match(result, /`\/abel-\*`/u);
  assert.match(result, /^user_setting = "keep"$/mu);
  assert.equal(result.match(/^developer_instructions\s*=/gmu)?.length, 1);
});

test("Codex agent deployment migrates an exact published template without v2 ownership", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    const source = await readFile(
      new URL("../lib/templates/codex/agents/reviewer.toml", import.meta.url),
      "utf8"
    );
    const published = withoutDevelopmentContext(source);
    assert.equal(sha256(published), "a7292a533c9146bf5a2eb292cbfe889ca47bf4808324cddc1732c3c1721d437c");
    await writeFixtureFile(paths.codexTemplateAgentsPath, "reviewer.toml", source);
    const target = await writeFixtureFile(targetDir, "reviewer.toml", published);

    const result = await deployBundledCodexAgents(paths);

    assert.deepEqual(result.updated, [target]);
    assert.deepEqual(result.conflicts, []);
    assert.equal(await readFile(target, "utf8"), source);
    assert.equal(result.managedFiles["reviewer.toml"], sha256(source));
  });
});

test("Codex agent deployment creates missing files, updates owned files, and records exact hashes", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    await writeFixtureFile(paths.codexTemplateAgentsPath, "created.toml", "created source\n");
    await writeFixtureFile(paths.codexTemplateAgentsPath, "same.toml", "same source\n");
    await writeFixtureFile(paths.codexTemplateAgentsPath, "updated.toml", "updated source\n");
    await writeFixtureFile(targetDir, "same.toml", "same source\n");
    await writeFixtureFile(targetDir, "updated.toml", "previous source\n");

    const result = await deployBundledCodexAgents(paths, {
      "updated.toml": sha256("previous source\n")
    });

    assert.deepEqual(result, {
      managedFiles: {
        "created.toml": sha256("created source\n"),
        "same.toml": sha256("same source\n"),
        "updated.toml": sha256("updated source\n")
      },
      created: [join(targetDir, "created.toml")],
      updated: [join(targetDir, "updated.toml")],
      unchanged: [join(targetDir, "same.toml")],
      conflicts: []
    });
    assert.equal(await readFile(join(targetDir, "updated.toml"), "utf8"), "updated source\n");
  });
});

test("Codex agent deployment retains ownership when a managed template is user-modified", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    await writeFixtureFile(paths.codexTemplateAgentsPath, "modified.toml", "new source\n");
    await writeFixtureFile(targetDir, "modified.toml", "user edit\n");

    const result = await deployBundledCodexAgents(paths, {
      "modified.toml": sha256("previous source\n")
    });

    assert.deepEqual(result.managedFiles, {
      "modified.toml": sha256("previous source\n")
    });
    assert.deepEqual(result.conflicts, [join(targetDir, "modified.toml")]);
    assert.equal(await readFile(join(targetDir, "modified.toml"), "utf8"), "user edit\n");
    assert.deepEqual(await readdir(targetDir), ["modified.toml"]);
  });
});

test("Codex agent deployment leaves an unknown same-name file unowned", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    await writeFixtureFile(paths.codexTemplateAgentsPath, "unknown.toml", "bundled source\n");
    await writeFixtureFile(targetDir, "unknown.toml", "user file\n");

    const result = await deployBundledCodexAgents(paths);

    assert.deepEqual(result.managedFiles, {});
    assert.deepEqual(result.conflicts, [join(targetDir, "unknown.toml")]);
    assert.equal(await readFile(join(targetDir, "unknown.toml"), "utf8"), "user file\n");
    assert.deepEqual(await readdir(targetDir), ["unknown.toml"]);
  });
});

test("Codex agent deployment deletes a removed template only when its recorded hash still matches", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    const target = await writeFixtureFile(targetDir, "removed.toml", "old source\n");

    const result = await deployBundledCodexAgents(paths, {
      "removed.toml": sha256("old source\n")
    });

    assert.deepEqual(result, {
      managedFiles: {},
      created: [],
      updated: [],
      unchanged: [],
      conflicts: []
    });
    await assert.rejects(readFile(target, "utf8"), (error) => error.code === "ENOENT");
  });
});

test("Codex agent deployment preserves ownership for a user-modified removed template", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    const target = await writeFixtureFile(targetDir, "removed.toml", "user edit\n");
    const previousHash = sha256("old source\n");

    const result = await deployBundledCodexAgents(paths, {
      "removed.toml": previousHash
    });

    assert.deepEqual(result, {
      managedFiles: { "removed.toml": previousHash },
      created: [],
      updated: [],
      unchanged: [],
      conflicts: [target]
    });
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  });
});

test("Codex agent deployment preserves ownership for a non-regular removed template", async () => {
  await withCodexAgentFixture(async ({ paths, targetDir }) => {
    const target = join(targetDir, "removed.toml");
    const previousHash = sha256("old source\n");
    await mkdir(target, { recursive: true });

    const result = await deployBundledCodexAgents(paths, {
      "removed.toml": previousHash
    });

    assert.deepEqual(result.managedFiles, { "removed.toml": previousHash });
    assert.deepEqual(result.conflicts, [target]);
    assert.equal((await lstat(target)).isDirectory(), true);
  });
});

test("Codex agent deployment rejects unsafe agents containers before writing", async (t) => {
  await t.test("ancestor directory symlink before create", async () => {
    await withCodexAgentFixture(async ({ root, paths }) => {
      const externalDir = join(root, "external-codex");
      await mkdir(paths.homeDir, { recursive: true });
      await mkdir(externalDir);
      await symlink(
        externalDir,
        join(paths.homeDir, ".codex"),
        process.platform === "win32" ? "junction" : "dir"
      );
      await writeFixtureFile(paths.codexTemplateAgentsPath, "worker.toml", "bundled\n");

      await assert.rejects(
        deployBundledCodexAgents(paths),
        /Codex agent ancestor conflict/u
      );
      assert.deepEqual(await readdir(externalDir), []);
    });
  });

  await t.test("ancestor directory symlink before stale deletion", async () => {
    await withCodexAgentFixture(async ({ root, paths }) => {
      const externalDir = join(root, "external-codex");
      const externalTarget = await writeFixtureFile(externalDir, "agents/removed.toml", "old source\n");
      await mkdir(paths.homeDir, { recursive: true });
      await symlink(
        externalDir,
        join(paths.homeDir, ".codex"),
        process.platform === "win32" ? "junction" : "dir"
      );

      await assert.rejects(
        deployBundledCodexAgents(paths, {
          "removed.toml": sha256("old source\n")
        }),
        /Codex agent ancestor conflict/u
      );
      assert.equal(await readFile(externalTarget, "utf8"), "old source\n");
    });
  });

  await t.test("non-directory ancestor", async () => {
    await withCodexAgentFixture(async ({ paths }) => {
      await writeFixtureFile(paths.homeDir, ".codex", "user data\n");
      await writeFixtureFile(paths.codexTemplateAgentsPath, "worker.toml", "bundled\n");

      await assert.rejects(
        deployBundledCodexAgents(paths),
        /Codex agent ancestor conflict/u
      );
      assert.equal(await readFile(join(paths.homeDir, ".codex"), "utf8"), "user data\n");
    });
  });

  await t.test("directory symlink", async () => {
    await withCodexAgentFixture(async ({ root, paths, targetDir }) => {
      const externalDir = join(root, "external-agents");
      await mkdir(join(targetDir, ".."), { recursive: true });
      await mkdir(externalDir);
      await symlink(
        externalDir,
        targetDir,
        process.platform === "win32" ? "junction" : "dir"
      );
      await writeFixtureFile(paths.codexTemplateAgentsPath, "worker.toml", "bundled\n");

      await assert.rejects(
        deployBundledCodexAgents(paths),
        /Codex agent container conflict/u
      );
      assert.deepEqual(await readdir(externalDir), []);
    });
  });

  await t.test("non-directory", async () => {
    await withCodexAgentFixture(async ({ paths, targetDir }) => {
      await writeFixtureFile(paths.homeDir, ".codex/agents", "user data\n");
      await writeFixtureFile(paths.codexTemplateAgentsPath, "worker.toml", "bundled\n");

      await assert.rejects(
        deployBundledCodexAgents(paths),
        /Codex agent container conflict/u
      );
      assert.equal(await readFile(targetDir, "utf8"), "user data\n");
    });
  });

  await t.test("ordinary directories", async () => {
    await withCodexAgentFixture(async ({ paths, targetDir }) => {
      await mkdir(targetDir, { recursive: true });
      await writeFixtureFile(paths.codexTemplateAgentsPath, "worker.toml", "bundled\n");

      const result = await deployBundledCodexAgents(paths);

      assert.deepEqual(result.created, [join(targetDir, "worker.toml")]);
      assert.equal(await readFile(join(targetDir, "worker.toml"), "utf8"), "bundled\n");
    });
  });
});

test("Codex targeted TOML update preserves comments and unknown sections", () => {
  const current = `# user comment
model_provider = "old"

[model_providers.old]
name = "Old"
base_url = "https://old.example/v1"
custom_provider_field = "keep"

[user_section]
custom = "keep"

[agents]
custom_agent = "keep"
`;
  const next = buildCodexConfigContent(current, {
    templateContent: "",
    includeSubagentDefaults: false,
    providerId: "old",
    providerName: "Updated",
    baseUrl: "https://new.example/v1",
    envKey: "OPENAI_API_KEY"
  });

  assert.match(next, /^# user comment$/mu);
  assert.match(next, /^custom_provider_field = "keep"$/mu);
  assert.match(next, /^\[user_section\]$/mu);
  assert.match(next, /^custom = "keep"$/mu);
  assert.match(next, /^\[agents\]$/mu);
  assert.match(next, /^custom_agent = "keep"$/mu);
  assert.match(next, /^base_url = "https:\/\/new\.example\/v1"$/mu);
});

test("Codex targeted TOML update stops before an array-of-tables header", () => {
  const current = `model_provider = "old"

[model_providers.old]
base_url = "https://old.example/v1"

[[mcp_servers.entries]]
name = "user-array-name"
command = "user-command"
`;
  const next = buildCodexConfigContent(current, {
    templateContent: "",
    includeSubagentDefaults: false,
    providerId: "old",
    providerName: "Updated",
    baseUrl: "https://new.example/v1",
    envKey: "OPENAI_API_KEY"
  });
  const providerStart = next.indexOf("[model_providers.old]");
  const arrayStart = next.indexOf("[[mcp_servers.entries]]");
  const providerSection = next.slice(providerStart, arrayStart);
  const arraySection = next.slice(arrayStart);

  assert.ok(providerStart >= 0 && arrayStart > providerStart);
  assert.match(providerSection, /^name = "Updated"$/mu);
  assert.match(providerSection, /^base_url = "https:\/\/new\.example\/v1"$/mu);
  assert.match(providerSection, /^temp_env_key = "OPENAI_API_KEY"$/mu);
  assert.match(arraySection, /^name = "user-array-name"$/mu);
  assert.match(arraySection, /^command = "user-command"$/mu);
});

test("Codex targeted TOML update stops before quoted array-of-tables keys containing brackets", () => {
  const current = `model_provider = "old"

[model_providers.old]
base_url = "https://old.example/v1"

[[mcp_servers."entry]set"]]
name = "user-array-name"
command = "user-command"
`;
  const next = buildCodexConfigContent(current, {
    templateContent: "",
    includeSubagentDefaults: false,
    providerId: "old",
    providerName: "Updated",
    baseUrl: "https://new.example/v1",
    envKey: "OPENAI_API_KEY"
  });
  const providerStart = next.indexOf("[model_providers.old]");
  const arrayStart = next.indexOf(`[[mcp_servers."entry]set"]]`);
  const providerSection = next.slice(providerStart, arrayStart);
  const arraySection = next.slice(arrayStart);

  assert.ok(providerStart >= 0 && arrayStart > providerStart);
  assert.match(providerSection, /^name = "Updated"$/mu);
  assert.match(providerSection, /^temp_env_key = "OPENAI_API_KEY"$/mu);
  assert.match(arraySection, /^name = "user-array-name"$/mu);
  assert.doesNotMatch(arraySection, /^temp_env_key =/mu);
});

test("Codex persistence uses content-aware config writes and sensitive auth writes", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "abelworkflow-provider-codex-"));
  const paths = {
    codexConfigPath: join(root, ".codex", "config.toml"),
    codexAuthPath: join(root, ".codex", "auth.json")
  };
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(paths.codexConfigPath, "# keep\nmodel = \"gpt-test\"\n");
  await writeFile(paths.codexAuthPath, "{\"UNKNOWN\":\"keep\"}\n", { mode: 0o644 });
  await chmod(paths.codexAuthPath, 0o644);

  try {
    await persistCodexConfiguration(paths, {
      content: "# keep\nmodel = \"gpt-test\"\n",
      auth: { UNKNOWN: "keep" }
    });
    const firstStat = await stat(paths.codexConfigPath);
    const filesAfterFirstWrite = (await readdir(join(root, ".codex"))).sort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await persistCodexConfiguration(paths, {
      content: "# keep\nmodel = \"gpt-test\"\n",
      auth: { UNKNOWN: "keep" }
    });
    const secondStat = await stat(paths.codexConfigPath);

    assert.equal(firstStat.mtimeMs, secondStat.mtimeMs);
    assert.equal((await stat(paths.codexAuthPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(paths.codexConfigPath, "utf8"), "# keep\nmodel = \"gpt-test\"\n");
    assert.deepEqual((await readdir(join(root, ".codex"))).sort(), filesAfterFirstWrite);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
