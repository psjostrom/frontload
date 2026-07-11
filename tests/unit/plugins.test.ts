import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { gateCapabilities, gateMatcherForHostPhase } from "../../src/gate/capabilities.js";
import { hookConfigFor } from "../../src/hooks/definitions.js";
import { opencodeGatePluginWrapper } from "../../src/plugins/opencode-gate-wrapper.js";
import { validateBundledPlugins, validatePlugin } from "../../src/plugins/validate.js";

const pluginRoot = path.resolve("plugins");

function writeFakeFrontloadPackage(parent: string): { binDir: string } {
  const root = path.join(parent, "frontload-global");
  const cli = path.join(root, "dist/src/cli/index.js");
  const adapter = path.join(root, "dist/src/gate/adapters/opencode.js");
  const binDir = path.join(parent, "bin");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(adapter), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "frontload" }));
  fs.writeFileSync(cli, "#!/usr/bin/env node\n");
  fs.chmodSync(cli, 0o755);
  fs.writeFileSync(adapter, `
export const FrontloadGate = async () => ({
  "tool.execute.before": async (_input, output) => {
    output.args.command = "manual plugin adapter";
  }
});
`);
  fs.symlinkSync(cli, path.join(binDir, "frontload"));
  return { binDir };
}

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
    expect(result.checked).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the bundled opencode gate plugin as a shared adapter wrapper", () => {
    const pluginText = fs.readFileSync(path.join(pluginRoot, "opencode/plugins/frontload-gate.js"), "utf8");

    expect(pluginText).toBe(opencodeGatePluginWrapper(null));
    expect(pluginText).not.toContain("src/gate/gate.js");
    expect(pluginText).not.toContain("npm root -g");
    expect(pluginText).not.toContain("function loadConfig");
  });

  it("loads the bundled opencode gate plugin through a PATH-discovered package", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-plugin-load-"));
    const fake = writeFakeFrontloadPackage(temp);
    const pluginFile = path.join(temp, "frontload-gate.mjs");
    fs.copyFileSync(path.join(pluginRoot, "opencode/plugins/frontload-gate.js"), pluginFile);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      const plugin = await import(`${pathToFileURL(pluginFile).href}?manual-load`);
      const hooks = await plugin.FrontloadGate({ directory: temp });
      const output = { args: { command: "pnpm test" } };
      await hooks["tool.execute.before"]({ tool: "bash" }, output);

      expect(output.args.command).toBe("manual plugin adapter");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps declarative hook matchers aligned with runtime gate capabilities", () => {
    for (const host of ["claude", "codex"] as const) {
      const config = hookConfigFor(host).hooks;
      expect(config.PreToolUse[0].matcher).toBe(gateMatcherForHostPhase(host, "pre"));
      expect(config.PostToolUse[0].matcher).toBe(gateMatcherForHostPhase(host, "post"));
      expect(gateCapabilities[host].pre.length).toBeGreaterThan(0);
      expect(gateCapabilities[host].post.length).toBeGreaterThan(0);
    }
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

  it("rejects opencode gate plugins that bypass the shared adapter", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-plugin-validator-"));
    fs.cpSync(path.join(pluginRoot, "opencode"), root, { recursive: true });
    fs.writeFileSync(path.join(root, "plugins/frontload-gate.js"), `
export const FrontloadGate = async () => {
  const gate = await import("frontload/dist/src/gate/gate.js");
  return gate.evaluate;
};
`);

    expect(() => validatePlugin(root, "opencode")).toThrow("shared OpenCode adapter");
  });
});
