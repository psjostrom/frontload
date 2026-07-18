import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FrontloadGate } from "../../src/gate/adapters/opencode.js";

describe("opencode gate adapter", () => {
  it("registers no hooks while agent integrations are paused", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-paused-"));
    fs.mkdirSync(path.join(repo, ".frontload"));

    await expect(FrontloadGate({ directory: repo })).resolves.toEqual({});
  });
});
