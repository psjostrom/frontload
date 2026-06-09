import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("summarizes failing test output and compresses verbose logs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-run-"));
    const noisy = "x".repeat(20000);
    const script = `console.error('FAIL src/chart/ChartTooltip.test.tsx\\nx updates stale chart tooltip value after sensor reconnect 5ms\\nExpected: 93 mg/dL\\nReceived: 92 mg/dL\\n${noisy}'); process.exit(1)`;
    const result = await runSummary(dir, "test", ["node", "-e", script], true);
    expect(result.findings[0].file).toContain("ChartTooltip.test.tsx");
    expect(result.summaryChars).toBeLessThan(8000);
    expect(result.compressionRatio).toBeLessThan(0.5);
  });

  it("allows common Gradle test commands when Gradle metadata exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-gradle-"));
    fs.writeFileSync(path.join(dir, "build.gradle.kts"), "");
    fs.writeFileSync(path.join(dir, "gradlew"), "#!/bin/sh\necho ok\n");
    fs.chmodSync(path.join(dir, "gradlew"), 0o755);
    const result = await runSummary(dir, "test", ["./gradlew", "testDebugUnitTest"], false);
    expect(result.exitCode).toBe(0);
  });
});
