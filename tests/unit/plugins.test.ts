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
});
