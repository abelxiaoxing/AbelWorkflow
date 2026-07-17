import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { readConfigFile, sys } from "typescript";

const skillRoot = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", skillRoot), "utf8"));
const rootPackageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
);
const tsconfig = readConfigFile(fileURLToPath(new URL("tsconfig.json", skillRoot)), sys.readFile).config;
const startScript = readFileSync(new URL("scripts/start.ts", skillRoot), "utf8");
const scrapingGuide = readFileSync(new URL("references/scraping.md", skillRoot), "utf8");

describe("published runtime package", () => {
  it("targets Node 22 and starts compiled JavaScript", () => {
    expect(packageJson.engines).toEqual({ node: ">=22" });
    expect(packageJson.scripts["start-server"]).toBe("node dist/scripts/start.js standalone");
    expect(packageJson.scripts["start-extension"]).toBe("node dist/scripts/start.js extension");
    expect(packageJson.exports["./client"]).toEqual({
      types: "./dist/src/client.d.ts",
      import: "./dist/src/client.js",
    });
  });

  it("keeps runtime dependencies npm-only", () => {
    expect(packageJson.dependencies).not.toHaveProperty("express");
    expect(packageJson.devDependencies).not.toHaveProperty("@types/express");
    expect(packageJson.devDependencies).not.toHaveProperty("tsx");
    expect(packageJson.optionalDependencies ?? {}).not.toHaveProperty(
      "@rollup/rollup-linux-x64-gnu"
    );
    expect(existsSync(new URL("bun.lock", skillRoot))).toBe(false);
  });

  it("emits NodeNext ES2022 JavaScript and declarations", () => {
    expect(tsconfig.compilerOptions).toMatchObject({
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      rootDir: ".",
      outDir: "dist",
      declaration: true,
    });
    expect(tsconfig.compilerOptions.noEmit).not.toBe(true);
  });

  it("builds dev-browser before root package publication", () => {
    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json");
    expect(packageJson.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");
    expect(rootPackageJson.scripts.build).toBe("npm run build --prefix skills/dev-browser");
    expect(rootPackageJson.scripts.typecheck).toBe("npm run typecheck --prefix skills/dev-browser");
    expect(rootPackageJson.scripts.prepack).toBe("npm run build");
  });

  it("documents compiled startup commands without npx or tsx", () => {
    const skill = readFileSync(new URL("SKILL.md", skillRoot), "utf8");
    expect(skill).toContain("node dist/scripts/start.js standalone");
    expect(skill).toContain("node dist/scripts/start.js extension");
    expect(skill).not.toContain("npx tsx");
  });

  it("documents the relay WebSocket Origin boundary", () => {
    const skill = readFileSync(new URL("SKILL.md", skillRoot), "utf8");
    expect(skill).toContain("State-changing `/pages` requests accept only originless JSON clients");
    expect(skill).toContain("`/cdp` accepts only originless WebSocket clients");
    expect(skill).toContain(
      "`/extension` accepts originless protocol clients and valid `chrome-extension://` origins"
    );
    expect(skill).toContain("policy code `1008`");
  });

  it("routes every shutdown signal through the server stop callback", () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      expect(startScript).toContain(`process.on("${signal}", shutdown)`);
    }
    expect(startScript).toContain("shutdownPromise ??=");
  });

  it("keeps scraping scripts external, ephemeral, and credential-safe", () => {
    expect(scrapingGuide).toContain("pathToFileURL");
    expect(scrapingGuide).toContain("await import(");
    expect(scrapingGuide).toContain("tmpdir()");
    expect(scrapingGuide).toContain("task workspace");
    expect(scrapingGuide).toContain("finally");
    expect(scrapingGuide).toContain("Never persist complete authentication headers");
    expect(scrapingGuide).not.toContain('from "@/client.js"');
    expect(scrapingGuide).not.toContain('writeFileSync("tmp/request-details.json"');
  });
});
