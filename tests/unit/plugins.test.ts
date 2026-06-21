import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBundledPlugins, validatePlugin } from "../../src/plugins/validate.js";

const pluginRoot = path.resolve("plugins");

describe("plugin packages", () => {
  it("validates the Codex plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "codex"), "codex");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it("validates the Claude plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "claude"), "claude");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it("validates every bundled plugin from the repository root", () => {
    const results = validateBundledPlugins(path.resolve("."));
    expect(results.map((r) => r.host)).toEqual(["codex", "claude"]);
  });

  it("rejects a Frontload hook under the wrong matcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-plugin-validator-"));
    fs.cpSync(path.join(pluginRoot, "codex"), root, { recursive: true });
    const hooksFile = path.join(root, "hooks/hooks.json");
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    config.hooks.PostToolUse[0].matcher = "^apply_patch$";
    fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));

    expect(() => validatePlugin(root, "codex")).toThrow("PostToolUse");
  });
});
