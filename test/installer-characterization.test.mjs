import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("package-root install copies Pi extensions into agents dir and links them", () => {
  const homeDir = mkdtempAgentsHome();
  try {
    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const managedExtension = readFileSync(join(homeDir, ".agents", "extensions", "pi-gpt-responses-compat", "index.ts"), "utf8");
    const linkedExtension = readFileSync(join(homeDir, ".pi", "agent", "extensions", "pi-gpt-responses-compat", "index.ts"), "utf8");
    const linkedTlsHelper = readFileSync(join(homeDir, ".pi", "agent", "extensions", "pi-gpt-responses-compat", "tls-fetch.mjs"), "utf8");

    assert.match(managedExtension, /before_provider_request/u);
    assert.match(linkedExtension, /before_provider_request/u);
    assert.match(linkedTlsHelper, /createProviderTlsFetch/u);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("install migrates a legacy Pi prompts symlink without corrupting managed commands", () => {
  const homeDir = mkdtempAgentsHome();
  const agentsDir = join(homeDir, ".agents");
  const commandsDir = join(agentsDir, "commands");
  const piAgentDir = join(homeDir, ".pi", "agent");
  const promptsDir = join(piAgentDir, "prompts");
  const commandName = "abel-init.md";
  const commandPath = join(commandsDir, commandName);
  const sourceContent = readFileSync(new URL(`lib/templates/workflow/commands/${commandName}`, repoRoot), "utf8");

  try {
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(commandPath, sourceContent, "utf8");
    symlinkSync(commandsDir, promptsDir, process.platform === "win32" ? "junction" : "dir");

    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(lstatSync(promptsDir).isDirectory());
    assert.ok(lstatSync(commandPath).isFile());
    const promptStat = lstatSync(join(promptsDir, commandName));
    if (process.platform === "win32") assert.ok(promptStat.isFile() || promptStat.isSymbolicLink());
    else assert.ok(promptStat.isSymbolicLink());
    assert.equal(
      readFileSync(commandPath, "utf8"),
      renderWorkflowTemplate(sourceContent, { augmentContextEngine: false })
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("install preserves an unknown self-referential managed command symlink", {
  skip: process.platform === "win32"
}, () => {
  const homeDir = mkdtempAgentsHome();
  const commandsDir = join(homeDir, ".agents", "commands");
  const commandName = "abel-init.md";
  const commandPath = join(commandsDir, commandName);

  try {
    mkdirSync(commandsDir, { recursive: true });
    symlinkSync(commandPath, commandPath, "file");

    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(lstatSync(commandPath).isSymbolicLink());
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("package-root install preserves unknown legacy Pi files while adding the managed directory", () => {
  const homeDir = mkdtempAgentsHome();
  const agentsDir = join(homeDir, ".agents");
  const legacySource = join(agentsDir, "extensions", "pi-gpt-responses-compat.ts");
  const legacyTarget = join(homeDir, ".pi", "agent", "extensions", "pi-gpt-responses-compat.ts");
  const userExtension = "export default function userExtension() {}\n";
  try {
    mkdirSync(join(agentsDir, "extensions"), { recursive: true });
    mkdirSync(join(homeDir, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(legacySource, "export default function () {}\n", "utf8");
    writeFileSync(legacyTarget, userExtension, "utf8");
    writeFileSync(join(agentsDir, ".abelworkflow-install.json"), `${JSON.stringify({
      managedChildren: { extensions: ["pi-gpt-responses-compat.ts"] },
      linkedTargets: {
        [legacyTarget]: {
          sourcePath: legacySource,
          kind: "file",
          mode: "copy"
        }
      }
    }, null, 2)}\n`, "utf8");

    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(legacySource, "utf8"), "export default function () {}\n");
    assert.equal(readFileSync(legacyTarget, "utf8"), userExtension);
    assert.match(readFileSync(join(
      homeDir,
      ".pi",
      "agent",
      "extensions",
      "pi-gpt-responses-compat",
      "tls-fetch.mjs"
    ), "utf8"), /createProviderTlsFetch/u);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("source-clone install fails before mutation and force cannot bypass migration guidance", () => {
  const homeDir = mkdtempAgentsHome();
  const agentsDir = join(homeDir, ".agents");
  try {
    copySourceInstallFixture(agentsDir);
    const agentsBefore = readFileSync(join(agentsDir, "AGENTS.md"), "utf8");
    const designBefore = readFileSync(join(agentsDir, "lib", "templates", "workflow", "commands", "abel-design.md"), "utf8");
    const result = spawnSync(process.execPath, ["bin/abelworkflow.mjs", "install", "--force"], {
      cwd: agentsDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        NO_COLOR: "1"
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr || result.stdout, /手动迁移/u);
    assert.match(result.stderr || result.stdout, /--force/u);
    assert.equal(readFileSync(join(agentsDir, "AGENTS.md"), "utf8"), agentsBefore);
    assert.equal(readFileSync(join(agentsDir, "lib", "templates", "workflow", "commands", "abel-design.md"), "utf8"), designBefore);
    assert.equal(existsSync(join(homeDir, ".codex", "AGENTS.md")), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
