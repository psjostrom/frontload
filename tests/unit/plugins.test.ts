import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { opencodeGatePluginWrapper } from "../../src/plugins/opencode-gate-wrapper.js";
import { validateBundledPlugins, validatePlugin } from "../../src/plugins/validate.js";

const pluginRoot = path.resolve("plugins");

describe("plugin packages", () => {
  it("validates the Codex plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "codex"), "codex");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("validates the Claude plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "claude"), "claude");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("validates the opencode plugin package with the TypeScript validator", () => {
    const result = validatePlugin(path.join(pluginRoot, "opencode"), "opencode");
    expect(result.summary).toContain("passed");
    expect(result.checked).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the bundled opencode gate plugin inert", () => {
    const pluginText = fs.readFileSync(path.join(pluginRoot, "opencode/plugins/frontload-gate.js"), "utf8");

    expect(pluginText).toBe(opencodeGatePluginWrapper(null));
    expect(pluginText).toContain("async () => ({})");
    expect(pluginText).not.toContain("loadAdapter");
    expect(pluginText).not.toContain("import(");
  });

  it("loads the bundled opencode gate plugin without registering hooks", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-plugin-load-"));
    const pluginFile = path.join(temp, "frontload-gate.mjs");
    fs.copyFileSync(path.join(pluginRoot, "opencode/plugins/frontload-gate.js"), pluginFile);
    const plugin = await import(`${pathToFileURL(pluginFile).href}?paused-load`);

    await expect(plugin.FrontloadGate({ directory: temp })).resolves.toEqual({});
  });

  it("validates every bundled plugin from the repository root", () => {
    const results = validateBundledPlugins(path.resolve("."));
    expect(results.map((r) => r.host)).toEqual(["codex", "claude", "opencode"]);
  });

  it("ships no declarative Codex or Claude hooks while paused", () => {
    for (const host of ["codex", "claude"] as const) {
      const hooksFile = path.join(pluginRoot, host, "hooks/hooks.json");
      expect(fs.existsSync(hooksFile)).toBe(false);
    }
  });

  it("ships only indefinitely halted agent guidance", () => {
    const skillFiles = [
      path.resolve("skills/frontload/SKILL.md"),
      ...["codex", "claude", "opencode"].map((host) =>
        path.join(pluginRoot, host, "skills/frontload/SKILL.md")
      )
    ];
    for (const skillFile of skillFiles) {
      const text = fs.readFileSync(skillFile, "utf8");
      expect(text).toContain("integration is halted indefinitely");
      expect(text).toContain("https://github.com/rtk-ai/rtk");
      expect(text).not.toMatch(/\bfl_[a-z_]+/);
    }
    const codex = JSON.parse(fs.readFileSync(
      path.join(pluginRoot, "codex/.codex-plugin/plugin.json"),
      "utf8"
    ));
    const claude = JSON.parse(fs.readFileSync(
      path.join(pluginRoot, "claude/.claude-plugin/plugin.json"),
      "utf8"
    ));
    expect(codex.description).toMatch(/halted indefinitely/i);
    expect(codex.interface.capabilities).toEqual([]);
    expect(codex.interface.defaultPrompt).toBeUndefined();
    expect(claude.description).toMatch(/halted indefinitely/i);
  });

  it("rejects a bundled hook file while integrations are paused", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-plugin-validator-"));
    fs.cpSync(path.join(pluginRoot, "codex"), root, { recursive: true });
    const hooksFile = path.join(root, "hooks/hooks.json");
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: {} }));

    expect(() => validatePlugin(root, "codex")).toThrow("must not ship hooks while paused");
  });

  it("rejects opencode gate plugins that bypass the shared adapter", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-plugin-validator-"));
    fs.cpSync(path.join(pluginRoot, "opencode"), root, { recursive: true });
    fs.writeFileSync(path.join(root, "plugins/frontload-gate.js"), `
export const FrontloadGate = async () => {
  const gate = await import("frontload/dist/src/gate/gate.js");
  return gate.evaluate;
};
`);

    expect(() => validatePlugin(root, "opencode")).toThrow("must remain paused");
  });

  it("rejects appended code after the paused opencode gate wrapper", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-plugin-appended-"));
    fs.cpSync(path.join(pluginRoot, "opencode"), root, { recursive: true });
    fs.appendFileSync(path.join(root, "plugins/frontload-gate.js"), "globalThis.frontloadHook = true;\n");

    expect(() => validatePlugin(root, "opencode")).toThrow("must remain paused");
  });
});
