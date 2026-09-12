import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createA2AExtension } from "../extensions/a2a.js";
import { PiConversation } from "./conversation.js";
import {
  parseAbsolutePaths,
  parseEnabled,
  parseOptionalPort,
  parsePort,
  parseToolNames,
  validateJsonObject,
} from "./runtime-config.js";
import { agentCard } from "./server.js";
import { bindExecutionSession, bindHeadlessSession } from "./session-lifecycle.js";

const dataDir = resolve(process.env.PI_DATA_DIR ?? ".data");
const cwd = join(dataDir, "workspace");
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(dataDir, "agent"));
const sessionDir = join(dataDir, "sessions");
await Promise.all([cwd, agentDir, sessionDir].map((directory) => mkdir(directory, { recursive: true })));

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
const conversation = new PiConversation(async () => {
  const resourceLoader = new DefaultResourceLoader(executionResourceOptions);
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(cwd, sessionDir),
    tools,
  });
  return bindExecutionSession(session, "Pi execution extension failed");
});
const loader = new DefaultResourceLoader({
  ...resourceOptions,
  extensionFactories: [
    createA2AExtension(conversation, {
      grpcAddress: process.env.PI_GRPC_ADDRESS ?? "127.0.0.1:8080",
      healthHost: process.env.PI_HEALTH_HOST ?? "127.0.0.1",
      healthPort,
      httpHost: process.env.PI_HTTP_HOST,
      httpPort,
      expandPromptTemplates,
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
