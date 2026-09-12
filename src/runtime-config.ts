import { isAbsolute } from "node:path";

export function validateJsonObject(value: string, name: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON object`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
}

function validatePort(port: number, name: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

export function parsePort(value: string | undefined, name: string, defaultValue: number): number {
  return validatePort(value === undefined ? defaultValue : Number(value), name);
}

export function parseOptionalPort(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : validatePort(Number(value), name);
}

export function parsePositiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

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
