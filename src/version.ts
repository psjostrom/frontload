import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function packageVersionFrom(startDir = moduleDir): string {
  let dir = startDir;
  while (true) {
    const packageFile = path.join(dir, "package.json");
    if (fs.existsSync(packageFile)) {
      const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "frontload" && typeof pkg.version === "string") return pkg.version;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error("Could not find frontload package.json");
}

export const packageVersion = packageVersionFrom();
