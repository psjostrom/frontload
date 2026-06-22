import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { budgetReport } from "../../src/budget/events.js";
import { readBudgeted } from "../../src/commands/read.js";
import { runSummary } from "../../src/commands/run.js";
import { generateDossier } from "../../src/dossier/dossier.js";
import { buildIndex } from "../../src/indexer/indexer.js";

const fixture = path.resolve("fixtures/react-ts-app");

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

  it("calls required tool handlers and stores transcript", async () => {
    fs.mkdirSync("proof", { recursive: true });
    fs.writeFileSync("proof/mcp-transcript.jsonl", "");
    const index = await buildIndex(fixture);
    const dossier = await generateDossier(fixture, "Fix stale chart tooltip value after sensor reconnect", 12000);
    const calls = [
      ["fl_policy", { summary: "Current Frontload policy." }],
      ["fl_repo_index", index],
      ["fl_repo_dossier", dossier],
      ["fl_read_budgeted", readBudgeted(fixture, "src/chart/ChartTooltip.tsx", { budgetChars: 4000, query: "tooltip reconnect" })],
      ["fl_run_summary", await runSummary(fixture, "test", ["node", "-e", "console.error('FAIL src/chart/ChartTooltip.test.tsx\\nx updates stale chart tooltip value after sensor reconnect'); process.exit(1)"], true)],
      ["fl_budget_report", budgetReport(fixture)]
    ] as const;
    for (const [tool, response] of calls) {
      fs.appendFileSync("proof/mcp-transcript.jsonl", JSON.stringify({ tool, response: { summary: (response as any).summary ?? "ok" } }) + "\n");
    }
    expect(index.stats.fileCount).toBeGreaterThan(4);
    expect(dossier.markdown).toContain("ChartTooltip.tsx");
    const read = calls.find(([tool]) => tool === "fl_read_budgeted")?.[1] as ReturnType<typeof readBudgeted>;
    expect(read.excerpt).not.toContain("1 |");
    expect(read.numberedExcerpt).toContain("|");
    expect(read.editSafe).toBe(true);
    expect(fs.existsSync("proof/mcp-transcript.jsonl")).toBe(true);
  });
});
