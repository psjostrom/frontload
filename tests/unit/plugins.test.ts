import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hookConfigFor } from "../../src/hooks/definitions.js";
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

  it("validates the opencode plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "opencode"), "opencode");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("validates every bundled plugin from the repository root", () => {
    const results = validateBundledPlugins(path.resolve("."));
    expect(results.map((r) => r.host)).toEqual(["codex", "claude", "opencode"]);
  });

  it("keeps bundled hook files equal to the canonical host definitions", () => {
    for (const host of ["codex", "claude"] as const) {
      const hooksFile = path.join(pluginRoot, host, "hooks/hooks.json");
      expect(JSON.parse(fs.readFileSync(hooksFile, "utf8"))).toEqual(hookConfigFor(host));
    }
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

  it("rejects a Frontload hook whose command metadata differs from the canonical definition", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-plugin-validator-metadata-"));
    fs.cpSync(path.join(pluginRoot, "codex"), root, { recursive: true });
    const hooksFile = path.join(root, "hooks/hooks.json");
    const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
    config.hooks.PostToolUse[0].hooks[0].statusMessage = "Different status";
    fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2));

    expect(() => validatePlugin(root, "codex")).toThrow("PostToolUse");
  });
});
