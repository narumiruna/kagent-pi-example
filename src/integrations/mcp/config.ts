export type McpServerConfig = {
  id: string;
  transport: "streamable-http" | "sse";
  url: string;
  allowedTools: string[];
  timeoutMs: number;
  headerEnv: Record<string, string>;
  destinationPolicy?: string;
};

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

export function parseMcpServers(value: string | undefined): McpServerConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("PI_MCP_SERVERS_JSON must be a JSON array", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("PI_MCP_SERVERS_JSON must be a JSON array");
  const ids = new Set<string>();
  return parsed.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MCP server ${index} must be an object`);
    const item = raw as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(id) || ids.has(id)) {
      throw new Error(`MCP server ${index} has an invalid or duplicate id`);
    }
    ids.add(id);
    if (item.transport !== "streamable-http" && item.transport !== "sse") {
      throw new Error(`MCP server ${id} has an unsupported transport`);
    }
    if (typeof item.url !== "string") throw new Error(`MCP server ${id} requires a URL`);
    const url = new URL(item.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`MCP server ${id} URL must be HTTP(S) without inline credentials`);
    }
    if (!nonEmptyStrings(item.allowedTools)) throw new Error(`MCP server ${id} requires an explicit tool allowlist`);
    const timeoutMs = item.timeoutMs === undefined ? 15_000 : Number(item.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new Error(`MCP server ${id} timeoutMs must be between 100 and 120000`);
    }
    const headerEnv = item.headerEnv ?? {};
    if (!headerEnv || typeof headerEnv !== "object" || Array.isArray(headerEnv)) {
      throw new Error(`MCP server ${id} headerEnv must be an object`);
    }
    for (const [header, envName] of Object.entries(headerEnv)) {
      if (!/^[a-z0-9-]+$/i.test(header) || typeof envName !== "string" || !/^PI_MCP_[A-Z0-9_]+$/.test(envName)) {
        throw new Error(`MCP server ${id} has an invalid header environment mapping`);
      }
    }
    return {
      id,
      transport: item.transport,
      url: url.toString(),
      allowedTools: [...new Set(item.allowedTools)],
      timeoutMs,
      headerEnv: headerEnv as Record<string, string>,
      destinationPolicy: typeof item.destinationPolicy === "string" ? item.destinationPolicy : undefined,
    };
  });
}

export function toolAllowed(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(name);
  });
}
