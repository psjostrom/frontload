import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hookConfigFor, type HookHost } from "../hooks/definitions.js";
import { isGeneratedOpencodeGateWrapper } from "./opencode-gate-wrapper.js";

const authorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  url: z.string().url().optional()
});

const codexPluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  author: authorSchema,
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  skills: z.string().startsWith("./"),
  interface: z.object({
    displayName: z.string().min(1),
    shortDescription: z.string().min(1),
    longDescription: z.string().min(1),
    developerName: z.string().min(1),
    category: z.string().min(1),
    capabilities: z.array(z.string()).optional(),
    websiteURL: z.string().url().optional(),
    privacyPolicyURL: z.string().url().optional(),
    termsOfServiceURL: z.string().url().optional(),
    defaultPrompt: z.array(z.string().max(128)).max(3).optional(),
    brandColor: z.string().optional()
  })
}).strict();

const claudePluginSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(1),
  author: authorSchema,
  homepage: z.string().url().optional(),
  repository: z.string().url().optional(),
  license: z.string().min(1).optional()
}).strict();

const hooksConfigSchema = z.object({
  hooks: z.record(
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(
          z.object({
            type: z.literal("command"),
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            timeout: z.number().positive().optional(),
            statusMessage: z.string().optional()
          }).passthrough()
        )
      }).passthrough()
    )
  )
});

type HooksConfig = z.infer<typeof hooksConfigSchema>;

export type PluginValidationResult = {
  summary: string;
  root: string;
  host: "codex" | "claude" | "opencode";
  checked: string[];
  warnings: string[];
};

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertFile(file: string, label: string, checked: string[]): void {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
  checked.push(file);
}

function assertSkill(file: string): void {
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---\n")) throw new Error(`Skill is missing YAML frontmatter: ${file}`);
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error(`Skill frontmatter is not closed: ${file}`);
  const body = text.slice(end + 4).trim();
  if (body.length < 40) throw new Error(`Skill body is too short: ${file}`);
}

function assertFrontloadHook(config: HooksConfig, host: HookHost, file: string): void {
  const expected = hookConfigFor(host).hooks;
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const expectedGroup = expected[event][0];
    const expectedHook = expectedGroup.hooks[0];
    const found = (config.hooks[event] ?? []).some((group) =>
      group.matcher === expectedGroup.matcher &&
      group.hooks.some((hook) => JSON.stringify(hook) === JSON.stringify(expectedHook))
    );
    if (!found) {
      throw new Error(`${file} must define the ${host} Frontload ${event} hook command`);
    }
  }
}

function assertOpencodeGatePlugin(file: string): void {
  const text = fs.readFileSync(file, "utf8");
  if (!isGeneratedOpencodeGateWrapper(text)) {
    throw new Error(`${file} must delegate to the shared OpenCode adapter`);
  }
}

export function validatePlugin(root: string, host: "codex" | "claude" | "opencode"): PluginValidationResult {
  const absRoot = path.resolve(root);
  const checked: string[] = [];
  const warnings: string[] = [];
  const manifestFile = host === "codex"
    ? path.join(absRoot, ".codex-plugin/plugin.json")
    : host === "claude"
      ? path.join(absRoot, ".claude-plugin/plugin.json")
      : "";
  const hooksFile = path.join(absRoot, "hooks/hooks.json");
  const skillFile = path.join(absRoot, "skills/frontload/SKILL.md");

  if (manifestFile) {
    assertFile(manifestFile, `${host} plugin manifest`, checked);
    const manifest = readJson(manifestFile);
    if (host === "codex") codexPluginSchema.parse(manifest);
    else claudePluginSchema.parse(manifest);
  }

  if (fs.existsSync(hooksFile)) {
    assertFile(hooksFile, "hooks config", checked);
    assertFrontloadHook(hooksConfigSchema.parse(readJson(hooksFile)), host as HookHost, hooksFile);
  }
  if (host === "opencode") {
    const pluginFile = path.join(absRoot, "plugins/frontload-gate.js");
    assertFile(pluginFile, "Frontload gate plugin", checked);
    assertOpencodeGatePlugin(pluginFile);
  }
  assertFile(skillFile, "Frontload skill", checked);
  assertSkill(skillFile);

  return {
    summary: `${host} plugin validation passed (${checked.length} files checked).`,
    root: absRoot,
    host,
    checked,
    warnings
  };
}

export function validateBundledPlugins(repoRoot = process.cwd()): PluginValidationResult[] {
  return [
    validatePlugin(path.join(repoRoot, "plugins/codex"), "codex"),
    validatePlugin(path.join(repoRoot, "plugins/claude"), "claude"),
    validatePlugin(path.join(repoRoot, "plugins/opencode"), "opencode")
  ];
}
