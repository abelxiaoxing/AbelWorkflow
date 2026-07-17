import * as fixtures from "./cli-characterization-fixtures.mjs";
Object.assign(globalThis, fixtures);

test("getRunCommandSpawnOptions preserves platform contracts", () => {
  const platforms = ["win32", "linux", "darwin", "freebsd", "unknown"];
  for (const platform of platforms) {
    assert.deepEqual(getRunCommandSpawnOptions(platform), {
      stdio: "inherit",
      shell: platform === "win32"
    });
  }
});

test("getRunCommandSpawnOptions default preserves ABELWORKFLOW_TEST_PLATFORM override", { concurrency: false }, () => {
  const previousPlatform = process.env.ABELWORKFLOW_TEST_PLATFORM;
  process.env.ABELWORKFLOW_TEST_PLATFORM = "win32";

  try {
    assert.deepEqual(getRunCommandSpawnOptions(), {
      stdio: "inherit",
      shell: true
    });
  } finally {
    if (previousPlatform === undefined) {
      delete process.env.ABELWORKFLOW_TEST_PLATFORM;
      return;
    }
    process.env.ABELWORKFLOW_TEST_PLATFORM = previousPlatform;
  }
});

test("inferPackageManagerFromCommandPath detects bun and npm global bins", () => {
  assert.equal(inferPackageManagerFromCommandPath("/home/test/.bun/bin/codex", {
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux"
  }), "bun");
  assert.equal(inferPackageManagerFromCommandPath("/usr/local/bin/codex", {
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux"
  }), "npm");
  assert.equal(inferPackageManagerFromCommandPath("C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd", {
    bunGlobalBinDir: "C:\\Users\\test\\.bun\\bin",
    npmGlobalPrefix: "C:\\Users\\test\\AppData\\Roaming\\npm",
    platform: "win32"
  }), "npm");
});

test("chooseCliInstallPackageManager preserves existing install manager before defaulting", () => {
  const base = {
    availablePackageManagers: ["bun", "npm"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux",
    nodeAvailable: true
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/usr/local/bin/codex"
  }), { packageManager: "npm", source: "existing" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/codex"
  }), { packageManager: "bun", source: "existing" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: "bun", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: ["npm"],
    commandPath: undefined
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: [],
    commandPath: undefined
  }), { packageManager: null, source: "missing" });
});

test("chooseCliInstallPackageManager honors npm-only tools that need install scripts", () => {
  const base = {
    availablePackageManagers: ["bun", "npm"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: "/usr/local",
    platform: "linux",
    nodeAvailable: true,
    supportedPackageManagers: ["npm"]
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/claude"
  }), { packageManager: "npm", source: "available" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    availablePackageManagers: ["bun"],
    commandPath: undefined
  }), { packageManager: null, source: "unsupported" });
});

test("chooseCliInstallPackageManager rejects bun for Node CLIs when node is unavailable", () => {
  const base = {
    availablePackageManagers: ["bun"],
    bunGlobalBinDir: "/home/test/.bun/bin",
    npmGlobalPrefix: undefined,
    platform: "linux",
    nodeAvailable: false
  };

  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: undefined
  }), { packageManager: null, source: "missing-node" });
  assert.deepEqual(chooseCliInstallPackageManager({
    ...base,
    commandPath: "/home/test/.bun/bin/pi"
  }), { packageManager: null, source: "missing-node" });
});

test("buildCliToolInstallCommand uses matching bun or npm global install syntax", () => {
  assert.deepEqual(buildCliToolInstallCommand("npm", {
    packageName: "@openai/codex",
    skipScripts: false
  }), {
    command: "npm",
    args: ["install", "-g", "@openai/codex", "--force"]
  });
  assert.deepEqual(buildCliToolInstallCommand("bun", {
    packageName: "@openai/codex",
    skipScripts: false
  }), {
    command: "bun",
    args: ["install", "-g", "@openai/codex"]
  });
  assert.deepEqual(buildCliToolInstallCommand("npm", {
    packageName: "@earendil-works/pi-coding-agent",
    skipScripts: true
  }), {
    command: "npm",
    args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent", "--force"]
  });
  assert.deepEqual(buildCliToolInstallCommand("bun", {
    packageName: "@earendil-works/pi-coding-agent",
    skipScripts: true
  }), {
    command: "bun",
    args: ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"]
  });
});

test("getPackageManagerInstallHelp returns mainland-friendly Node npm download guidance", () => {
  assert.deepEqual(getPackageManagerInstallHelp("win32"), {
    platformLabel: "Windows",
    mainlandUrl: "https://npmmirror.com/mirrors/node/",
    officialUrl: "https://nodejs.org/en/download/"
  });
  assert.deepEqual(getPackageManagerInstallHelp("darwin").platformLabel, "macOS");
  assert.deepEqual(getPackageManagerInstallHelp("linux").platformLabel, "Linux");
});


