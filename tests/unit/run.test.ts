import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { runSummary } from "../../src/commands/run.js";

describe("command summary", () => {
  it("summarizes TypeScript errors and writes raw log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-"));
    const result = await runSummary(dir, "typecheck", ["node", "-e", "console.error('src/a.ts(1,2): error TS1234: nope'); process.exit(2)"], true);
    expect(result.exitCode).toBe(2);
    expect(result.findings[0].title).toContain("TS1234");
    expect(fs.existsSync(result.fullLogPath)).toBe(true);
  });

  it("uses a stable log filename when kind is omitted by a caller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-no-kind-"));
    const result = await runSummary(dir, undefined as never, ["node", "-e", "console.log('ok')"], true);

    expect(path.basename(result.fullLogPath)).not.toContain("undefined");
    expect(path.basename(result.fullLogPath)).toMatch(/-generic\.log$/);
    expect(result.kind).toBe("generic");
  });

  it("keeps generated Frontload state out of git status in a clean repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-clean-status-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });

    await runSummary(dir, "generic", ["node", "-e", "console.log('ok')"], true);
    const status = await execa("git", ["status", "--short"], { cwd: dir });

    expect(status.stdout).toBe("");
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain(".frontload/");
  });

  it("summarizes failing test output and compresses verbose logs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-"));
    const noisy = "x".repeat(20000);
    const script = `console.error('FAIL src/chart/ChartTooltip.test.tsx\\nx updates stale chart tooltip value after sensor reconnect 5ms\\nExpected: 93 mg/dL\\nReceived: 92 mg/dL\\n${noisy}'); process.exit(1)`;
    const result = await runSummary(dir, "test", ["node", "-e", script], true);
    expect(result.findings[0].file).toContain("ChartTooltip.test.tsx");
    expect(result.summaryChars).toBeLessThan(8000);
    expect(result.compressionRatio).toBeLessThan(0.5);
  });

  it("does not infer error findings from successful output text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-success-"));
    const output = [
      "✓ tests/unit/run.test.ts (6 tests) 1200ms",
      "  ✓ command summary > summarizes failing test output and compresses verbose logs 517ms"
    ].join("\n");

    const result = await runSummary(dir, "test", ["node", "-e", `console.log(${JSON.stringify(output)})`], true);

    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary).not.toContain("[error]");
  });

  it("does not report passing dogfood test names as errors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-dogfood-success-"));
    const output = [
      "✓ tests/unit/install.test.ts (1 test) 12ms",
      "  ✓ installer > doctor verifies regular installed dogfood path 9ms",
      "test(\"dogfood path\", () => {})"
    ].join("\n");

    const result = await runSummary(dir, "test", ["node", "-e", `console.log(${JSON.stringify(output)})`], true);

    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary).not.toContain("[error] dogfood path");
  });

  it("includes bounded stdout for successful diagnostic commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-diagnostic-"));
    const output = "repo-a repoMatches=false\nrepo-b repoMatches=true\n";

    const result = await runSummary(dir, "generic", ["node", "-e", `process.stdout.write(${JSON.stringify(output)})`], true);

    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("Output:");
    expect(result.summary).toContain("repo-a repoMatches=false");
    expect(result.summary).toContain("repo-b repoMatches=true");
  });

  it("allows package e2e scripts when package metadata exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-e2e-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      scripts: {
        e2e: "node -e \"console.log('e2e ok')\""
      }
    }));

    const result = await runSummary(dir, "test", ["pnpm", "e2e"], false);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("e2e ok");
  });

  it("allows common Gradle test commands when Gradle metadata exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-gradle-"));
    fs.writeFileSync(path.join(dir, "build.gradle.kts"), "");
    fs.writeFileSync(path.join(dir, "gradlew"), "#!/bin/sh\necho ok\n");
    fs.chmodSync(path.join(dir, "gradlew"), 0o755);
    const result = await runSummary(dir, "test", ["./gradlew", "testDebugUnitTest"], false);
    expect(result.exitCode).toBe(0);
  });

  it("summarizes Gradle detekt failures with file locations and raw log path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-detekt-"));
    const output = [
      "> Task :app:detekt FAILED",
      "src/main/kotlin/App.kt:12:5: Magic number detected [MagicNumber]",
      "",
      "* What went wrong:",
      "Execution failed for task ':app:detekt'.",
      "> Analysis failed with 1 weighted issue."
    ].join("\n");
    const result = await runSummary(dir, "lint", ["node", "-e", `console.error(${JSON.stringify(output)}); process.exit(1)`], true);

    expect(result.exitCode).toBe(1);
    expect(result.fullLogPath).toContain(".frontload");
    expect(result.summary).toContain("Exit code: 1");
    expect(result.summary).toContain("Raw log:");
    expect(result.findings.some((finding) => finding.file === "src/main/kotlin/App.kt" && finding.line === 12)).toBe(true);
    expect(result.findings.some((finding) => finding.title.includes("Gradle task failed"))).toBe(true);
  });

  it("summarizes Rust compiler errors with file locations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-rust-"));
    const output = [
      "error[E0308]: mismatched types",
      " --> src/lib.rs:7:13",
      "  |",
      "7 |     let x: i32 = \"nope\";"
    ].join("\n");
    const result = await runSummary(dir, "test", ["node", "-e", `console.error(${JSON.stringify(output)}); process.exit(1)`], true);

    expect(result.exitCode).toBe(1);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      file: "src/lib.rs",
      line: 7,
      column: 13
    });
    expect(result.findings[0].title).toContain("E0308");
  });

  it("explains pnpm ignored-builds failures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-pnpm-ignored-builds-"));
    const output = [
      "ERR_PNPM_IGNORED_BUILDS Command failed with exit code 1.",
      "Ignored build scripts: esbuild.",
      "Run \"pnpm approve-builds\" to pick which dependencies should be allowed to run scripts."
    ].join("\n");

    const result = await runSummary(dir, "typecheck", ["node", "-e", `console.error(${JSON.stringify(output)}); process.exit(1)`], true);

    expect(result.exitCode).toBe(1);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      title: "pnpm blocked dependency build scripts before the requested command ran"
    });
    expect(result.findings[0].detail).toContain("pnpm approve-builds");
    expect(result.findings[0].detail).toContain("local binary directly");
  });

  it("explains transient Next.js generated type races", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-next-types-race-"));
    const output = "error TS6053: File '.next/types/app/page.ts' not found.\n  The file is in the program because: Matched by include pattern '.next/types/**/*.ts' in 'tsconfig.json'";

    const result = await runSummary(dir, "typecheck", ["node", "-e", `console.error(${JSON.stringify(output)}); process.exit(2)`], true);

    expect(result.exitCode).toBe(2);
    expect(result.findings.some((finding) =>
      finding.title.includes("Next.js generated types may be transient") &&
      finding.detail?.includes("If a Next.js build is running concurrently")
    )).toBe(true);
  });

  it("falls back to a bounded raw tail for unrecognized failing output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-tail-"));
    const lines = Array.from({ length: 120 }, (_, i) => `custom reporter line ${i + 1}`);
    const result = await runSummary(dir, "generic", ["node", "-e", `console.log(${JSON.stringify(lines.join("\n"))}); process.exit(1)`], true);

    expect(result.exitCode).toBe(1);
    expect(result.findings[0].title).toBe("Unrecognized failing output; showing bounded tail");
    expect(result.findings[0].detail).toContain("custom reporter line 120");
    expect(result.findings[0].detail).toContain("custom reporter line 81");
    expect(result.findings[0].detail).not.toContain("custom reporter line 80\n");
    expect(result.summary).toContain("Raw log:");
  });
});
