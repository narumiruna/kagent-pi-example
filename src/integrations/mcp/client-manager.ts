import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";

type Connection = {
  client: Client;
  close(): Promise<void>;
  lastUsed: number;
};

export class McpClientManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly evictionTimer: NodeJS.Timeout;
  private closing = false;

  constructor(
    readonly servers: readonly McpServerConfig[],
    private readonly idleMs = 300_000,
  ) {
    this.evictionTimer = setInterval(() => void this.evictIdle(), Math.min(idleMs, 60_000));
    this.evictionTimer.unref();
  }

  private headers(config: McpServerConfig): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [header, envName] of Object.entries(config.headerEnv)) {
      const value = process.env[envName];
      if (!value) throw new Error(`MCP credential environment variable is missing for ${config.id}`);
      headers[header] = value;
    }
    return headers;
  }

  private async connect(config: McpServerConfig): Promise<Connection> {
    if (this.closing) throw new Error("MCP client manager is closed");
    const headers = this.headers(config);
    const transport =
      config.transport === "streamable-http"
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
        : new SSEClientTransport(new URL(config.url), {
            eventSourceInit: {
              fetch: (url: string | URL, init?: RequestInit) => fetch(url, { ...init, headers }),
            } as never,
            requestInit: { headers },
          });
    const client = new Client({ name: "kagent-pi-mcp", version: "0.1.0" }, { capabilities: {} });
    const connection: Connection = {
      client,
      lastUsed: Date.now(),
      close: async () => {
        await client.close().catch(() => undefined);
      },
    };
    transport.onclose = () => {
      const current = this.connections.get(config.id);
      if (current) {
        void current.then((value) => value === connection && this.connections.delete(config.id)).catch(() => undefined);
      }
    };
    await withTimeout(
      client.connect(transport, { timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs }),
      config.timeoutMs,
    );
    return connection;
  }

  private async connection(config: McpServerConfig): Promise<Connection> {
    let pending = this.connections.get(config.id);
    if (!pending) {
      pending = this.connect(config);
      this.connections.set(config.id, pending);
      pending.catch(() => {
        if (this.connections.get(config.id) === pending) this.connections.delete(config.id);
      });
    }
    const connection = await pending;
    connection.lastUsed = Date.now();
    return connection;
  }

  async listTools(config: McpServerConfig): Promise<Tool[]> {
    try {
      const connection = await this.connection(config);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
          timeout: config.timeoutMs,
          maxTotalTimeout: config.timeoutMs,
        });
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);
      return tools;
    } catch {
      throw new Error(`MCP tool discovery failed for ${config.id}`);
    }
  }

  async callTool(
    config: McpServerConfig,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    try {
      const connection = await this.connection(config);
      connection.lastUsed = Date.now();
      const result = await connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
        signal,
        timeout: config.timeoutMs,
        maxTotalTimeout: config.timeoutMs,
      });
      if (!Array.isArray((result as { content?: unknown }).content)) {
        throw new Error("Task-augmented MCP tools are not supported");
      }
      return result as CallToolResult;
    } catch {
      const stale = this.connections.get(config.id);
      this.connections.delete(config.id);
      if (stale) await stale.then((connection) => connection.close()).catch(() => undefined);
      throw new Error(`MCP tool ${config.id}/${name} failed`);
    }
  }

  private async evictIdle(): Promise<void> {
    const cutoff = Date.now() - this.idleMs;
    for (const [id, pending] of this.connections) {
      const connection = await pending.catch(() => undefined);
      if (connection && connection.lastUsed < cutoff && this.connections.get(id) === pending) {
        this.connections.delete(id);
        await connection.close();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.evictionTimer);
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(async (pending) => (await pending.catch(() => undefined))?.close()));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP connection timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
