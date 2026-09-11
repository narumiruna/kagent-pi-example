import { randomUUID } from "node:crypto";
import { SendMessageRequest, type StreamResponse } from "@a2a-js/sdk";
import { A2AService } from "@a2a-js/sdk/server/grpc";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Client, credentials, Metadata, type MethodDefinition } from "@grpc/grpc-js";
import type { PiSession } from "../src/executor.js";

export function request(text = "Hello", contextId = "instance-1") {
  return SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), taskId: randomUUID(), contextId, role: "ROLE_USER", parts: [{ text }] },
  });
}

function metadata() {
  const headers = new Metadata();
  headers.set("a2a-version", "1.0");
  return headers;
}

export class TestClient extends Client {
  constructor(port: number) {
    super(`127.0.0.1:${port}`, credentials.createInsecure());
  }

  unary<Input, Output>(method: MethodDefinition<Input, Output>, input: Input): Promise<Output> {
    return new Promise((resolve, reject) => {
      this.makeUnaryRequest(
        method.path,
        method.requestSerialize,
        method.responseDeserialize,
        input,
        metadata(),
        { deadline: Date.now() + 10000 },
        (error, result) => {
          if (error) reject(error);
          else if (result === undefined) reject(new Error("Missing gRPC result"));
          else resolve(result);
        },
      );
    });
  }

  stream(input: SendMessageRequest) {
    const method = A2AService.sendStreamingMessage;
    return this.makeServerStreamRequest<SendMessageRequest, StreamResponse>(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      input,
      metadata(),
      { deadline: Date.now() + 10000 },
    );
  }
}

export class FakePi implements PiSession {
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  prompts: string[] = [];
  started = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
  mode: "ok" | "throw" | "error" | "blocked" | "retry" = "ok";
  aborted = false;

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private assistant(text: string, stopReason: "stop" | "error" | "aborted") {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
        api: "openai-completions",
        model: "fake",
        provider: "fake",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
  }

  async prompt(text: string, options?: Parameters<PiSession["prompt"]>[1]) {
    if (options?.expandPromptTemplates !== false) throw new Error("Remote slash commands must not expand");
    this.prompts.push(text);
    this.started.resolve();
    if (this.mode === "blocked") await this.release.promise;
    if (this.mode === "throw") throw new Error("secret-provider-key");
    if (this.mode === "retry") {
      this.assistant("", "error");
      this.emit({ type: "agent_end", messages: [], willRetry: true });
    }
    this.assistant("Hello from pi", this.aborted ? "aborted" : this.mode === "error" ? "error" : "stop");
  }

  async abort() {
    this.aborted = true;
    this.release.resolve();
  }
}
