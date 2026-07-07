import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../../src/indexer/indexer.js";
import { generateDossier, searchIndex, searchIndexMeasured } from "../../src/dossier/dossier.js";

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

  it("surfaces camelCase symbol files for focused search terms", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-camel-symbol-"));
    fs.mkdirSync(path.join(dir, "lib/__tests__"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/components/__tests__"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib/byFeel.ts"), [
      "const SUFFIX = \" By Feel\";",
      "export function isByFeel(name: string): boolean { return name.endsWith(SUFFIX); }",
      "export function addByFeel(name: string): string { return isByFeel(name) ? name : name + SUFFIX; }",
      "export function removeByFeel(name: string): string { return isByFeel(name) ? name.slice(0, -SUFFIX.length) : name; }",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "lib/__tests__/byFeel.test.ts"), [
      "import { addByFeel, isByFeel, removeByFeel } from \"../byFeel\";",
      "it(\"handles By Feel suffixes\", () => {",
      "  expect(addByFeel(\"W05 Long\")).toBe(\"W05 Long By Feel\");",
      "  expect(isByFeel(\"W05 Long By Feel\")).toBe(true);",
      "  expect(removeByFeel(\"W05 Long By Feel\")).toBe(\"W05 Long\");",
      "});",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "app/components/EventModal.tsx"), [
      "import { addByFeel, isByFeel } from \"../../lib/byFeel\";",
      "export function EventModal() { return addByFeel(\"W05 Long\"); }",
      ""
    ].join("\n"));
    for (let i = 0; i < 6; i += 1) {
      const noisyAssertions = Array.from(
        { length: 30 },
        (_, line) => `  expect("W05 Long By Feel ${i}-${line}").toContain("By Feel");`
      );
      fs.writeFileSync(path.join(dir, `app/components/__tests__/Noise${i}.test.tsx`), [
        "it(\"mentions By Feel repeatedly in unrelated UI assertions\", () => {",
        ...noisyAssertions,
        "});",
        ""
      ].join("\n"));
    }
    await buildIndex(dir);

    const results = await searchIndex(dir, "addByFeel isByFeel By Feel lib/byFeel", 5);

    expect(results[0]?.file.path).toBe("lib/byFeel.ts");
  });

  it("ranks camelCase domain files in task dossiers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-dossier-camel-domain-"));
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/components"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib/byFeel.ts"), [
      "const SUFFIX = \" By Feel\";",
      "export function isByFeel(name: string): boolean { return name.endsWith(SUFFIX); }",
      "export function addByFeel(name: string): string { return isByFeel(name) ? name : name + SUFFIX; }",
      "export function removeByFeel(name: string): string { return isByFeel(name) ? name.slice(0, -SUFFIX.length) : name; }",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "app/components/EventModal.tsx"), [
      "import { addByFeel, isByFeel } from \"../../lib/byFeel\";",
      "export function EventModal() { return addByFeel(\"W05 Long\"); }",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "lib/constants.ts"), [
      "export function getWorkoutCategory(name: string) { return name.toLowerCase(); }",
      ""
    ].join("\n"));
    await buildIndex(dir);

    const dossier = await generateDossier(dir, "revert a by feel workout to a regular workout", 12000);

    expect(dossier.ranked[0]?.file.path).toBe("lib/byFeel.ts");
  });

  it("returns exact unbounded search results alongside the bounded response", async () => {
    await buildIndex(fixture);
    const measured = await searchIndexMeasured(fixture, ".", 2);

    expect(measured.results).toHaveLength(2);
    expect(measured.unboundedResults.length).toBeGreaterThan(2);
    expect(measured.results).toEqual(measured.unboundedResults.slice(0, 2));
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

  it("searchIndex sees symbols added after the last explicit index build", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-fresh-symbol-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function oldThing() { return 1; }\n");
    await buildIndex(dir);

    fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function newThing() { return 2; }\n");
    const results = await searchIndex(dir, "newThing", 5);

    expect(results[0]?.file.path).toBe("src/sample.ts");
    expect(results[0]?.file.symbols).toContain("newThing");
    expect(results[0]?.file.symbols).not.toContain("oldThing");
  });

  it("searchIndex sees files added after the last explicit index build", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-fresh-file-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/old.ts"), "export const oldThing = 1;\n");
    await buildIndex(dir);

    fs.writeFileSync(path.join(dir, "src/new.ts"), "export const brandNewNeedle = 2;\n");
    const results = await searchIndex(dir, "brandNewNeedle", 5);

    expect(results.some((result) => result.file.path === "src/new.ts")).toBe(true);
  });
});
