import { describe, expect, it } from "vitest";
import { formatUninstallOutput } from "../../src/cli/uninstall-output.js";
import type { UninstallResult } from "../../src/install/uninstall.js";

function resultWith(status: "removed" | "absent" | "failed"): UninstallResult {
  const record = {
    category: "repository" as const,
    target: "/tmp/repo/.frontload",
    status,
    ...(status === "failed" ? { error: "permission denied" } : {}),
  };
  return {
    repoRoot: "/tmp/repo",
    homeDir: "/tmp/home",
    records: [
      record,
      { category: "agent", target: "/tmp/home/.codex/skills/frontload", status: "absent" },
      { category: "package", target: "npm uninstall -g frontload", status: "removed" },
    ],
    failures: status === "failed" ? [record] : [],
  };
}

describe("uninstall output formatting", () => {
  it("renders a grouped human-readable success summary", () => {
    const output = formatUninstallOutput(resultWith("removed"));

    expect(output).toContain("Frontload uninstall complete");
    expect(output).toContain("Repository artifacts");
    expect(output).toContain("Agent artifacts");
    expect(output).toContain("Global packages");
    expect(output).toContain("[removed] .frontload");
    expect(output).toContain("[absent] ~/.codex/skills/frontload");
    expect(output).toContain("[removed] npm uninstall -g frontload");
    expect(output).not.toContain('"records"');
  });

  it("renders failures and an incomplete heading", () => {
    const output = formatUninstallOutput(resultWith("failed"));

    expect(output).toContain("Frontload uninstall incomplete");
    expect(output).toContain("[failed] .frontload — permission denied");
  });
});
