import fs from "node:fs";
import nodePath from "node:path";
import { applyEdits, modify, parse, type FormattingOptions, type JSONPath, type ParseError } from "jsonc-parser";

const FORMAT: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" };

export function readJsonc<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || parsed === undefined) return fallback;
  return parsed as T;
}

export function writeJsoncValue(
  file: string,
  path: JSONPath,
  value: unknown,
  fallbackConfig: Record<string, unknown>,
): boolean {
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  if (!existed || !text.trim()) {
    const next = { ...fallbackConfig };
    let cursor: Record<string, unknown> = next;
    for (const segment of path.slice(0, -1)) {
      const key = String(segment);
      cursor[key] = isRecord(cursor[key]) ? cursor[key] : {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[String(path[path.length - 1])] = value;
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  }
  const edits = modify(text, path, value, { formattingOptions: FORMAT });
  const newText = applyEdits(text, edits);
  if (newText === text) return false;
  fs.writeFileSync(file, newText);
  return true;
}

export function removeJsoncValue(file: string, path: JSONPath): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const edits = modify(text, path, undefined, { formattingOptions: FORMAT });
  const newText = applyEdits(text, edits);
  if (newText === text) return false;
  fs.writeFileSync(file, newText);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}