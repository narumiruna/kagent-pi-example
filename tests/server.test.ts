import assert from "node:assert/strict";
import { test } from "node:test";
import { CancelTaskRequest, GetTaskRequest, type StreamResponse, TaskState } from "@a2a-js/sdk";
import { A2AService } from "@a2a-js/sdk/server/grpc";
import { status } from "@grpc/grpc-js";
import { agentCard, startServer } from "../src/server.js";
import { FakePi, request, TestClient } from "./helpers.js";

const options = () => ({ grpcAddress: "127.0.0.1:0", healthHost: "127.0.0.1", healthPort: 0, card: agentCard() });

for (const mode of ["ok", "throw", "error", "retry"] as const) {
  test(`real gRPC unary: ${mode}`, { timeout: 15000 }, async (t) => {
    const pi = new FakePi();
    pi.mode = mode;
    const server = await startServer(pi, options());
    t.after(() => server.close());
    const client = new TestClient(server.grpcPort);
    t.after(() => client.close());
    const input = request("/not-a-command");
    const result = await client.unary(A2AService.sendMessage, input);
    assert.equal(result.payload?.$case, "task");
    if (result.payload?.$case !== "task") throw new Error("Expected task");
    const task = result.payload.value;
    assert.equal(task.id, input.message?.taskId);
    assert.equal(task.contextId, "instance-1");
    assert.equal(
      task.status?.state,
      mode === "throw" || mode === "error" ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED,
    );
    assert.deepEqual(pi.prompts, ["/not-a-command"]);
    assert.ok(!JSON.stringify(result).includes("secret-provider-key"));
    const stored = await client.unary(A2AService.getTask, GetTaskRequest.fromJSON({ id: task.id }));
    assert.equal(stored.status?.state, task.status?.state);
  });
}

test("A2A v0.3 JSON-RPC compatibility serves legacy kagent", { timeout: 15000 }, async (t) => {
  const pi = new FakePi();
  const server = await startServer(pi, { ...options(), httpHost: "127.0.0.1", httpPort: 0 });
  t.after(() => server.close());
  assert.ok(server.httpPort !== undefined);
  const cardResponse = await fetch(`http://127.0.0.1:${server.httpPort}/.well-known/agent-card.json`);
  assert.equal(cardResponse.status, 200);
  assert.equal(((await cardResponse.json()) as { protocolVersion?: string }).protocolVersion, "0.3");
  const response = await fetch(`http://127.0.0.1:${server.httpPort}`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "0.3" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      method: "message/send",
      params: {
        message: {
          kind: "message",
          taskId: "task-1",
          role: "user",
          parts: [{ kind: "text", text: "Hello over JSON-RPC" }],
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result?: { id?: string; status?: { state?: string } } };
  assert.equal(body.result?.id, "task-1");
  assert.equal(body.result?.status?.state, "completed");
  assert.deepEqual(pi.prompts, ["Hello over JSON-RPC"]);
});

test("streaming preserves gateway IDs and returns artifact before completion", { timeout: 15000 }, async (t) => {
  const server = await startServer(new FakePi(), options());
  t.after(() => server.close());
  const client = new TestClient(server.grpcPort);
  t.after(() => client.close());
  const input = request();
  const events: StreamResponse[] = [];
  for await (const event of client.stream(input)) events.push(event);
  assert.equal(events[0]?.payload?.$case, "task");
  const artifact = events.find((event) => event.payload?.$case === "artifactUpdate")?.payload;
  assert.equal(artifact?.$case, "artifactUpdate");
  if (artifact?.$case !== "artifactUpdate") throw new Error("Expected artifact");
  assert.equal(artifact.value.taskId, input.message?.taskId);
  assert.equal(artifact.value.artifact?.parts[0]?.content?.value, "Hello from pi");
  const terminal = events.at(-1)?.payload;
  assert.equal(terminal?.$case, "statusUpdate");
  if (terminal?.$case === "statusUpdate") assert.equal(terminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);
});

test("cancellation aborts pi; concurrent requests are rejected, not queued", { timeout: 15000 }, async (t) => {
  const pi = new FakePi();
  pi.mode = "blocked";
  const server = await startServer(pi, options());
  t.after(() => server.close());
  const client = new TestClient(server.grpcPort);
  t.after(() => client.close());
  const input = request();
  const running = client.unary(A2AService.sendMessage, input);
  await pi.started.promise;
  const other = await client.unary(A2AService.sendMessage, request("must not steer"));
  assert.equal(other.payload?.$case, "task");
  if (other.payload?.$case === "task") assert.equal(other.payload.value.status?.state, TaskState.TASK_STATE_REJECTED);
  const canceled = await client.unary(A2AService.cancelTask, CancelTaskRequest.fromJSON({ id: input.message?.taskId }));
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  const result = await running;
  if (result.payload?.$case !== "task") throw new Error("Expected task");
  assert.equal(result.payload.value.status?.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(pi.aborted, true);
  assert.equal(pi.prompts.length, 1);
});

test("invalid input never reaches pi; one runtime cannot serve another context", { timeout: 15000 }, async (t) => {
  const pi = new FakePi();
  const server = await startServer(pi, options());
  t.after(() => server.close());
  const client = new TestClient(server.grpcPort);
  t.after(() => client.close());
  for (const input of [request(" "), { ...request(), message: undefined }]) {
    await assert.rejects(client.unary(A2AService.sendMessage, input), { code: status.INVALID_ARGUMENT });
  }
  assert.equal(pi.prompts.length, 0);
  await client.unary(A2AService.sendMessage, request());
  const other = await client.unary(A2AService.sendMessage, request("leak?", "another-instance"));
  if (other.payload?.$case !== "task") throw new Error("Expected task");
  assert.equal(other.payload.value.status?.state, TaskState.TASK_STATE_REJECTED);
  assert.equal(pi.prompts.length, 1);
});

test("readiness, idempotent shutdown, and bind failure cleanup", { timeout: 15000 }, async () => {
  const server = await startServer(new FakePi(), options());
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.healthPort}/readyz`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${server.healthPort}/health`)).status, 404);
    await assert.rejects(startServer(new FakePi(), { ...options(), healthPort: server.healthPort }), {
      code: "EADDRINUSE",
    });
  } finally {
    await server.close();
    await server.close();
  }
  await assert.rejects(fetch(`http://127.0.0.1:${server.healthPort}/readyz`));
});
