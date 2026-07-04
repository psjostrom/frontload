import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { budgetReport, readEvents } from "../../src/budget/events.js";
import { searchIndexMeasured } from "../../src/dossier/dossier.js";
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

    const response = await createMcpHandlers(repo).search({ query: "missingNeedle", limit: 10 });
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
    expect(JSON.parse(result.stdout).summary).toContain("not upgraded globally");
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
      home
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
    expect(JSON.parse(result.stdout).summary).toContain("refreshed existing agent configuration");
    expect(fs.readFileSync(codexConfig, "utf8")).toContain('command = "frontload"');
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(false);
  });

  it("calls required tool handlers and stores transcript", async () => {
    fs.mkdirSync("proof", { recursive: true });
    fs.writeFileSync("proof/mcp-transcript.jsonl", "");
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
      fs.appendFileSync("proof/mcp-transcript.jsonl", JSON.stringify({ tool, response: { summary } }) + "\n");
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
    expect(fs.existsSync("proof/mcp-transcript.jsonl")).toBe(true);
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
      Buffer.byteLength(`${JSON.stringify(unboundedSearch.unboundedResults, null, 2)}\n`)
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
