import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { FrontloadConfig, loadConfig } from "../config/config.js";
import { CommandSummary, Finding } from "../types.js";
import { nowStamp, stateDir } from "../utils/path.js";
import { capText, redactSecrets } from "../utils/text.js";

function pushUnique(findings: Finding[], finding: Finding): void {
  const key = `${finding.severity}:${finding.file ?? ""}:${finding.line ?? ""}:${finding.column ?? ""}:${finding.title}`;
  const exists = findings.some((existing) => `${existing.severity}:${existing.file ?? ""}:${existing.line ?? ""}:${existing.column ?? ""}:${existing.title}` === key);
  if (!exists) findings.push(finding);
}

function boundedTail(output: string, maxLines = 40, maxChars = 4000): string {
  const lines = output.trimEnd().split(/\r?\n/).filter((line) => line.trim());
  const tail = lines.slice(-maxLines).join("\n");
  return capText(tail, maxChars).text;
}

function displayCommand(command: string): string {
  return capText(command.replace(/\s+/g, " "), 300).text;
}

function parseTypeScriptFindings(output: string, findings: Finding[]): void {
  const ts1 = /(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)/g;
  const ts2 = /(.+?):(\d+):(\d+) - error (TS\d+): (.+)/g;
  for (const re of [ts1, ts2]) {
    for (const m of output.matchAll(re)) {
      pushUnique(findings, { severity: "error", file: m[1], line: Number(m[2]), column: Number(m[3]), title: `${m[4]}: ${m[5]}` });
    }
  }
}

function parseVitestFindings(output: string, findings: Finding[]): void {
  const failFile = output.match(/FAIL\s+([^\s]+)/);
  const testName = output.match(/(?:x|\u00d7|\u2715)\s+(.+?)\s+\d+ms|test\(["'](.+?)["']/);
  if (failFile || testName) {
    pushUnique(findings, {
      severity: "error",
      file: failFile?.[1],
      title: testName?.[1] ?? testName?.[2] ?? "Failing test",
      detail: [output.match(/Expected:.*|expected .* to .*/i)?.[0], output.match(/Received:.*/i)?.[0]].filter(Boolean).join("\n") || undefined,
      stack: output.match(/\s+at .+:\d+:\d+/g)?.slice(0, 8).map((s) => s.trim())
    });
  }
}

function parseGradleDetektFindings(output: string, findings: Finding[]): void {
  const detekt = /^(.+?\.(?:kt|kts|java)):(\d+):(\d+):\s*(.+?)(?:\s+\[(.+?)])?$/gm;
  for (const m of output.matchAll(detekt)) {
    pushUnique(findings, {
      severity: /warning/i.test(m[4]) ? "warning" : "error",
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      title: m[5] ? `${m[5]}: ${m[4]}` : m[4]
    });
  }

  const failedTask = output.match(/>\s*Task\s+(:[^\s]+)\s+FAILED/);
  const whatWentWrong = output.match(/\* What went wrong:\s*\n([\s\S]*?)(?:\n\* Try:|\n\* Exception is:|$)/);
  if (failedTask || whatWentWrong) {
    pushUnique(findings, {
      severity: "error",
      title: failedTask ? `Gradle task failed: ${failedTask[1]}` : "Gradle build failed",
      detail: whatWentWrong ? capText(whatWentWrong[1].trim(), 2000).text : undefined
    });
  }
}

function parseRustFindings(output: string, findings: Finding[]): void {
  const rustError = /error(?:\[(E\d+)])?:\s*(.+?)\n\s*-->\s*(.+?):(\d+):(\d+)/g;
  for (const m of output.matchAll(rustError)) {
    pushUnique(findings, {
      severity: "error",
      file: m[3],
      line: Number(m[4]),
      column: Number(m[5]),
      title: m[1] ? `${m[1]}: ${m[2]}` : m[2]
    });
  }

  const panic = /thread '(.+?)' panicked at (.+?),\s*(.+?):(\d+):(\d+)/g;
  for (const m of output.matchAll(panic)) {
    pushUnique(findings, {
      severity: "error",
      file: m[3],
      line: Number(m[4]),
      column: Number(m[5]),
      title: `Rust panic in ${m[1]}: ${m[2]}`
    });
  }
}

function parseGenericFindings(output: string, findings: Finding[]): void {
  const lines = output.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/error|failed|FAIL|AssertionError|Expected|Received/i.test(line)) {
      pushUnique(findings, { severity: /warn/i.test(line) ? "warning" : "error", title: line.trim(), detail: lines.slice(Math.max(0, i - 2), i + 3).join("\n") });
    }
  });
}

function parseFindings(output: string, exitCode: number | null): Finding[] {
  const findings: Finding[] = [];
  parseTypeScriptFindings(output, findings);
  parseVitestFindings(output, findings);
  parseGradleDetektFindings(output, findings);
  parseRustFindings(output, findings);
  if (!findings.length) {
    parseGenericFindings(output, findings);
  }
  if (!findings.length && exitCode !== 0 && output.trim()) {
    findings.push({
      severity: "error",
      title: "Unrecognized failing output; showing bounded tail",
      detail: boundedTail(output)
    });
  }
  return findings.slice(0, 30);
}

function isAllowed(command: string, config: FrontloadConfig): boolean {
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

function isAllowedWithDiscovery(repoRoot: string, command: string, config: FrontloadConfig): boolean {
  const discovered = { ...config, commands: { ...config.commands, allowed: [...config.commands.allowed, ...inferredAllowedCommands(repoRoot)] } };
  return isAllowed(command, discovered);
}

export async function runSummary(repoRoot: string, kind: CommandSummary["kind"], commandParts: string[], allowUnconfigured = false, config = loadConfig(repoRoot)): Promise<CommandSummary> {
  const command = commandParts.join(" ");
  if (!allowUnconfigured && !isAllowedWithDiscovery(repoRoot, command, config)) {
    throw new Error(`Command is not allowed by frontload.config.json: ${command}`);
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
  const findings = parseFindings(redacted.text, exitCode);
  const readable = [
    `Command: ${displayCommand(command)}`,
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
