import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpClientManager } from "./client-manager.js";
import { toolAllowed } from "./config.js";

const MAX_RESULT_BYTES = 50 * 1024;
const RESERVED_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "load_memory", "save_memory"]);

export function normalizeMcpToolName(serverId: string, remoteName: string): string {
  const normalized = `mcp_${serverId}_${remoteName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized))
    throw new Error(`MCP tool name cannot be normalized safely: ${serverId}/${remoteName}`);
  return normalized;
}

function containsRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRef);
  const object = value as Record<string, unknown>;
  return "$ref" in object || Object.values(object).some(containsRef);
}

function formatResult(result: Awaited<ReturnType<McpClientManager["callTool"]>>): string {
  if (result.isError) throw new Error("The remote MCP tool returned an error");
  const values: string[] = [];
  if (result.structuredContent !== undefined) values.push(JSON.stringify(result.structuredContent));
  for (const part of result.content) {
    if (part.type !== "text") throw new Error("The remote MCP tool returned unsupported non-text content");
    values.push(part.text);
  }
  const output = values.join("\n");
  const bytes = Buffer.byteLength(output);
  if (bytes <= MAX_RESULT_BYTES) return output || "MCP tool completed without output.";
  const truncated = Buffer.from(output).subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return `${truncated}\n\n[MCP result truncated: ${bytes - MAX_RESULT_BYTES} bytes omitted]`;
}

export async function createMcpTools(manager: McpClientManager): Promise<ToolDefinition[]> {
  const definitions: ToolDefinition[] = [];
  const names = new Set(RESERVED_NAMES);
  for (const server of manager.servers) {
    const tools = await manager.listTools(server);
    for (const tool of tools) {
      if (!toolAllowed(tool.name, server.allowedTools)) continue;
      const name = normalizeMcpToolName(server.id, tool.name);
      if (names.has(name)) throw new Error(`Duplicate or reserved MCP tool name: ${name}`);
      names.add(name);
      const schema = tool.inputSchema as unknown as Record<string, unknown>;
      if (schema.type !== "object" || containsRef(schema)) {
        throw new Error(`MCP tool ${server.id}/${tool.name} has an unsupported input schema`);
      }
      definitions.push({
        name,
        label: name,
        description: `Untrusted remote MCP tool (${server.id}): ${(tool.description ?? tool.name).slice(0, 1000)}`,
        parameters: Type.Unsafe<Record<string, unknown>>(schema),
        execute: async (_toolCallId, input, signal) => {
          try {
            const result = await manager.callTool(server, tool.name, input as Record<string, unknown>, signal);
            return { content: [{ type: "text", text: formatResult(result) }], details: undefined };
          } catch {
            throw new Error(`Remote MCP tool ${name} failed`);
          }
        },
      });
    }
  }
  return definitions;
}
