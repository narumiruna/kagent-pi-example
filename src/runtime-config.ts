import { isAbsolute } from "node:path";

export function parseStringArray(value: string | undefined, name: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON array of strings`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }
  return [...new Set(parsed)];
}

export function parseAbsolutePaths(value: string | undefined, name: string): string[] {
  const paths = parseStringArray(value, name);
  const invalid = paths.filter((path) => !isAbsolute(path));
  if (invalid.length > 0) throw new Error(`${name} paths must be absolute: ${invalid.join(", ")}`);
  return paths;
}

export function parseToolNames(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const tools = parseStringArray(value, "PI_TOOLS_JSON");
  const invalid = tools.filter((tool) => !/^[a-zA-Z0-9_-]+$/.test(tool));
  if (invalid.length > 0) throw new Error(`PI_TOOLS_JSON contains invalid tool names: ${invalid.join(", ")}`);
  return tools;
}

export function parseEnabled(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${name} must be one of: 0, 1, false, true`);
}
