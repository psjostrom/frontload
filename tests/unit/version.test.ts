import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageVersionFrom } from "../../src/version.js";

describe("package version", () => {
  it("loads the nearest frontload package version from an ancestor directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-version-"));
    const nested = path.join(root, "dist/src/cli");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "frontload", version: "9.8.7" }));

    expect(packageVersionFrom(nested)).toBe("9.8.7");
  });

  it("uses the current package.json version", () => {
    const rootVersion = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version;

    expect(packageVersionFrom()).toBe(rootVersion);
  });
});
