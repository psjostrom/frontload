import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { AgentBudgetConfig, loadConfig } from "../config/config.js";
import { CommandSummary, Finding } from "../types.js";
import { nowStamp, stateDir } from "../utils/path.js";
import { capText, redactSecrets } from "../utils/text.js";

function parseFindings(output: string): Finding[] {
  const findings: Finding[] = [];
  const ts1 = /(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g;
  const ts2 = /(.+?):(\d+):(\d+) - error (TS\d+): (.+)/g;
  for (const re of [ts1, ts2]) {
    for (const m of output.matchAll(re)) {
      findings.push({ severity: "error", file: m[1], line: Number(m[2]), column: Number(m[3]), title: `${m[4]}: ${m[5]}` });
    }
  }
  const failFile = output.match(/FAIL\s+([^\s]+)/);
  const testName = output.match(/(?:x|\u00d7|\u2715)\s+(.+?)\s+\d+ms|test\(["'](.+?)["']/);
  if (failFile || testName) {
    findings.push({
      severity: "error",
      file: failFile?.[1],
      title: testName?.[1] ?? testName?.[2] ?? "Failing test",
      detail: [output.match(/Expected:.*|expected .* to .*/i)?.[0], output.match(/Received:.*/i)?.[0]].filter(Boolean).join("\n") || undefined,
      stack: output.match(/\s+at .+:\d+:\d+/g)?.slice(0, 8).map((s) => s.trim())
    });
  }
  if (!findings.length) {
    const lines = output.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/error|failed|FAIL|AssertionError|Expected|Received/i.test(line)) {
        findings.push({ severity: /warn/i.test(line) ? "warning" : "error", title: line.trim(), detail: lines.slice(Math.max(0, i - 2), i + 3).join("\n") });
      }
    });
  }
  return findings.slice(0, 30);
}

function isAllowed(command: string, config: AgentBudgetConfig): boolean {
  return config.commands.allowed.some((allowed) => command === allowed || command.startsWith(`${allowed} `));
}

function inferredAllowedCommands(repoRoot: string): string[] {
  const commands = new Set<string>();
  const packageJson = path.join(repoRoot, "package.json");
  if (fs.existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        commands.add("npm test");
        commands.add("pnpm test");
        commands.add("yarn test");
      }
      if (pkg.scripts?.lint) {
        commands.add("npm run lint");
        commands.add("pnpm lint");
        commands.add("yarn lint");
      }
      if (pkg.scripts?.build) {
        commands.add("npm run build");
        commands.add("pnpm build");
        commands.add("yarn build");
      }
      if (pkg.scripts?.typecheck) {
        commands.add("npm run typecheck");
        commands.add("pnpm typecheck");
        commands.add("yarn typecheck");
      }
    } catch {
      // Ignore malformed package metadata; explicit config still applies.
    }
  }
  if (fs.existsSync(path.join(repoRoot, "gradlew")) || fs.existsSync(path.join(repoRoot, "build.gradle.kts")) || fs.existsSync(path.join(repoRoot, "build.gradle"))) {
    commands.add("./gradlew test");
    commands.add("./gradlew testDebugUnitTest");
    commands.add("./gradlew lint");
    commands.add("./gradlew detekt");
  }
  if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
    commands.add("cargo test");
    commands.add("cargo check");
    commands.add("cargo clippy");
  }
  return [...commands];
}

function isAllowedWithDiscovery(repoRoot: string, command: string, config: AgentBudgetConfig): boolean {
  const discovered = { ...config, commands: { ...config.commands, allowed: [...config.commands.allowed, ...inferredAllowedCommands(repoRoot)] } };
  return isAllowed(command, discovered);
}

export async function runSummary(repoRoot: string, kind: CommandSummary["kind"], commandParts: string[], allowUnconfigured = false, config = loadConfig(repoRoot)): Promise<CommandSummary> {
  const command = commandParts.join(" ");
  if (!allowUnconfigured && !isAllowedWithDiscovery(repoRoot, command, config)) {
    throw new Error(`Command is not allowed by agent-budget.config.json: ${command}`);
  }
  const logDir = path.join(stateDir(repoRoot), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const fullLogPath = path.join(logDir, `${nowStamp()}-${kind}.log`);
  const start = Date.now();
  let exitCode: number | null = 0;
  let signal: string | null = null;
  let raw = "";
  try {
    const result = await execa(commandParts[0], commandParts.slice(1), { cwd: repoRoot, all: true, reject: false, timeout: config.commands.timeoutMs });
    raw = result.all ?? "";
    exitCode = result.exitCode ?? null;
    signal = result.signal ?? null;
  } catch (error) {
    const err = error as { all?: string; exitCode?: number; signal?: string; message: string };
    raw = err.all ?? err.message;
    exitCode = err.exitCode ?? null;
    signal = err.signal ?? null;
  }
  const rawOutputBytes = Buffer.byteLength(raw);
  if (rawOutputBytes > config.budgets.maxRawLogBytes) raw = raw.slice(0, config.budgets.maxRawLogBytes);
  fs.writeFileSync(fullLogPath, raw);
  const redacted = redactSecrets(raw);
  const findings = parseFindings(redacted.text);
  const readable = [
    `Command: ${command}`,
    `Exit code: ${exitCode}`,
    `Duration: ${Date.now() - start}ms`,
    `Raw log: ${fullLogPath}`,
    "",
    "Findings:",
    ...findings.map((f) => {
      const detail = f.detail ? capText(f.detail, 1000).text.replace(/\n/g, "\n  ") : "";
      return `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.title}${detail ? `\n  ${detail}` : ""}`;
    })
  ].join("\n");
  const targetChars = rawOutputBytes > 0 ? Math.max(1000, Math.floor(rawOutputBytes * 0.15)) : config.budgets.maxToolOutputChars - 1;
  const capped = capText(readable, Math.min(config.budgets.maxToolOutputChars - 1, targetChars));
  return {
    kind,
    command,
    exitCode,
    signal,
    durationMs: Date.now() - start,
    rawOutputBytes,
    summaryChars: capped.text.length,
    compressionRatio: rawOutputBytes ? capped.text.length / rawOutputBytes : 1,
    fullLogPath,
    redactions: redacted.redactions,
    findings,
    truncated: capped.truncated,
    summary: capped.text
  };
}
