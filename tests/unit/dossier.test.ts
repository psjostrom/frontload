import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../../src/indexer/indexer.js";
import { generateDossier } from "../../src/dossier/dossier.js";

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
});
