import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskState } from "@a2a-js/sdk";
import { A2AService } from "@a2a-js/sdk/server/grpc";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createA2AExtension } from "../extensions/a2a.js";
import { PiConversation } from "../src/conversation.js";
import { agentCard } from "../src/server.js";
import { bindExecutionSession } from "../src/session-lifecycle.js";
import { request, TestClient } from "./helpers.js";

async function freePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("pi extension serves gRPC and resumes its real pi session after replacement", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kagent-pi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const agentDir = join(directory, "agent");
  const sessionDir = join(directory, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)));
  const requests: string[] = [];
  const modelServer = createHttpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    requests.push(body);
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "chat-1", object: "chat.completion.chunk", created: 0, model: "mock-model" };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Remembered." }, finish_reason: null }] })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  t.after(() => new Promise<void>((resolve) => modelServer.close(() => resolve())));
  const address = modelServer.address();
  assert.ok(address && typeof address !== "string");
  const grpcPort = await freePort();
  const healthPort = await freePort();
  let savedSessionFile: string | undefined;

  for (let turn = 0; turn < 2; turn++) {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    runtime.registerProvider("test-provider", {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-only",
      models: [
        {
          id: "mock-model",
          name: "Mock",
          input: ["text"],
          reasoning: false,
          contextWindow: 10000,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const model = runtime.getModel("test-provider", "mock-model");
    assert.ok(model);
    let session: AgentSession;
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
      enableInstallTelemetry: false,
    });
    const resourceOptions = {
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    };
    let executionCount = 0;
    let executionSessionFile: string | undefined;
    const conversation = new PiConversation(async () => {
      executionCount++;
      const resourceLoader = new DefaultResourceLoader(resourceOptions);
      await resourceLoader.reload();
      const { session: execution } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime: runtime,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.continueRecent(cwd, sessionDir),
        noTools: "all",
      });
      executionSessionFile = execution.sessionFile;
      return bindExecutionSession(execution, "test execution extension failed");
    });
    const loader = new DefaultResourceLoader({
      ...resourceOptions,
      extensionFactories: [
        createA2AExtension(conversation, {
          grpcAddress: `127.0.0.1:${grpcPort}`,
          healthHost: "127.0.0.1",
          healthPort,
          card: agentCard(),
        }),
      ],
    });
    await loader.reload();
    // Merely loading an extension must not open sockets.
    await assert.rejects(fetch(`http://127.0.0.1:${healthPort}/readyz`));
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: runtime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    const client = new TestClient(grpcPort);
    try {
      assert.deepEqual(errors, []);
      assert.equal((await fetch(`http://127.0.0.1:${healthPort}/readyz`)).status, 200);
      assert.equal(executionCount, 0, "No execution state may be cached in the golden host");
      // A fork may have a new public context ID but inherits the private pi conversation.
      const response = await client.unary(
        A2AService.sendMessage,
        request(turn === 0 ? "Remember the word kebab." : "What word did I give you?", `instance-${turn}`),
      );
      assert.equal(response.payload?.$case, "task");
      if (response.payload?.$case !== "task") throw new Error("Expected task");
      assert.equal(response.payload.value.status?.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(executionCount, 1);
      if (turn === 1) assert.equal(executionSessionFile, savedSessionFile);
      savedSessionFile = executionSessionFile;
      assert.ok(savedSessionFile);
      assert.ok((await readFile(savedSessionFile, "utf8")).includes("Remember the word kebab."));
      if (turn === 0) {
        await client.unary(A2AService.sendMessage, request("Also remember falafel.", `instance-${turn}`));
        assert.equal(executionCount, 2, "Even warm requests reopen their private state");
        assert.equal(executionSessionFile, savedSessionFile);
      }
    } finally {
      client.close();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    assert.deepEqual(errors, []);
    await assert.rejects(fetch(`http://127.0.0.1:${healthPort}/readyz`));
  }
  assert.equal(requests.length, 3);
  assert.ok(requests[2]?.includes("Remember the word kebab."));
  assert.ok(requests[2]?.includes("Also remember falafel."));
  assert.ok(requests[2]?.includes("What word did I give you?"));
});
