import type { MemoryConfig } from "./config.js";

export class EmbeddingClient {
  constructor(private readonly config: MemoryConfig) {}

  async embed(input: string, signal?: AbortSignal): Promise<number[]> {
    const apiKey = process.env.PI_EMBEDDING_API_KEY;
    if (!apiKey) throw new Error("Embedding credentials are unavailable");
    for (let attempt = 1; attempt <= this.config.embeddingRetries; attempt += 1) {
      try {
        const timeout = AbortSignal.timeout(this.config.timeoutMs);
        const response = await fetch(`${this.config.embeddingUrl}/embeddings`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: this.config.embeddingModel,
            input,
            dimensions: this.config.embeddingDimensions,
            encoding_format: "float",
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) throw new Error("Embedding request failed");
        const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
        const vector = body.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length !== 768 || vector.some((value) => typeof value !== "number")) {
          throw new Error("Embedding response has the wrong dimensions");
        }
        return vector as number[];
      } catch {
        if (signal?.aborted || attempt === this.config.embeddingRetries) break;
      }
    }
    throw new Error("Embedding generation failed");
  }
}
