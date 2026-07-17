import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function createPaths({
  homeDir = homedir(),
  packageRoot = defaultPackageRoot,
  agentsDir = join(homeDir, ".agents")
} = {}) {
  const absoluteHomeDir = resolve(homeDir);
  const absolutePackageRoot = resolve(packageRoot);
  const absoluteAgentsDir = resolve(agentsDir);
  assertSeparateSourceAndDeployment(absolutePackageRoot, absoluteAgentsDir);

  const codexTemplateRoot = join(absolutePackageRoot, "lib", "templates", "codex");
  const workflowTemplateRoot = join(absolutePackageRoot, "lib", "templates", "workflow");
  const piAgentDir = join(absoluteHomeDir, ".pi", "agent");
  return {
    homeDir: absoluteHomeDir,
    packageRoot: absolutePackageRoot,
    agentsDir: absoluteAgentsDir,
    workflowTemplateRoot,
    installMetadataName: ".abelworkflow-install.json",
    claudeSettingsPath: join(absoluteHomeDir, ".claude", "settings.json"),
    claudeMetaConfigPath: join(absoluteHomeDir, ".claude.json"),
    codexConfigPath: join(absoluteHomeDir, ".codex", "config.toml"),
    codexAuthPath: join(absoluteHomeDir, ".codex", "auth.json"),
    codexTemplateConfigPath: join(codexTemplateRoot, "config-base.toml"),
    codexTemplateAgentsPath: join(codexTemplateRoot, "agents"),
    piAgentDir,
    piAuthPath: join(piAgentDir, "auth.json"),
    piModelsPath: join(piAgentDir, "models.json"),
    piSettingsPath: join(piAgentDir, "settings.json")
  };
}

function assertSeparateSourceAndDeployment(packageRoot, agentsDir) {
  const canonicalPackageRoot = canonicalizeExistingPath(packageRoot);
  const canonicalAgentsDir = canonicalizeExistingPath(agentsDir);
  if (!containsPath(canonicalPackageRoot, canonicalAgentsDir)
    && !containsPath(canonicalAgentsDir, canonicalPackageRoot)) {
    return;
  }

  throw new Error(
    `源码目录 packageRoot (${packageRoot}) 与部署目录 agentsDir (${agentsDir}) 不能相同或互相嵌套。`
    + "请将源码克隆到独立目录（例如 ~/src/AbelWorkflow），再用 --agents-dir 指向 ~/.agents；"
    + "请手动迁移已有源码克隆，安装器不会自动移动或删除数据，--force 也不能绕过此限制。"
  );
}

function canonicalizeExistingPath(path) {
  const missingParts = [];
  let candidate = path;

  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingParts);
    } catch (error) {
      const parent = dirname(candidate);
      if (error?.code !== "ENOENT" || parent === candidate) return path;
      missingParts.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function containsPath(parent, child, pathOps = { isAbsolute, relative, sep }) {
  const childRelativePath = pathOps.relative(parent, child);
  return childRelativePath === ""
    || (childRelativePath !== ".."
      && !childRelativePath.startsWith(`..${pathOps.sep}`)
      && !pathOps.isAbsolute(childRelativePath));
}

const defaultPaths = createPaths();

function getPlatform() {
  return process.env.ABELWORKFLOW_TEST_PLATFORM || process.platform;
}

function isWindows() {
  return getPlatform() === "win32";
}

function pathToLabel(path, homeDir = defaultPaths.homeDir) {
  return path.replace(homeDir, "~");
}

function maskSecret(value) {
  if (!value) return "未配置";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

export { containsPath, createPaths, defaultPaths, getPlatform, isWindows, maskSecret, pathToLabel };
