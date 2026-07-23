import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { parseDotenv, updateDotenvContent } from "./dotenv.mjs";
import { stripJsonComments } from "./jsonc.mjs";

const newBackupMarker = ".abelworkflow.bak.";
const newBackupSuffixPattern = /^\d+-\d+-\d{10,}$/u;
let uniqueFileIndex = 0;

function nextUniqueSuffix() {
  uniqueFileIndex += 1;
  return `${Date.now()}-${process.pid}-${String(uniqueFileIndex).padStart(10, "0")}`;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function isPosix() {
  return process.platform !== "win32";
}

async function pathExists(path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function pathTargetExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function repairSensitiveMode(path) {
  if (!isPosix()) return false;
  const current = await fs.lstat(path);
  if (!current.isFile()) {
    throw new Error(`Refusing sensitive file access through non-regular path: ${path}`);
  }
  if ((current.mode & 0o777) === 0o600) return false;
  await fs.chmod(path, 0o600);
  return true;
}

async function readFileWithOptions(path, { fallback, sensitive = false, hasFallback = true } = {}) {
  try {
    if (sensitive) await assertSensitiveRegularIfPresent(path);
    const content = await fs.readFile(path, "utf8");
    if (sensitive) await repairSensitiveMode(path);
    return content;
  } catch (error) {
    if (isMissing(error) && hasFallback) return fallback;
    throw error;
  }
}

async function assertSensitiveRegularIfPresent(path) {
  try {
    const targetStat = await fs.lstat(path);
    if (!targetStat.isFile()) {
      throw new Error(`Refusing sensitive file access through non-regular path: ${path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function parseJsonAtPath(path, content, jsonc = false) {
  try {
    return JSON.parse(jsonc ? stripJsonComments(content) : content);
  } catch (error) {
    const format = jsonc ? "JSONC" : "JSON";
    throw new SyntaxError(`Invalid ${format} in ${path}: ${error.message}`, { cause: error });
  }
}

async function readJsonFileSafe(path, fallback = {}, options = {}) {
  const content = await readFileWithOptions(path, {
    fallback: null,
    sensitive: options.sensitive
  });
  return content === null ? fallback : parseJsonAtPath(path, content);
}

async function readJsoncFileSafe(path, fallback = {}, options = {}) {
  const content = await readFileWithOptions(path, {
    fallback: null,
    sensitive: options.sensitive
  });
  return content === null ? fallback : parseJsonAtPath(path, content, true);
}

async function readText(path, options = {}) {
  return readFileWithOptions(path, {
    fallback: options.fallback,
    sensitive: options.sensitive,
    hasFallback: Object.hasOwn(options, "fallback")
  });
}

async function listNewBackups(targetPath) {
  const directory = dirname(targetPath);
  const prefix = `${targetPath.slice(directory.length + 1)}${newBackupMarker}`;
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter((name) => (
    name.startsWith(prefix) && newBackupSuffixPattern.test(name.slice(prefix.length))
  )).sort();
}

async function pruneNewBackups(targetPath, backupLimit) {
  if (!Number.isInteger(backupLimit) || backupLimit < 0) {
    throw new TypeError("backupLimit must be a non-negative integer");
  }
  const names = await listNewBackups(targetPath);
  const removeCount = Math.max(0, names.length - backupLimit);
  await Promise.all(names.slice(0, removeCount).map((name) => fs.rm(join(dirname(targetPath), name), {
    recursive: true,
    force: true
  })));
}

async function createBackupPath(targetPath) {
  while (true) {
    const backupPath = `${targetPath}${newBackupMarker}${nextUniqueSuffix()}`;
    if (!(await pathExists(backupPath))) return backupPath;
  }
}

async function copyBackup(targetPath, { sensitive = false, backupLimit = 3 } = {}) {
  if (backupLimit === 0 || !(await pathExists(targetPath))) return null;
  if (sensitive) await assertSensitiveRegularIfPresent(targetPath);
  const backupPath = await createBackupPath(targetPath);
  await fs.cp(targetPath, backupPath, { recursive: true, force: false, errorOnExist: true });
  if (sensitive && isPosix()) await fs.chmod(backupPath, 0o600);
  await pruneNewBackups(targetPath, backupLimit);
  return backupPath;
}

async function writeText(path, content, options = {}) {
  const {
    sensitive = false,
    backupLimit = 3,
    mode: requestedMode,
    renameFile = fs.rename
  } = options;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  let previous = null;
  let previousMode;
  let exists = true;
  let permissionRepaired = false;

  if (sensitive) await assertSensitiveRegularIfPresent(path);
  try {
    previous = await fs.readFile(path);
    previousMode = (await fs.stat(path)).mode & 0o777;
  } catch (error) {
    if (!isMissing(error)) throw error;
    exists = false;
  }

  if (exists && sensitive) {
    permissionRepaired = await repairSensitiveMode(path);
    previousMode = 0o600;
  } else if (exists && requestedMode !== undefined && isPosix() && previousMode !== requestedMode) {
    await fs.chmod(path, requestedMode);
    previousMode = requestedMode;
    permissionRepaired = true;
  }

  if (exists && previous.equals(bytes)) {
    return { status: permissionRepaired ? "permission-repaired" : "unchanged", backupPath: null };
  }

  await fs.mkdir(dirname(path), { recursive: true, mode: sensitive ? 0o700 : 0o777 });
  const tempPath = join(dirname(path), `.${path.slice(dirname(path).length + 1)}.abelworkflow.tmp.${nextUniqueSuffix()}`);
  const mode = sensitive ? 0o600 : (requestedMode ?? previousMode ?? 0o644);
  let backupPath = null;
  try {
    await fs.writeFile(tempPath, bytes, { flag: "wx", mode });
    if (isPosix()) await fs.chmod(tempPath, mode);
    if (exists) backupPath = await copyBackup(path, { sensitive, backupLimit });
    await renameFile(tempPath, path);
    return { status: exists ? "updated" : "created", backupPath };
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJson(path, value, options = {}) {
  await readJsonFileSafe(path, {}, options);
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

async function updateLockedJson(path, updater, options = {}) {
  await fs.mkdir(dirname(path), { recursive: true, mode: options.sensitive ? 0o700 : 0o777 });
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: options.retries ?? 2,
    lockfilePath: `${path}.lock`
  });
  try {
    const current = await readJsonFileSafe(path, options.defaultValue ?? {}, options);
    const updated = await updater(current);
    return await writeJson(path, updated, options);
  } finally {
    await release();
  }
}

async function backupIfNeeded(targetPath, options = {}) {
  if (!(await pathExists(targetPath))) return null;
  const backupLimit = options.backupLimit ?? 3;
  if (backupLimit === 0) return null;
  const backupPath = await createBackupPath(targetPath);
  await fs.rename(targetPath, backupPath);
  if (options.sensitive && isPosix()) await fs.chmod(backupPath, 0o600);
  await pruneNewBackups(targetPath, backupLimit);
  return backupPath;
}

async function ensurePrivateJsonFile(path) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(path, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (isPosix()) await fs.chmod(path, 0o600);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertSensitiveRegularIfPresent(path);
    await repairSensitiveMode(path);
    return false;
  }
}

async function readDotenvFile(path, options = {}) {
  const content = await readFileWithOptions(path, {
    fallback: "",
    sensitive: options.sensitive
  });
  return parseDotenv(content);
}

async function updateDotenvFile(path, updates, options = {}) {
  const content = await readFileWithOptions(path, {
    fallback: "",
    sensitive: options.sensitive
  });
  return writeText(path, updateDotenvContent(content, updates), options);
}

export {
  backupIfNeeded,
  ensurePrivateJsonFile,
  pathExists,
  pathTargetExists,
  readDotenvFile,
  readJsonFileSafe,
  readJsoncFileSafe,
  readText,
  updateDotenvFile,
  updateLockedJson,
  writeJson,
  writeText
};
