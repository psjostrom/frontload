import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";

describe("config", () => {
  it("loads default config", () => {
    expect(loadConfig(process.cwd()).budgets.defaultReadChars).toBeGreaterThan(0);
  });

  it("loads repo config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-config-"));
    fs.writeFileSync(path.join(dir, "frontload.config.json"), JSON.stringify({ budgets: { defaultReadChars: 1234 } }));
    expect(loadConfig(dir).budgets.defaultReadChars).toBe(1234);
  });

  it("validates invalid config with helpful errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-config-bad-"));
    fs.writeFileSync(path.join(dir, "frontload.config.json"), JSON.stringify({ budgets: { defaultReadChars: -1 } }));
    expect(() => loadConfig(dir)).toThrow();
  });

  it("rejects tool output caps too small for structured hook output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-config-output-cap-"));
    fs.writeFileSync(path.join(dir, "frontload.config.json"), JSON.stringify({ budgets: { maxToolOutputChars: 1 } }));
    expect(() => loadConfig(dir)).toThrow();
  });

  it("respects ignore globs in defaults", () => {
    expect(loadConfig(process.cwd()).ignore).toContain("node_modules/**");
  });

  it("includes common generated directories in the starter ignore globs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-config-default-ignore-"));
    const example = JSON.parse(fs.readFileSync(path.resolve("frontload.config.example.json"), "utf8")) as { ignore: string[] };

    const expected = [".frontload/**", ".next/**", "out/**", "*.tsbuildinfo", ".Codex/**", ".codex/**", "**/.env*", "**/*.local.md"];

    expect(loadConfig(dir).ignore).toEqual(expect.arrayContaining(expected));
    expect(example.ignore).toEqual(expect.arrayContaining(expected));
  });

  it("provides gate defaults", () => {
    const gate = loadConfig(process.cwd()).gate;
    expect(gate).toEqual({
      enabled: true,
      rewriteCommands: true,
      blockBroadShell: true,
      blockNoisyReads: true,
      maxReadLines: 200
    });
  });

  it("allows disabling the gate via repo config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-gate-"));
    fs.writeFileSync(path.join(dir, "frontload.config.json"), JSON.stringify({ gate: { enabled: false } }));
    const gate = loadConfig(dir).gate;
    expect(gate.enabled).toBe(false);
    expect(gate.rewriteCommands).toBe(true);
  });

  it("documents hook controls in the primary README configuration example", () => {
    const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
    expect(readme).toContain("controls indexing, budgets, command allowlists, security");
    expect(readme).toContain("hook enforcement");
    expect(readme).toContain('"maxReadLines": 200');
  });
});
