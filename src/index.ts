import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createA2AExtension } from "../extensions/a2a.js";
import { ContextRuntimeManager } from "./context-runtime-manager.js";
import { McpClientManager } from "./integrations/mcp/client-manager.js";
import { parseMcpServers } from "./integrations/mcp/config.js";
import { createMcpTools } from "./integrations/mcp/pi-tool-adapter.js";
import { loadMemoryConfig } from "./integrations/memory/config.js";
import { EmbeddingClient } from "./integrations/memory/embedding-client.js";
import { KagentMemoryClient } from "./integrations/memory/kagent-memory-client.js";
import { createMemoryTools } from "./integrations/memory/memory-tools.js";
import {
  parseAbsolutePaths,
  parseEnabled,
  parseOptionalPort,
  parsePort,
  parsePositiveInteger,
  parseToolNames,
  validateJsonObject,
} from "./runtime-config.js";
import { agentCard } from "./server.js";
import { bindExecutionSession, bindHeadlessSession } from "./session-lifecycle.js";
import { createWorkspaceTools } from "./tools/workspace-tools.js";

const dataDir = resolve(process.env.PI_DATA_DIR ?? ".data");
const cwd = resolve(process.env.PI_WORKSPACE_DIR ?? join(dataDir, "workspace"));
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(dataDir, "agent"));
const sessionDir = join(dataDir, "sessions");
await Promise.all([cwd, agentDir, sessionDir].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
await Promise.all([agentDir, sessionDir].map((directory) => chmod(directory, 0o700)));

const authPath = join(agentDir, "auth.json");
const injectedAuth = process.env.PI_CODING_AGENT_AUTH_JSON;
const injectedSettings = process.env.PI_CODING_AGENT_SETTINGS_JSON;
delete process.env.PI_CODING_AGENT_AUTH_JSON;
delete process.env.PI_CODING_AGENT_SETTINGS_JSON;
if (injectedAuth) {
  validateJsonObject(injectedAuth, "PI_CODING_AGENT_AUTH_JSON");
  try {
    // Do not replace a checkpointed file: pi may have persisted refreshed OAuth tokens.
    await writeFile(authPath, injectedAuth, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
if (injectedSettings) {
  validateJsonObject(injectedSettings, "PI_CODING_AGENT_SETTINGS_JSON");
  // Settings are non-secret deployment configuration and remain declarative.
  await writeFile(join(agentDir, "settings.json"), injectedSettings, { encoding: "utf8", mode: 0o600 });
}

const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
settingsManager.applyOverrides({ enableInstallTelemetry: false });
const provider = process.env.PI_MODEL_PROVIDER ?? settingsManager.getDefaultProvider() ?? "anthropic";
const modelId = process.env.PI_MODEL_ID ?? settingsManager.getDefaultModel() ?? "claude-sonnet-4-5";
const modelRuntime = await ModelRuntime.create({
  authPath,
  modelsPath: null,
  modelsStorePath: join(agentDir, "models-store.json"),
  allowModelNetwork: false,
});
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`Unknown pi model: ${provider}/${modelId}`);
if (!(await modelRuntime.getAuth(model))) throw new Error(`No credentials configured for ${provider}`);

const healthPort = parsePort(process.env.PI_HEALTH_PORT, "PI_HEALTH_PORT", 8081);
const httpPort = parseOptionalPort(process.env.PI_HTTP_PORT, "PI_HTTP_PORT");
const skillPaths = parseAbsolutePaths(process.env.PI_SKILL_PATHS_JSON, "PI_SKILL_PATHS_JSON");
const extensionPaths = parseAbsolutePaths(process.env.PI_EXTENSION_PATHS_JSON, "PI_EXTENSION_PATHS_JSON");
const tools = parseToolNames(process.env.PI_TOOLS_JSON);
const expandPromptTemplates = parseEnabled(process.env.PI_EXPAND_PROMPT_TEMPLATES, "PI_EXPAND_PROMPT_TEMPLATES");
const maxConcurrency = parsePositiveInteger(process.env.PI_MAX_CONCURRENCY, "PI_MAX_CONCURRENCY", 2, 32);
const queueTimeoutMs = parsePositiveInteger(process.env.PI_QUEUE_TIMEOUT_MS, "PI_QUEUE_TIMEOUT_MS", 30_000, 600_000);
const contextIdleMs = parsePositiveInteger(process.env.PI_CONTEXT_IDLE_MS, "PI_CONTEXT_IDLE_MS", 900_000, 86_400_000);
const mcpEnabled = parseEnabled(process.env.PI_MCP_ENABLED, "PI_MCP_ENABLED");
const memoryEnabled = parseEnabled(process.env.PI_MEMORY_ENABLED, "PI_MEMORY_ENABLED");
const userHeader = process.env.PI_TRUSTED_USER_HEADER;
const tokenHeader = process.env.PI_IDENTITY_TOKEN_HEADER;
const sharedSecret = process.env.PI_IDENTITY_SHARED_SECRET;
if (
  (!userHeader && (tokenHeader || sharedSecret)) ||
  (tokenHeader && !sharedSecret) ||
  (!tokenHeader && sharedSecret)
) {
  throw new Error("Trusted identity token header and shared Secret must be configured together");
}
const identity = userHeader ? { userHeader, tokenHeader, sharedSecret } : undefined;
const resourceOptions = {
  cwd,
  agentDir,
  settingsManager,
  // A remotely editable workspace must not autoload executable extensions or project settings.
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
};
const executionResourceOptions = {
  ...resourceOptions,
  // noSkills/noExtensions disable writable global/project discovery; only
  // administrator-selected absolute paths are additive trusted resources.
  additionalSkillPaths: skillPaths,
  additionalExtensionPaths: extensionPaths,
};
const workspaceTools = await createWorkspaceTools(cwd, skillPaths);
const mcpServers = mcpEnabled ? parseMcpServers(process.env.PI_MCP_SERVERS_JSON) : [];
if (mcpEnabled && mcpServers.length === 0) throw new Error("PI_MCP_ENABLED requires at least one configured server");
const mcpManager = mcpEnabled ? new McpClientManager(mcpServers) : undefined;
const mcpTools = mcpManager ? await createMcpTools(mcpManager) : [];
const memoryTools = memoryEnabled
  ? (() => {
      const config = loadMemoryConfig();
      return createMemoryTools(new EmbeddingClient(config), new KagentMemoryClient(config));
    })()
  : [];
const customTools = [...workspaceTools, ...mcpTools, ...memoryTools];
const enabledTools = tools
  ? [...new Set([...tools, ...mcpTools, ...memoryTools].map((tool) => (typeof tool === "string" ? tool : tool.name)))]
  : undefined;
const contexts = new ContextRuntimeManager(
  sessionDir,
  async (contextDirectory) => {
    const resourceLoader = new DefaultResourceLoader(executionResourceOptions);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.continueRecent(cwd, contextDirectory),
      tools: enabledTools,
      customTools,
    });
    return bindExecutionSession(session, "Pi execution extension failed");
  },
  { maxConcurrency, queueTimeoutMs, idleMs: contextIdleMs },
);
const loader = new DefaultResourceLoader({
  ...resourceOptions,
  extensionFactories: [
    createA2AExtension(contexts, {
      grpcAddress: process.env.PI_GRPC_ADDRESS ?? "127.0.0.1:8080",
      healthHost: process.env.PI_HEALTH_HOST ?? "127.0.0.1",
      healthPort,
      httpHost: process.env.PI_HTTP_HOST,
      httpPort,
      expandPromptTemplates,
      identity,
      card: agentCard(process.env.KAGENT_AGENT_CARD_JSON),
    }),
  ],
});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error("Could not load pi extensions.");
// This host never prompts the model; its extension owns long-lived sockets.
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime,
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  noTools: "all",
});

const lifecycle = await bindHeadlessSession(session, "Pi A2A extension failed");
console.error("Pi A2A runtime ready.");

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  try {
    await lifecycle.close();
    await mcpManager?.close();
    process.exitCode = lifecycle.hasFailed() ? 1 : 0;
  } finally {
    clearTimeout(timeout);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      console.error("Pi shutdown failed.");
      process.exit(1);
    });
  });
}
