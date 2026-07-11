import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/budget/events.js";
import { FrontloadGate } from "../../src/gate/adapters/opencode.js";

type OpenCodeHook = (
  input: { tool: string },
  output: { args?: unknown; output?: unknown }
) => void | Promise<void>;

function initializedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-opencode-gate-"));
  fs.mkdirSync(path.join(repo, ".frontload"));
  return repo;
}

async function opencodeHooks(repo: string): Promise<Record<string, OpenCodeHook>> {
  return await FrontloadGate({ directory: repo }) as Record<string, OpenCodeHook>;
}

describe("opencode gate adapter", () => {
  it("rewrites bash commands through the shared gate defaults", async () => {
    const repo = initializedRepo();
    const hooks = await opencodeHooks(repo);
    const output = { args: { command: "pnpm test" } };

    await hooks["tool.execute.before"]({ tool: "bash" }, output);

    expect(output.args.command).toContain("run --repo");
    expect(output.args.command).toContain(`'${repo}'`);
    expect(output.args.command).toContain("--kind test -- pnpm test");
  });

  it("throws on denied bash commands instead of rewriting them to shell echo", async () => {
    const repo = initializedRepo();
    const hooks = await opencodeHooks(repo);
    const command = "grep -r --include='*.ts' token .";
    const output = { args: { command } };

    await expect(hooks["tool.execute.before"]({ tool: "bash" }, output)).rejects.toThrow(
      "Recursive grep cannot be rewritten safely"
    );
    expect(output.args.command).toBe(command);
  });

  it("compacts bash output through the shared accounting path", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 240 }
    }));
    const hooks = await opencodeHooks(repo);
    const output = { args: { command: "pnpm test" }, output: "x".repeat(1000) };

    await hooks["tool.execute.after"]({ tool: "bash" }, output);

    expect(typeof output.output).toBe("string");
    expect((output.output as string).length).toBeLessThanOrEqual(240);
    expect(output.output).toContain("[Frontload truncated ");
    expect(readEvents(repo).at(-1)).toMatchObject({
      source: "hook",
      operation: "post-tool-use:Bash",
      baselineKind: "observed-tool-output"
    });
  });

  it("stays inert when the repository gate is disabled", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      gate: { enabled: false }
    }));

    await expect(FrontloadGate({ directory: repo })).resolves.toEqual({});
  });

  it("fails open for unsupported tools and malformed hook payloads", async () => {
    const repo = initializedRepo();
    const hooks = await opencodeHooks(repo);
    const readOutput = { args: { command: "pnpm test" }, output: "x".repeat(1000) };

    await expect(hooks["tool.execute.before"]({ tool: "read" }, readOutput)).resolves.toBeUndefined();
    await expect(hooks["tool.execute.after"]({ tool: "read" }, readOutput)).resolves.toBeUndefined();
    expect(readOutput.args.command).toBe("pnpm test");
    expect(readOutput.output).toBe("x".repeat(1000));

    await expect(hooks["tool.execute.before"]({ tool: "bash" }, {})).resolves.toBeUndefined();
    await expect(hooks["tool.execute.before"]({ tool: "bash" }, { args: [] })).resolves.toBeUndefined();
    await expect(hooks["tool.execute.after"]({ tool: "bash" }, {})).resolves.toBeUndefined();
    expect(readEvents(repo).filter((event) => event.operation === "post-tool-use:Bash")).toHaveLength(0);
  });
});
