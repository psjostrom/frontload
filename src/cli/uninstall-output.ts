import path from "node:path";
import type { RemovalRecord, UninstallResult } from "../install/uninstall.js";

function displayTarget(result: UninstallResult, target: string): string {
  const repoRelative = path.relative(result.repoRoot, target);
  if (repoRelative && !repoRelative.startsWith("..") && !path.isAbsolute(repoRelative)) return repoRelative;
  const homeRelative = path.relative(result.homeDir, target);
  if (homeRelative && !homeRelative.startsWith("..") && !path.isAbsolute(homeRelative)) return `~/${homeRelative}`;
  return target;
}

function recordLine(result: UninstallResult, record: RemovalRecord): string {
  const error = record.error ? ` — ${record.error}` : "";
  return `[${record.status}] ${displayTarget(result, record.target)}${error}`;
}

export function formatUninstallOutput(result: UninstallResult): string {
  const sections: Array<{ title: string; category: RemovalRecord["category"] }> = [
    { title: "Repository artifacts", category: "repository" },
    { title: "Agent artifacts", category: "agent" },
    { title: "Global packages", category: "package" },
  ];
  const lines = [
    result.failures.length > 0 ? "Frontload uninstall incomplete" : "Frontload uninstall complete",
  ];
  for (const section of sections) {
    const records = result.records.filter((record) => record.category === section.category);
    if (records.length === 0) continue;
    lines.push("", section.title);
    lines.push(...records.map((record) => recordLine(result, record)));
  }
  return `${lines.join("\n")}\n`;
}
