import { createHash } from "node:crypto";

function hashBytes(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isManagedCodexAgentFileEntry(name, hash) {
  return name.endsWith(".toml")
    && !name.includes("/")
    && !name.includes("\\")
    && typeof hash === "string"
    && /^[a-f0-9]{64}$/u.test(hash);
}

export { hashBytes, isManagedCodexAgentFileEntry };
