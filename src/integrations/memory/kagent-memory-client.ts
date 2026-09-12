import type { MemoryConfig } from "./config.js";

export type MemoryResult = { id: string; content: string; score: number; metadata?: unknown; createdAt?: string };

export class KagentMemoryClient {
  constructor(private readonly config: MemoryConfig) {}

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.PI_MEMORY_API_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const timeout = AbortSignal.timeout(this.config.timeoutMs);
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error("Memory API request failed");
      return await response.json();
    } catch {
      throw new Error("Kagent Memory is unavailable");
    }
  }

  async search(userId: string, vector: number[], signal?: AbortSignal): Promise<MemoryResult[]> {
    const response = (await this.post(
      "/api/memories/search",
      {
        agent_name: this.config.agentName,
        user_id: userId,
        vector,
        limit: this.config.resultLimit,
        min_score: this.config.minScore,
      },
      signal,
    )) as { memories?: unknown };
    if (!Array.isArray(response.memories)) throw new Error("Kagent Memory returned an invalid response");
    return response.memories
      .filter((item): item is MemoryResult => {
        if (!item || typeof item !== "object") return false;
        const value = item as Partial<MemoryResult>;
        return typeof value.id === "string" && typeof value.content === "string" && typeof value.score === "number";
      })
      .slice(0, this.config.resultLimit);
  }

  async save(userId: string, content: string, vector: number[], signal?: AbortSignal): Promise<string> {
    const response = (await this.post(
      "/api/memories/sessions",
      {
        agent_name: this.config.agentName,
        user_id: userId,
        content,
        vector,
        metadata: { source: "pi-explicit-tool" },
        ttl_days: this.config.ttlDays,
      },
      signal,
    )) as { id?: unknown };
    if (typeof response.id !== "string") throw new Error("Kagent Memory returned an invalid response");
    return response.id;
  }
}
