import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const opencodeGateAdapterRelativePath = "dist/src/gate/adapters/opencode.js";

function executableNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return extensions.flatMap((ext) => [`${command}${ext.toLowerCase()}`, `${command}${ext.toUpperCase()}`]).concat(command);
}

function isEphemeralPackagePath(value: string): boolean {
  const normalized = value.replaceAll(path.sep, "/");
  return normalized.includes("/_npx/") || normalized.includes("/dlx-") || normalized.includes("/.pnpm/dlx/") || normalized.includes("/node_modules/.bin/");
}

function resolveFrontloadExecutable(envPath: string): string | undefined {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames("frontload")) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (!isEphemeralPackagePath(candidate)) return candidate;
      } catch {
        // Keep looking through PATH.
      }
    }
  }
  return undefined;
}

function frontloadPackageRootFrom(start: string): string | undefined {
  let dir = path.resolve(start);
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(fs.realpathSync(dir));
  } catch {
    return undefined;
  }
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "frontload") return dir;
      } catch {
        // Keep walking upward.
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function adapterUrl(root: string): string {
  return pathToFileURL(path.join(root, opencodeGateAdapterRelativePath)).href;
}

export function preferredOpencodeGateAdapterUrl(currentPackageRoot: string, envPath = process.env.PATH ?? ""): string {
  const executable = resolveFrontloadExecutable(envPath);
  const globalRoot = executable ? frontloadPackageRootFrom(executable) : undefined;
  const root = isEphemeralPackagePath(currentPackageRoot) && globalRoot ? globalRoot : currentPackageRoot;
  return adapterUrl(root);
}

export function opencodeGatePluginWrapper(_preferredAdapterUrl: string | null): string {
  return `// Frontload agent integration is paused.
export const FrontloadGate = async () => ({});
`;
}

export function isGeneratedOpencodeGateWrapper(text: string): boolean {
  return text === opencodeGatePluginWrapper(null);
}
