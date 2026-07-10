import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { appendEvent, budgetReport, readEvents } from "../../src/budget/events.js";
import { searchResultsOutput } from "../../src/budget/output-bounds.js";
import { compactRankedResults, searchIndexMeasured } from "../../src/dossier/dossier.js";
import { createMcpHandlers } from "../../src/mcp/server.js";

const fixture = path.resolve("fixtures/react-ts-app");

function sanitizeProofSummary(summary: string, extraPaths: string[] = []): string {
  let sanitized = summary.split(fixture).join("<fixture-repo>").split(os.homedir()).join("<home>");
  for (const [index, extraPath] of extraPaths.entries()) sanitized = sanitized.split(extraPath).join(`<temp-repo-${index + 1}>`);
  return sanitized;
}

function makeEventPersistenceFail(repo: string): void {
  fs.mkdirSync(path.join(repo, ".frontload"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".frontload/events.jsonl"));
}

function writeShellScript(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

async function execaWithPty(command: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<void> {
  const runner = String.raw`
import base64, os, pty, select, signal, sys, time

input_bytes = base64.b64decode(sys.argv[1])
prompt = sys.argv[2].encode()
cmd = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(cmd[0], cmd, os.environ)

sent = False
buffer = b""
deadline = time.time() + 10
status = 1
while True:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        if chunk:
            buffer += chunk
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    if not sent and prompt in buffer:
        os.write(fd, input_bytes)
        sent = True
    finished, status = os.waitpid(pid, os.WNOHANG)
    if finished:
        break
    if time.time() > deadline:
        os.kill(pid, signal.SIGTERM)
        finished, status = os.waitpid(pid, 0)
        break

if os.WIFEXITED(status):
    sys.exit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(1)
`;
  await execa("python3", [
    "-c",
    runner,
    Buffer.from(input, "utf8").toString("base64"),
    "Choose Claude Code and opencode MCP config scope.",
    command,
    ...args
  ], { env, timeout: 15000 });
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const dogfoodFingerprintFiles = [
  "package.json",
  "dist/src/cli/index.js",
  "dist/src/install/install.js",
  "dist/src/mcp/server.js",
  "plugins/codex/skills/frontload/SKILL.md",
  "plugins/codex/hooks/hooks.json",
  "frontload.config.example.json"
];

function writeDogfoodPackageFiles(targetRoot: string, version: string, sourceRoot = path.resolve(".")): void {
  for (const file of dogfoodFingerprintFiles) {
    const source = path.join(sourceRoot, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const packageFile = path.join(targetRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  fs.writeFileSync(packageFile, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
}

function writeInstalledFrontloadPackage(binParent: string, version: string, sourceRoot = path.resolve(".")): string {
  const packageRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-installed-package-"));
  writeDogfoodPackageFiles(packageRoot, version, sourceRoot);
  const executable = path.join(packageRoot, "bin/frontload");
  writeShellScript(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(sourceRoot, "dist/src/cli/index.js"))} "$@"\n`);
  fs.mkdirSync(binParent, { recursive: true });
  fs.symlinkSync(executable, path.join(binParent, "frontload"));
  return packageRoot;
}

function writeNoisySearchRepo(): string {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-lean-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  for (let fileIndex = 0; fileIndex < 12; fileIndex++) {
    const lines = Array.from({ length: 40 }, (_, symbolIndex) =>
      `export function targetReconnectSignal${fileIndex}_${symbolIndex}() { return "${fileIndex}-${symbolIndex}"; }`
    );
    fs.writeFileSync(path.join(repo, `src/target-${fileIndex}.ts`), `${lines.join("\n")}\n`);
  }
  return repo;
}

describe("e2e proof workflow", () => {
  it("writes generated proof files under repo state", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-proof-output-"));
    fs.mkdirSync(path.join(repo, ".frontload/logs"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".frontload/logs/2026-07-04T14-48-39-741Z-test.log"), [
      "FAIL src/chart/ChartTooltip.test.tsx",
      "updates stale chart tooltip value after sensor reconnect",
      "expected '92 mg/dL' to be '93 mg/dL'",
      ""
    ].join("\n"));

    await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "proof", "--repo", repo]);

    const proofDir = path.join(repo, ".frontload/proof");
    expect(fs.existsSync(path.join(proofDir, "TEST_REPORT.md"))).toBe(true);
    expect(fs.existsSync(path.join(proofDir, "raw-vs-summary.json"))).toBe(true);
    expect(fs.existsSync(path.join(proofDir, "mcp-transcript.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "proof/TEST_REPORT.md"))).toBe(false);

    const rawVsSummary = JSON.parse(fs.readFileSync(path.join(proofDir, "raw-vs-summary.json"), "utf8"));
    expect(rawVsSummary.rawOutputBytes).toBeGreaterThan(0);
    expect(rawVsSummary.preservedFindings).toEqual(expect.arrayContaining([
      "updates stale chart tooltip value after sensor reconnect",
      "src/chart/ChartTooltip.test.tsx",
      "expected '92 mg/dL' to be '93 mg/dL'"
    ]));
    expect(rawVsSummary.fullLog).toMatch(/^<repo>\/\.frontload\/logs\/.*test\.log$/);
  });

  it("keeps proof-generated state ignored in git status", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-proof-ignore-"));
    await execa("git", ["init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "init"], {
      cwd: repo,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });

    await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "proof", "--repo", repo]);
    const status = await execa("git", ["status", "--short"], { cwd: repo });

    expect(status.stdout).toBe("");
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain(".frontload/");
  });

  it("writes demo fixture dossier under ignored repo state", async () => {
    const fixtureDossier = path.join(fixture, ".frontload/proof/sample-dossier.md");
    fs.rmSync(fixtureDossier, { force: true });

    await execa("pnpm", ["demo:fixture"]);

    expect(fs.existsSync(fixtureDossier)).toBe(true);
    expect(fs.readFileSync(fixtureDossier, "utf8")).toContain("# Frontload Dossier");
    expect(fs.existsSync("proof/sample-dossier.md")).toBe(false);
  });

  it("runs host-aware hook subcommands through the built CLI", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-cli-"));
    fs.mkdirSync(path.join(repo, ".frontload"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 200 }
    }));
    const cli = path.resolve("dist/src/cli/index.js");
    const pre = await execa(
      process.execPath,
      [cli, "hook", "pre-tool-use", "--host", "codex"],
      {
        input: JSON.stringify({
          cwd: repo,
          tool_name: "Bash",
          tool_input: { command: "pnpm test" }
        })
      }
    );
    const post = await execa(
      process.execPath,
      [cli, "hook", "post-tool-use", "--host", "codex"],
      {
        input: JSON.stringify({
          cwd: repo,
          tool_name: "Bash",
          tool_response: "x".repeat(1000)
        })
      }
    );

    expect(JSON.parse(pre.stdout).hookSpecificOutput.updatedInput.command).toContain("--kind test");
    expect(JSON.parse(post.stdout)).toMatchObject({ decision: "block" });
  });

  it("rejects missing and invalid hook hosts at the CLI boundary", async () => {
    const cli = path.resolve("dist/src/cli/index.js");
    const missing = await execa(process.execPath, [cli, "hook", "pre-tool-use"], { reject: false });
    const invalid = await execa(process.execPath, [cli, "hook", "pre-tool-use", "--host", "cursor"], { reject: false });

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("required option '--host <host>' not specified");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("Unknown hook host: cursor");
  });

  it("still returns a successful MCP response when event persistence fails", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-fail-open-"));
    makeEventPersistenceFail(repo);

    const response = await createMcpHandlers(repo).policy({});
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      summary: "Current Frontload policy."
    });
  });

  it("exits the stdio MCP process after the client closes", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-exit-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), "{}");
    const cli = path.resolve("dist/src/cli/index.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--repo", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "frontload-e2e", version: "1.0.0" });

    await client.connect(transport);
    const response = await client.callTool({ name: "fl_policy", arguments: {} });
    const pid = transport.pid;
    await client.close();
    const content = response.content as Array<{ type: "text"; text: string }>;

    expect(JSON.parse(content[0].text)).toMatchObject({
      summary: "Current Frontload policy."
    });
    expect(pid).toEqual(expect.any(Number));
    expect(await waitForProcessExit(pid!, 2000)).toBe(true);
  });

  it("withholds oversized MCP responses before returning them", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-output-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 64
      }
    }));

    const response = await createMcpHandlers(repo).policy({});
    const text = response.content[0].text;
    const data = JSON.parse(text);
    const event = readEvents(repo).at(-1);

    expect(text.length).toBeLessThanOrEqual(64);
    expect(data).toMatchObject({
      truncated: true,
      summary: expect.any(String)
    });
    expect(event).toMatchObject({
      source: "mcp",
      operation: "policy",
      success: true,
      outputBytes: Buffer.byteLength(text)
    });
  });

  it("withholds oversized MCP budget reports without logging the report itself", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-budget-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 120
      }
    }));
    await createMcpHandlers(repo).policy({});

    const response = await createMcpHandlers(repo).budget({});
    const text = response.content[0].text;
    const data = JSON.parse(text);
    const events = readEvents(repo);

    expect(text.length).toBeLessThanOrEqual(120);
    expect(data).toMatchObject({
      summary: expect.any(String),
      truncated: true
    });
    expect(events.map((event) => event.operation)).toEqual(["policy"]);
  });

  it("preserves failing run state and baseline accounting when withholding oversized MCP responses", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-run-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 600
      },
      commands: {
        allowed: ["./fail-loudly.sh"]
      }
    }));
    const scriptPath = path.join(repo, "fail-loudly.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nprintf 'FAIL src/sample.test.ts\\n'; printf 'x%.0s' $(seq 1 5000); exit 1\n");
    fs.chmodSync(scriptPath, 0o755);

    const response = await createMcpHandlers(repo).run({ kind: "test", command: "./fail-loudly.sh" });
    const text = response.content[0].text;
    const data = JSON.parse(text);
    const event = readEvents(repo).at(-1);

    expect(text.length).toBeLessThanOrEqual(600);
    expect(data).toMatchObject({
      summary: expect.any(String),
      truncated: true,
      operation: "run",
      exitCode: 1,
      fullLogPath: expect.stringContaining(".frontload/logs/")
    });
    expect(data.findings.length).toBeGreaterThan(0);
    expect(event).toMatchObject({
      operation: "run",
      baselineKind: "raw-command-output",
      outputBytes: Buffer.byteLength(text)
    });
    expect(event?.baselineBytes).toBeGreaterThan(5000);
  });

  it("preserves quoted MCP run command arguments", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-run-quotes-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      commands: {
        allowed: ["node print-args.mjs"]
      }
    }));
    fs.writeFileSync(path.join(repo, "print-args.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n");

    const response = await createMcpHandlers(repo).run({
      kind: "generic",
      command: "node print-args.mjs alpha \"two words\" 'three words'"
    });
    const data = JSON.parse(response.content[0].text);

    expect(data.exitCode).toBe(0);
    expect(data.summary).toContain("[\"alpha\",\"two words\",\"three words\"]");
  });

  it("returns usable default dossier output under the default MCP cap", async () => {
    const repo = writeNoisySearchRepo();
    const response = await createMcpHandlers(repo).dossier({
      task: "target reconnect signal",
      budgetChars: 12000,
      maxFiles: 12
    });
    const text = response.content[0].text;
    const data = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(8000);
    expect(data.summary).toBe("Dossier generated.");
    expect(data.markdown).toContain("Frontload Dossier");
    expect(data.markdown).toContain("Requested budget: 12000 chars");
    expect(data.markdown).toContain("src/target-");
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.ranked).toBeUndefined();
    expect(data.summary).not.toContain("withheld");
  });

  it("returns trimmed search results instead of withholding near-budget responses", async () => {
    const repo = writeNoisySearchRepo();
    const response = await createMcpHandlers(repo).search({ query: "target reconnect signal", limit: 10 });
    const text = response.content[0].text;
    const data = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(8000);
    expect(data.summary).toBe("Search results from index.");
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].file.path).toContain("src/target-");
    expect(data.results[0].file.imports).toBeUndefined();
    expect(data.summary).not.toContain("withheld");
  });

  it("returns usable default budgeted read output instead of withholding duplicate excerpts", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-readable-read-"));
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const lines = Array.from({ length: 120 }, (_, i) => {
      const marker = i === 60 ? " targetNeedle" : "";
      return `export const paddedLine${String(i + 1).padStart(3, "0")} = "${"x".repeat(70)}";${marker}`;
    });
    fs.writeFileSync(path.join(repo, "src/large.ts"), `${lines.join("\n")}\n`);

    const response = await createMcpHandlers(repo).read({
      path: "src/large.ts",
      budgetChars: 4000,
      query: "targetNeedle"
    });
    const text = response.content[0].text;
    const data = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(8000);
    expect(data.summary).toContain("Returned contiguous lines");
    expect(data.summary).not.toContain("withheld");
    expect(data.excerpt).toContain("targetNeedle");
    expect(data.numberedExcerpt).toBeUndefined();
  });

  it("fits budgeted reads under configured MCP output caps", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-read-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 2400
      }
    }));
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const lines = Array.from({ length: 90 }, (_, i) => {
      const marker = i === 60 ? " targetNeedle" : "";
      return `export const paddedLine${String(i + 1).padStart(3, "0")} = "${"x".repeat(130)}";${marker}`;
    });
    fs.writeFileSync(path.join(repo, "src/large.ts"), `${lines.join("\n")}\n`);

    const response = await createMcpHandlers(repo).read({
      path: "src/large.ts",
      budgetChars: 3500,
      query: "targetNeedle"
    });
    const text = response.content[0].text;
    const data = JSON.parse(text);

    expect(text.length).toBeLessThanOrEqual(2400);
    expect(data.summary).not.toContain("withheld");
    expect(data.excerpt).toContain("targetNeedle");
  });

  it("does not mark empty MCP search results as truncated", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-empty-search-"));
    fs.writeFileSync(path.join(repo, "sample.ts"), "export const presentNeedle = 1;\n");

    const response = await createMcpHandlers(repo).search({ query: "absentMarker", limit: 10 });
    const data = JSON.parse(response.content[0].text);

    expect(data).toMatchObject({
      summary: "Search results from index.",
      results: []
    });
    expect(data.truncated).toBeUndefined();
    expect(data.omittedResults).toBeUndefined();
  });

  it("does not trim empty-result dossiers that already fit", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-empty-dossier-"));
    fs.writeFileSync(path.join(repo, "sample.ts"), "export const presentNeedle = 1;\n");

    const response = await createMcpHandlers(repo).dossier({
      task: "fix app",
      budgetChars: 6000,
      maxFiles: 12
    });
    const data = JSON.parse(response.content[0].text);

    expect(data.summary).toBe("Dossier generated.");
    expect(data.markdown).toContain("No strong lexical matches found");
    expect(data.files).toEqual([]);
    expect(data.truncated).toBe(false);
    expect(data.omittedFiles).toBeUndefined();
  });

  it("marks omitted dossier file details as truncation without claiming markdown files were omitted", async () => {
    const repo = writeNoisySearchRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 7000
      }
    }));

    const response = await createMcpHandlers(repo).dossier({
      task: "target reconnect signal",
      budgetChars: 12000,
      maxFiles: 12
    });
    const data = JSON.parse(response.content[0].text);

    expect(response.content[0].text.length).toBeLessThanOrEqual(7000);
    expect(data.truncated).toBe(true);
    expect(data.omittedFileDetails).toBeGreaterThan(0);
    expect(data.omittedFiles).toBeUndefined();
    expect(data.markdown).toContain("src/target-");
  });

  it("uses repo dossier budget defaults in the CLI unless explicitly overridden", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-dossier-budget-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        defaultDossierChars: 1234
      }
    }));
    fs.writeFileSync(path.join(repo, "target.ts"), "export const targetNeedle = 1;\n");
    const cli = path.resolve("dist/src/cli/index.js");

    const configured = await execa(process.execPath, [cli, "dossier", "target needle", "--repo", repo]);
    const explicit = await execa(process.execPath, [cli, "dossier", "target needle", "--repo", repo, "--budget", "4321"]);

    expect(configured.stdout).toContain("Requested budget: 1234 chars");
    expect(explicit.stdout).toContain("Requested budget: 4321 chars");
  });

  it("limits CLI dossier files when max-files is provided", async () => {
    const repo = writeNoisySearchRepo();
    const cli = path.resolve("dist/src/cli/index.js");

    const result = await execa(process.execPath, [
      cli,
      "dossier",
      "target reconnect signal",
      "--repo",
      repo,
      "--budget",
      "12000",
      "--max-files",
      "1"
    ]);
    const mostRelevant = result.stdout.split("## Suggested read order")[0] ?? result.stdout;
    const fileEntries = mostRelevant.match(/\n\d+\. `src\/target-/g) ?? [];

    expect(fileEntries).toHaveLength(1);
  });

  it("keeps CLI search output under the configured tool output cap", async () => {
    const repo = writeNoisySearchRepo();
    const query = "target reconnect signal";
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 1600
      }
    }));
    const cli = path.resolve("dist/src/cli/index.js");

    await execa(process.execPath, [cli, "index", "--repo", repo]);
    const expectedBaseline = Buffer.byteLength(`${JSON.stringify({
      summary: "Search results from index.",
      results: compactRankedResults((await searchIndexMeasured(repo, query, 12)).unboundedResults)
    }, null, 2)}\n`);
    const result = await execa(process.execPath, [cli, "search", query, "--repo", repo, "--limit", "12"]);
    const data = JSON.parse(result.stdout);
    const event = readEvents(repo).at(-1);

    expect(result.stdout.length).toBeLessThanOrEqual(1600);
    expect(data).toMatchObject({ summary: "Search results from index." });
    expect(data.truncated).toBe(true);
    expect(event).toMatchObject({
      source: "cli",
      operation: "search",
      baselineBytes: expectedBaseline
    });
  });

  it("keeps CLI search output under the minimum configured tool output cap", async () => {
    const repo = writeNoisySearchRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 64
      }
    }));
    const cli = path.resolve("dist/src/cli/index.js");

    await execa(process.execPath, [cli, "index", "--repo", repo]);
    const result = await execa(process.execPath, [cli, "search", "target reconnect signal", "--repo", repo, "--limit", "12"]);
    const data = JSON.parse(result.stdout);

    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(data).toMatchObject({ truncated: true });
  });

  it("keeps CLI read output under the configured tool output cap", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-read-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 1600
      }
    }));
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const lines = Array.from({ length: 90 }, (_, i) => {
      const marker = i === 45 ? " targetNeedle" : "";
      return `export const paddedLine${String(i + 1).padStart(3, "0")} = "${"x".repeat(130)}";${marker}`;
    });
    fs.writeFileSync(path.join(repo, "src/large.ts"), `${lines.join("\n")}\n`);
    const cli = path.resolve("dist/src/cli/index.js");

    const result = await execa(process.execPath, [cli, "read", "src/large.ts", "--repo", repo, "--budget", "3500", "--query", "targetNeedle"]);
    const data = JSON.parse(result.stdout);

    expect(result.stdout.length).toBeLessThanOrEqual(1600);
    expect(data.excerpt).toContain("targetNeedle");
  });

  it("keeps CLI read output under the cap for a single oversized line", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-read-single-line-cap-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 64
      }
    }));
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src/large.ts"), `export const value = "${"x".repeat(2000)} targetNeedle";\n`);
    const cli = path.resolve("dist/src/cli/index.js");

    const result = await execa(process.execPath, [cli, "read", "src/large.ts", "--repo", repo, "--budget", "3500", "--query", "targetNeedle"]);
    const data = JSON.parse(result.stdout);

    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(data).toMatchObject({ truncated: true });
  });

  it("reports project Codex MCP health and legacy global conflicts in doctor", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-codex-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-home-"));
    const cli = path.resolve("dist/src/cli/index.js");
    fs.writeFileSync(path.join(repo, "frontload.config.json"), "{}");
    fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".codex/config.toml"), [
      "[mcp_servers.frontload_doctor_codex_12345678]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([cli, "mcp", "--repo", repo])}`,
      "enabled = true",
      ""
    ].join("\n"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/config.toml"), [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      `args = ${JSON.stringify(["mcp", "--repo", path.join(repo, "..", "other-repo")])}`,
      ""
    ].join("\n"));

    const result = await execa(process.execPath, [cli, "doctor", "--repo", repo, "--home", home]);
    const data = JSON.parse(result.stdout);

    expect(data.checks.codex).toMatchObject({
      configured: true,
      serverName: "frontload_doctor_codex_12345678",
      configScope: "project",
      repoMatches: true,
      launches: true,
      responds: true,
      legacyGlobalConflict: true
    });
    expect(data.checks.codex.restartAdvice).toContain("Transport closed");
  });

  it("does not execute unmanaged Codex MCP commands during doctor", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-unmanaged-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-unmanaged-home-"));
    const marker = path.join(repo, "executed.txt");
    const unmanaged = path.join(repo, "not-frontload.sh");
    fs.writeFileSync(path.join(repo, "frontload.config.json"), "{}");
    writeShellScript(unmanaged, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 0\n`);
    fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".codex/config.toml"), [
      "[mcp_servers.frontload]",
      `command = ${JSON.stringify(unmanaged)}`,
      `args = ${JSON.stringify(["mcp", "--repo", repo])}`,
      "enabled = true",
      ""
    ].join("\n"));

    const result = await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "doctor", "--repo", repo, "--home", home]);
    const data = JSON.parse(result.stdout);

    expect(fs.existsSync(marker)).toBe(false);
    expect(data.checks.codex).toMatchObject({
      configured: true,
      usesInstalledCommand: false,
      startsMcp: true,
      repoMatches: true,
      launches: false,
      responds: false
    });
  });

  it("treats a successful bounded policy probe as responsive without recording budget events", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-low-cap-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-low-cap-home-"));
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-low-cap-bin-"));
    const cli = path.resolve("dist/src/cli/index.js");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    writeInstalledFrontloadPackage(bin, pkg.version);
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: {
        maxToolOutputChars: 64
      }
    }));
    fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".codex/config.toml"), [
      "[mcp_servers.frontload]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([cli, "mcp", "--repo", repo])}`,
      "enabled = true",
      ""
    ].join("\n"));

    const result = await execa(process.execPath, [cli, "doctor", "--repo", repo, "--home", home], {
      env: {
        ...process.env,
        PATH: bin
      }
    });
    const data = JSON.parse(result.stdout);

    expect(data.checks.codex).toMatchObject({
      configured: true,
      launches: true,
      responds: true
    });
    expect(data.checks.installedCommand).toMatchObject({
      command: "frontload",
      available: true,
      version: pkg.version,
      matchesCurrentVersion: true,
      regularInstall: true
    });
    expect(data.checks.dogfood).toBeUndefined();
    expect(readEvents(repo).filter((event) => event.operation === "policy")).toEqual([]);
  });

  it("advertises expected Frontload MCP tools over stdio", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-tools-"));
    const cli = path.resolve("dist/src/cli/index.js");
    fs.writeFileSync(path.join(repo, "frontload.config.json"), "{}");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--repo", repo],
      stderr: "pipe"
    });
    const client = new Client({ name: "frontload-test", version: "0.0.0" });

    try {
      await client.connect(transport, { timeout: 5000, maxTotalTimeout: 5000 });
      const listed = await client.listTools(undefined, { timeout: 5000, maxTotalTimeout: 5000 });
      const names = listed.tools.map((tool) => tool.name).sort();

      expect(names).toEqual(expect.arrayContaining([
        "fl_budget_report",
        "fl_git_diff_summary",
        "fl_read_budgeted",
        "fl_repo_dossier",
        "fl_run_summary",
        "fl_search"
      ]));
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("creates project-local Codex MCP config from the built init command", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-codex-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-home-"));
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-bin-"));
    writeShellScript(path.join(bin, "frontload"), "#!/bin/sh\nexit 0\n");
    const cli = path.resolve("dist/src/cli/index.js");

    await execa(process.execPath, [cli, "init", "--repo", repo, "--agents", "codex", "--home", home], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }
    });

    const config = fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8");
    expect(config).toMatch(/^\[mcp_servers\.frontload_[^\]]+\]$/m);
    expect(config).toContain(`args = ["mcp", "--repo", "${repo}"]`);
    expect(fs.existsSync(path.join(home, ".codex/config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);
  });

  const ttyIt = process.platform === "win32" ? it.skip : it;

  ttyIt("uses the interactive Claude scope radio selection when initializing global config", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-claude-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-home-"));
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-init-bin-"));
    writeShellScript(path.join(bin, "frontload"), "#!/bin/sh\nexit 0\n");
    const cli = path.resolve("dist/src/cli/index.js");

    await execaWithPty(process.execPath, [
      cli,
      "init",
      "--repo",
      repo,
      "--agents",
      "claude",
      "--home",
      home
    ], "\x1b[B\r", { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` });

    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".claude/settings.json"))).toBe(false);
  });

  it("keeps the original MCP error when event persistence also fails", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-error-mask-"));
    makeEventPersistenceFail(repo);

    await expect(createMcpHandlers(repo).read({
      path: "missing.ts",
      budgetChars: 100
    })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records the exact run baseline bytes from combined stdout and stderr", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-run-bytes-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      commands: {
        allowed: ["./print-lines.sh"]
      }
    }));
    const scriptPath = path.join(repo, "print-lines.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nprintf 'stdout line\\n'; printf 'stderr line\\n' >&2\n");
    fs.chmodSync(scriptPath, 0o755);

    const response = await createMcpHandlers(repo).run({ kind: "generic", command: "./print-lines.sh" });
    const data = JSON.parse(response.content[0].text) as { rawOutputBytes: number };
    const event = readEvents(repo).at(-1);
    const actual = await execa(scriptPath, [], { cwd: repo, all: true, stripFinalNewline: false });

    expect(Buffer.byteLength(actual.all ?? "")).toBe(data.rawOutputBytes);
    expect(event).toMatchObject({
      baselineBytes: data.rawOutputBytes,
      baselineKind: "raw-command-output"
    });
  });

  it("preserves nested command passthrough flags after the run separator", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-run-passthrough-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      commands: {
        allowed: ["node argv.js"]
      }
    }));
    fs.writeFileSync(path.join(repo, "argv.js"), "console.log(JSON.stringify(process.argv.slice(2)))\n");

    const result = await execa(process.execPath, [
      path.resolve("dist/src/cli/index.js"),
      "run",
      "--repo",
      repo,
      "--kind",
      "test",
      "--",
      "node",
      "argv.js",
      "--",
      "--runInBand"
    ]);
    const data = JSON.parse(result.stdout);

    expect(data.command).toBe("node argv.js -- --runInBand");
    expect(data.exitCode).toBe(0);
    expect(data.summary).toContain('["--","--runInBand"]');
  });

  it("reports invalid read line options as CLI validation errors", async () => {
    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "read", "src/chart/ChartTooltip.tsx", "--repo", fixture, "--start-line", "nope"],
      { reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Expected a positive integer");
    expect(result.stderr).not.toContain("TypeError");
  });

  it("does not refresh agent config when non-interactive upgrade lacks approval", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-manual-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-home-manual-"));
    const codexConfig = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      "args = [\"mcp\"]",
      ""
    ].join("\n"));

    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "upgrade", "--repo", repo, "--home", home],
      { reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Frontload upgrade needs one more step");
    expect(result.stdout).toContain("Frontload was not upgraded globally");
    expect(result.stdout).toMatch(/\[manual\] (npm install -g|pnpm add -g|yarn global add|bun add -g) frontload@latest/);
    expect(result.stdout).not.toContain("\"globalInstall\"");
    expect(fs.readFileSync(codexConfig, "utf8")).toContain("old-frontload");
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(false);
  });

  it("prints human-friendly init output instead of raw JSON", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-cli-output-"));
    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "init", "--agents", "none", "--repo", repo]
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Frontload init complete");
    expect(result.stdout).toContain("| Project files |");
    expect(result.stdout).toContain("[created] frontload.config.json");
    expect(result.stdout).toContain("Agent setup was not changed.");
    expect(result.stdout).not.toContain("\"repoRoot\"");
  });

  it("delegates upgrade refresh to the installed frontload binary", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-reexec-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-home-reexec-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-bin-"));
    const marker = path.join(repo, "refresh-args.txt");
    writeShellScript(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n");
    writeShellScript(path.join(bin, "frontload"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`);
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/config.toml"), [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      "args = [\"mcp\"]",
      ""
    ].join("\n"));

    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "upgrade", "--yes", "--repo", repo, "--home", home],
      {
        env: {
          ...process.env,
          npm_config_user_agent: "npm/10.0.0 node/v26.0.0",
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
        }
      }
    );

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean)).toEqual([
      "upgrade",
      "--refresh-only",
      "--repo",
      repo,
      "--home",
      home,
      "--global-install-action",
      "updated",
      "--global-install-command",
      "npm install -g frontload@latest"
    ]);
  });

  it("refreshes existing agent config through the CLI refresh-only path", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-refresh-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-cli-home-refresh-"));
    const codexConfig = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      "args = [\"mcp\"]",
      ""
    ].join("\n"));

    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "upgrade", "--refresh-only", "--repo", repo, "--home", home]
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Frontload upgrade complete");
    expect(result.stdout).toContain("Frontload and existing agent configuration were updated.");
    expect(result.stdout).toContain("| Codex setup |");
    expect(result.stdout).not.toContain("\"agents\"");
    expect(result.stdout).not.toContain("\"repoRoot\"");
    expect(fs.readFileSync(codexConfig, "utf8")).toContain('command = "frontload"');
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(false);
  });

  it("calls required tool handlers and stores transcript", async () => {
    const transcriptPath = path.join(fixture, ".frontload/proof/mcp-transcript.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "");
    fs.rmSync(path.join(fixture, ".frontload/events.jsonl"), { force: true });
    const handlers = createMcpHandlers(fixture);
    const runRepo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-proof-run-"));
    fs.writeFileSync(path.join(runRepo, "frontload.config.json"), JSON.stringify({ commands: { allowed: ["node fail.js"] } }));
    fs.writeFileSync(path.join(runRepo, "fail.js"), [
      "console.error('FAIL src/chart/ChartTooltip.test.tsx');",
      "console.error('x updates stale chart tooltip value after sensor reconnect');",
      "process.exit(1);",
      ""
    ].join("\n"));
    const runHandlers = createMcpHandlers(runRepo);
    const calls = [
      ["fl_policy", await handlers.policy({})],
      ["fl_repo_index", await handlers.index({ force: true })],
      ["fl_repo_dossier", await handlers.dossier({ task: "Fix stale chart tooltip value after sensor reconnect", budgetChars: 12000, maxFiles: 12 })],
      ["fl_search", await handlers.search({ query: ".", limit: 2 })],
      ["fl_read_budgeted", await handlers.read({ path: "src/chart/ChartTooltip.tsx", budgetChars: 4000, query: "tooltip reconnect" })],
      ["fl_run_summary", await runHandlers.run({ kind: "test", command: "node fail.js" })],
      ["fl_git_diff_summary", await handlers.diff({ staged: false })],
      ["fl_budget_report", await handlers.budget({})]
    ] as const;
    for (const [tool, response] of calls) {
      const text = response.content[0].text;
      const data = JSON.parse(text);
      const summary = sanitizeProofSummary(data.summary ?? "ok", [runRepo]);
      fs.appendFileSync(transcriptPath, JSON.stringify({ tool, response: { summary } }) + "\n");
    }
    const index = JSON.parse(calls.find(([tool]) => tool === "fl_repo_index")![1].content[0].text);
    const dossier = JSON.parse(calls.find(([tool]) => tool === "fl_repo_dossier")![1].content[0].text);
    const read = JSON.parse(calls.find(([tool]) => tool === "fl_read_budgeted")![1].content[0].text);
    expect(index.index).toBeUndefined();
    expect(index.indexPath).toBe(path.join(fixture, ".frontload/index.json"));
    expect(index.stats.fileCount).toBeGreaterThan(4);
    expect(dossier.markdown).toContain("ChartTooltip.tsx");
    expect(read.excerpt).not.toContain("1 |");
    expect(read.numberedExcerpt).toContain("|");
    expect(read.editSafe).toBe(true);

    const events = readEvents(fixture);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mcp", operation: "read", baselineKind: "full-file" }),
      expect.objectContaining({ source: "mcp", operation: "search", baselineKind: "unbounded-search-results" })
    ]));
    expect(readEvents(runRepo)).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "mcp", operation: "run", baselineKind: "raw-command-output" })
    ]));
    expect(events.find((event) => event.operation === "dossier")?.baselineBytes).toBeUndefined();
    const operations: Record<string, string> = {
      fl_policy: "policy",
      fl_repo_index: "index",
      fl_repo_dossier: "dossier",
      fl_search: "search",
      fl_read_budgeted: "read",
      fl_run_summary: "run",
      fl_git_diff_summary: "diff"
    };
    const runEvents = readEvents(runRepo);
    for (const [tool, response] of calls.filter(([name]) => name !== "fl_budget_report")) {
      const eventLog = tool === "fl_run_summary" ? runEvents : events;
      const event = eventLog.find((candidate) => candidate.operation === operations[tool]);
      expect(event?.outputBytes).toBe(Buffer.byteLength(response.content[0].text));
    }
    expect(fs.existsSync(transcriptPath)).toBe(true);
  });

  it("serves registered MCP tools over stdio", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/src/cli/index.js"), "mcp", "--repo", repo],
      cwd: path.resolve("."),
      stderr: "pipe"
    });
    const client = new Client({ name: "frontload-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);
      const response = await client.callTool({ name: "fl_policy", arguments: {} });
      const content = response.content as Array<{ type: string; text?: string }>;
      const text = content.find((item) => item.type === "text")?.text;

      expect(JSON.parse(text ?? "{}")).toMatchObject({
        summary: "Current Frontload policy."
      });
      expect(readEvents(repo).at(-1)).toMatchObject({
        source: "mcp",
        operation: "policy"
      });
    } finally {
      await client.close();
    }
  });

  it("exits the MCP server when stdio closes", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-stdin-close-"));
    const child = execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "mcp", "--repo", repo], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      timeout: 5000
    });

    child.stdin?.end();
    const result = await child;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("doctor verifies the regular installed Codex dogfood path", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-dogfood-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-home-"));
    const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-bin-"));
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const codexConfig = path.join(home, ".codex/config.toml");
    writeDogfoodPackageFiles(repo, pkg.version);
    writeInstalledFrontloadPackage(bin, pkg.version);
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      `args = ["mcp", "--repo", "${repo}"]`,
      "enabled = true",
      ""
    ].join("\n"));

    const result = await execa(
      process.execPath,
      [path.resolve("dist/src/cli/index.js"), "doctor", "--repo", repo, "--home", home, "--dogfood"],
      {
        env: {
          ...process.env,
          PATH: bin
        }
      }
    );
    const data = JSON.parse(result.stdout);

    expect(data.checks.dogfood.ok).toBe(true);
    expect(data.checks.dogfood.installedCommand).toMatchObject({
      available: true,
      version: pkg.version,
      matchesCurrentVersion: true,
      matchesTargetPackage: true,
      regularInstall: true
    });
    expect(data.checks.dogfood.codex).toMatchObject({
      configured: true,
      command: "frontload",
      args: ["mcp", "--repo", repo],
      usesInstalledCommand: true,
      startsMcp: true,
      enabledForUse: true,
      repoIsAbsolute: true,
      repoMatches: true
    });
  });

  it("keeps plain doctor independent from dogfood validation", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-plain-"));
    await execa("git", ["init"], { cwd: repo });
    const result = await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "doctor", "--repo", repo]);
    const data = JSON.parse(result.stdout);

    expect(data.summary).toBe("doctor completed");
    expect(data.checks.stateExclude).toMatchObject({
      ignored: true,
      repaired: true,
      beforeIgnored: false,
      mechanism: ".git/info/exclude",
      pattern: ".frontload/"
    });
    expect(data.checks.dogfood).toBeUndefined();
  });

  it("passes tracked-only through the CLI diff command", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-diff-tracked-only-"));
    await execa("git", ["init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "existing.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "init"], {
      cwd: repo,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    fs.appendFileSync(path.join(repo, "existing.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(repo, "new.ts"), "export const ignored = true;\n");

    const result = await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "diff", "--repo", repo, "--tracked-only"]);
    const data = JSON.parse(result.stdout);

    expect(data.changedFiles.map((file: { path: string }) => file.path)).toEqual(["existing.ts"]);
    expect(data.summary).not.toContain("untracked");
  });

  it("passes trackedOnly through the MCP diff handler", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-mcp-diff-tracked-only-"));
    await execa("git", ["init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "existing.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "init"], {
      cwd: repo,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    fs.appendFileSync(path.join(repo, "existing.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(repo, "new.ts"), "export const ignored = true;\n");

    const response = await createMcpHandlers(repo).diff({ staged: false, trackedOnly: true });
    const data = JSON.parse(response.content[0].text);

    expect(data.changedFiles.map((file: { path: string }) => file.path)).toEqual(["existing.ts"]);
    expect(data.summary).not.toContain("untracked");
  });

  it("formats upgrade refresh-only output instead of emitting raw JSON", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-upgrade-cli-"));
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-upgrade-cli-home-"));
    const codexConfig = path.join(home, ".codex/config.toml");
    const codexHooks = path.join(home, ".codex/hooks.json");
    const skillFile = path.join(home, ".codex/skills/frontload/SKILL.md");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      `args = ["mcp", "--repo", "${repo}"]`,
      ""
    ].join("\n"));
    fs.writeFileSync(codexHooks, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "frontload", args: ["hook", "pre-tool-use"], timeout: 3 }]
          }
        ]
      }
    }, null, 2));
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "old skill\n");

    const result = await execa(process.execPath, [
      path.resolve("dist/src/cli/index.js"),
      "upgrade",
      "--refresh-only",
      "--repo",
      repo,
      "--home",
      home,
      "--global-install-action",
      "updated",
      "--global-install-command",
      "npm install -g frontload@latest"
    ]);

    expect(result.stdout).toContain("Frontload upgrade complete");
    expect(result.stdout).toContain("| Global command |");
    expect(result.stdout).toContain("[updated] npm install -g frontload@latest");
    expect(result.stdout).toContain("| Codex setup |");
    expect(result.stdout).toContain(`[updated] ${codexConfig}`);
    expect(result.stdout).toContain("Restart Codex after upgrade completes");
    expect(result.stdout).not.toContain("\"agents\"");
    expect(result.stdout).not.toContain("\"repoRoot\"");
    expect(result.stdout).not.toContain("\"writes\"");
  });

  it("rejects invalid dogfood configurations", async () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const cases = [
      {
        name: "missing Codex config",
        writeConfig: false,
        expected: { codex: { configured: false } }
      },
      {
        name: "non-MCP command",
        lines: (repo: string) => [`args = ["doctor", "--repo", "${repo}"]`],
        expected: { codex: { startsMcp: false } }
      },
      {
        name: "disabled server",
        lines: (repo: string) => [`args = ["mcp", "--repo", "${repo}"]`, "enabled = false"],
        expected: { codex: { enabledForUse: false } }
      },
      {
        name: "relative repo",
        lines: () => ['args = ["mcp", "--repo", "."]', "enabled = true"],
        expected: { codex: { repoIsAbsolute: false, repoMatches: false } }
      },
      {
        name: "version mismatch",
        installedVersion: "0.0.0",
        lines: (repo: string) => [`args = ["mcp", "--repo", "${repo}"]`, "enabled = true"],
        expected: { installedCommand: { matchesCurrentVersion: false } }
      },
      {
        name: "ephemeral path",
        binSubdir: "_npx/123/bin",
        lines: (repo: string) => [`args = ["mcp", "--repo", "${repo}"]`, "enabled = true"],
        expected: { installedCommand: { available: false } }
      }
    ];

    for (const scenario of cases) {
      const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", `frontload-doctor-${scenario.name.replaceAll(" ", "-")}-`));
      const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-invalid-home-"));
      const binRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-doctor-invalid-bin-"));
      const bin = path.join(binRoot, scenario.binSubdir ?? "global/bin");
      writeDogfoodPackageFiles(repo, pkg.version);
      writeInstalledFrontloadPackage(bin, scenario.installedVersion ?? pkg.version);
      if (scenario.writeConfig !== false) {
        const codexConfig = path.join(home, ".codex/config.toml");
        fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
        fs.writeFileSync(codexConfig, [
          "[mcp_servers.frontload]",
          "command = \"frontload\"",
          ...(scenario.lines?.(repo) ?? []),
          ""
        ].join("\n"));
      }

      const result = await execa(
        process.execPath,
        [path.resolve("dist/src/cli/index.js"), "doctor", "--repo", repo, "--home", home, "--dogfood"],
        {
          env: {
            ...process.env,
            PATH: bin
          },
          reject: false
        }
      );
      const data = JSON.parse(result.stdout);

      expect(result.exitCode, scenario.name).toBe(1);
      expect(data.checks.dogfood.ok, scenario.name).toBe(false);
      expect(data.checks.dogfood, scenario.name).toMatchObject(scenario.expected);
    }
  });

  it("records exact CLI baselines for measured operations", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-cli-savings-"));
    fs.mkdirSync(path.join(repo, ".frontload"));
    fs.mkdirSync(path.join(repo, "src"));
    const source = `${Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i};`).join("\n")}\n`;
    fs.writeFileSync(path.join(repo, "src/sample.ts"), source);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "init"], {
      cwd: repo,
      env: {
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "A",
        GIT_COMMITTER_EMAIL: "a@example.com"
      }
    });
    fs.appendFileSync(path.join(repo, "src/sample.ts"), "export const changed = true;\n");

    const cli = path.resolve("dist/src/cli/index.js");
    const indexResult = await execa(process.execPath, [cli, "index", "--repo", repo], { stripFinalNewline: false });
    await execa(process.execPath, [cli, "search", ".", "--repo", repo, "--limit", "1"]);
    await execa(process.execPath, [cli, "read", "src/sample.ts", "--repo", repo, "--budget", "200"]);
    await execa(process.execPath, [
      cli,
      "run",
      "--repo",
      repo,
      "--kind",
      "generic",
      "--allow-unconfigured",
      "--",
      "node",
      "-e",
      "console.log('x'.repeat(2000))"
    ]);
    await execa(process.execPath, [cli, "diff", "--repo", repo]);

    const events = readEvents(repo);
    expect(Buffer.byteLength(indexResult.stdout)).toBe(events.find((event) => event.operation === "index")?.outputBytes);
    const unboundedSearch = await searchIndexMeasured(repo, ".", Number.MAX_SAFE_INTEGER);
    expect(events.find((event) => event.operation === "search")?.baselineBytes).toBe(
      Buffer.byteLength(`${JSON.stringify(searchResultsOutput(compactRankedResults(unboundedSearch.unboundedResults)), null, 2)}\n`)
    );
    const rawDiff = await execa("git", ["diff", "--patch"], { cwd: repo, stripFinalNewline: false });
    expect(events.find((event) => event.operation === "read")).toMatchObject({
      baselineBytes: Buffer.byteLength(fs.readFileSync(path.join(repo, "src/sample.ts"))),
      baselineKind: "full-file"
    });
    expect(events.find((event) => event.operation === "run")).toMatchObject({
      baselineBytes: 2001,
      baselineKind: "raw-command-output"
    });
    expect(events.find((event) => event.operation === "diff")).toMatchObject({
      baselineBytes: Buffer.byteLength(rawDiff.stdout),
      baselineKind: "raw-diff"
    });
    expect(events.find((event) => event.operation === "search")).toMatchObject({
      baselineKind: "unbounded-search-results"
    });
    const report = budgetReport(repo);
    expect(report.measuredOperations).toBe(4);
    expect(report.unmeasuredOperations).toBe(1);
    expect(report.summary).toMatch(/saved|used extra bytes/);
  });

  it("compacts oversized CLI budget reports under the configured tool cap", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-budget-cli-"));
    fs.mkdirSync(path.join(repo, ".frontload"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 1200 }
    }));
    for (let i = 0; i < 80; i += 1) {
      appendEvent(repo, {
        source: "mcp",
        operation: "read",
        inputChars: 20,
        outputChars: 100,
        outputBytes: 100,
        baselineBytes: 1000,
        baselineKind: "full-file",
        durationMs: 1,
        success: true
      });
    }

    const result = await execa(process.execPath, [path.resolve("dist/src/cli/index.js"), "budget", "--repo", repo]);
    const data = JSON.parse(result.stdout);

    expect(Buffer.byteLength(`${result.stdout}\n`)).toBeLessThanOrEqual(1200);
    expect(data).toMatchObject({
      truncated: true,
      operation: "budget",
      operations: 80,
      measuredOperations: 80,
      omittedEventDetails: 30
    });
    expect(data.largest).toBeUndefined();
    expect(data.last20).toBeUndefined();
  });

  it("measures local scout against uncapped local output", async () => {
    const repo = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "frontload-local-scout-"));
    fs.mkdirSync(path.join(repo, ".frontload"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      localScout: {
        enabled: true,
        command: "printf 'stdout line\\n'; printf 'stderr line\\n' >&2",
        timeoutMs: 5000,
        maxOutputChars: 10
      }
    }));

    const response = await createMcpHandlers(repo).localScout({ prompt: "inspect" });
    const data = JSON.parse(response.content[0].text);
    const event = readEvents(repo).at(-1);
    const actual = await execa("sh", ["-lc", "printf 'stdout line\\n'; printf 'stderr line\\n' >&2"], {
      cwd: repo,
      all: true,
      stripFinalNewline: false
    });

    expect(data.output).toHaveLength(10);
    expect(Buffer.byteLength(actual.all ?? "")).toBe(event?.baselineBytes);
    expect(event).toMatchObject({
      source: "mcp",
      operation: "local-scout",
      baselineBytes: Buffer.byteLength(actual.all ?? ""),
      baselineKind: "raw-local-scout-output"
    });
  });
});
