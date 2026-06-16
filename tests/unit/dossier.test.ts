import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../../src/indexer/indexer.js";
import { generateDossier, searchIndex } from "../../src/dossier/dossier.js";

const fixture = path.resolve("fixtures/react-ts-app");

describe("dossier", () => {
  it("ranks tooltip-related files for known task", async () => {
    await buildIndex(fixture);
    const dossier = await generateDossier(fixture, "Fix stale chart tooltip value after sensor reconnect", 12000);
    const top = dossier.ranked.slice(0, 5).map((r) => r.file.path);
    expect(top).toContain("src/chart/ChartTooltip.tsx");
    expect(top).toContain("src/chart/ChartTooltip.test.tsx");
    expect(top).toContain("src/sensor/sensorConnectionStore.ts");
    expect(top.includes("src/unrelated/BillingSettings.ts")).toBe(false);
  });

  it("stays within budget and includes commands", async () => {
    const dossier = await generateDossier(fixture, "tooltip reconnect", 1000);
    expect(dossier.markdown.length).toBeLessThanOrEqual(1100);
    expect(dossier.markdown).toContain("Ranking confidence");
    expect(dossier.markdown).toContain("pnpm tsc --noEmit");
  });

  it("returns bounded content matches for literal search text", async () => {
    await buildIndex(fixture);
    const results = await searchIndex(fixture, "92 mg/dL", 5);
    const match = results.find((result) => result.matches?.some((line) => line.text.includes("92 mg/dL")));
    expect(match?.file.path).toBe("src/chart/ChartTooltip.test.tsx");
    expect(match?.why).toContain("content match");
  });

  it("redacts secrets from literal content matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-redact-"));
    fs.writeFileSync(path.join(dir, "settings.ts"), "export const api_key = \"sk-1234567890abcdefghijklmnop\";\n");
    await buildIndex(dir);

    const results = await searchIndex(dir, "api_key", 5);
    const match = results.find((result) => result.file.path === "settings.ts");

    expect(match?.matches?.[0]?.text).toContain("api_key =[REDACTED]");
    expect(match?.matches?.[0]?.text).not.toContain("sk-1234567890abcdefghijklmnop");
  });
});
