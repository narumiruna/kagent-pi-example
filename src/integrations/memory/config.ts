import { parsePositiveInteger } from "../../runtime-config.js";

export type MemoryConfig = {
  baseUrl: string;
  agentName: string;
  timeoutMs: number;
  ttlDays: number;
  resultLimit: number;
  minScore: number;
  embeddingUrl: string;
  embeddingModel: string;
  embeddingDimensions: 768;
  embeddingRetries: number;
};

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when PI_MEMORY_ENABLED=true`);
    return value;
  };
  const baseUrl = new URL(required("PI_MEMORY_URL"));
  const embeddingUrl = new URL(required("PI_EMBEDDING_BASE_URL"));
  if (!["http:", "https:"].includes(baseUrl.protocol) || !["http:", "https:"].includes(embeddingUrl.protocol)) {
    throw new Error("Memory and embedding URLs must use HTTP(S)");
  }
  const minScore = env.PI_MEMORY_MIN_SCORE === undefined ? 0.5 : Number(env.PI_MEMORY_MIN_SCORE);
  if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1)
    throw new Error("PI_MEMORY_MIN_SCORE must be from -1 to 1");
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    agentName: required("PI_MEMORY_AGENT_NAME"),
    timeoutMs: parsePositiveInteger(env.PI_MEMORY_TIMEOUT_MS, "PI_MEMORY_TIMEOUT_MS", 10_000, 120_000),
    ttlDays: parsePositiveInteger(env.PI_MEMORY_TTL_DAYS, "PI_MEMORY_TTL_DAYS", 15, 3650),
    resultLimit: parsePositiveInteger(env.PI_MEMORY_RESULT_LIMIT, "PI_MEMORY_RESULT_LIMIT", 5, 50),
    minScore,
    embeddingUrl: embeddingUrl.toString().replace(/\/$/, ""),
    embeddingModel: required("PI_EMBEDDING_MODEL"),
    embeddingDimensions: 768,
    embeddingRetries: parsePositiveInteger(env.PI_EMBEDDING_RETRIES, "PI_EMBEDDING_RETRIES", 2, 3),
  };
}
