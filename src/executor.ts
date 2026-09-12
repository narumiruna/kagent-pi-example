import { randomUUID } from "node:crypto";
import { Artifact, Message, Part, Role, Task, TaskState } from "@a2a-js/sdk";
import { GrpcTaskNotCancelableError } from "@a2a-js/sdk/errors/grpc";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ContextLease, ContextSessionProvider } from "./context-runtime-manager.js";
import { runWithRequestIdentity } from "./integrations/identity.js";

export type PiSession = Pick<AgentSession, "prompt" | "abort" | "subscribe">;

type ActiveRun = {
  taskId: string;
  cancelled: boolean;
  done: Promise<void>;
  session: PiSession;
};

function isProvider(value: PiSession | ContextSessionProvider): value is ContextSessionProvider {
  return "acquire" in value;
}

// Each A2A context receives an independent Pi conversation. A context provider
// supplies bounded global concurrency while the executor owns task cancellation.
export class PiExecutor implements AgentExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private singleContextId?: string;
  private closing = false;

  constructor(
    private readonly sessions: PiSession | ContextSessionProvider,
    private readonly expandPromptTemplates = false,
  ) {}

  private async acquire(contextId: string): Promise<ContextLease> {
    if (isProvider(this.sessions)) return this.sessions.acquire(contextId);
    if (this.active.size || (this.singleContextId && this.singleContextId !== contextId)) {
      throw new Error("This runtime accepts one context and one active request at a time.");
    }
    this.singleContextId = contextId;
    return { session: this.sessions, release() {} };
  }

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = request;
    const parts = (text: string): Part[] => [{ ...Part.fromJSON({}), content: { $case: "text", value: text } }];
    const message = (text: string): Message => ({
      ...Message.fromJSON({}),
      messageId: randomUUID(),
      taskId,
      contextId,
      role: Role.ROLE_AGENT,
      parts: parts(text),
    });
    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          metadata: undefined,
          status: {
            state,
            timestamp: new Date().toISOString(),
            message: text ? message(text) : undefined,
          },
        }),
      );
    bus.publish(
      AgentEvent.task({
        ...Task.fromJSON({}),
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
        history: [userMessage],
      }),
    );
    if (this.closing) {
      status(TaskState.TASK_STATE_REJECTED, "The runtime is shutting down.");
      bus.finished();
      return;
    }
    let lease: ContextLease;
    try {
      lease = await this.acquire(contextId);
    } catch {
      status(TaskState.TASK_STATE_REJECTED, "This context is busy or the runtime concurrency limit was reached.");
      bus.finished();
      return;
    }
    const done = Promise.withResolvers<void>();
    const run: ActiveRun = { taskId, cancelled: false, done: done.promise, session: lease.session };
    this.active.set(taskId, run);
    let lastAssistant: { stopReason: string; text: string } | undefined;
    const unsubscribe = lease.session.subscribe((event) => {
      if (run.cancelled) return;
      if (event.type === "tool_execution_start") {
        // Tool arguments, output, and reasoning may contain secrets; do not expose them.
        status(TaskState.TASK_STATE_WORKING, `Running ${event.toolName}`);
      }
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      lastAssistant = {
        stopReason: event.message.stopReason,
        text: event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      };
      if (lastAssistant.text && ["stop", "toolUse", "length"].includes(lastAssistant.stopReason)) {
        bus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            append: false,
            lastChunk: true,
            metadata: undefined,
            artifact: {
              ...Artifact.fromJSON({}),
              artifactId: randomUUID(),
              name: "assistant",
              parts: parts(lastAssistant.text),
            },
          }),
        );
      }
    });
    try {
      status(TaskState.TASK_STATE_WORKING);
      const text = userMessage.parts
        .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
        .join("\n");
      const caller = request.context.user;
      const identity = caller?.isAuthenticated && caller.userName ? { userId: caller.userName } : undefined;
      await runWithRequestIdentity(identity, () =>
        lease.session.prompt(text, { expandPromptTemplates: this.expandPromptTemplates, source: "extension" }),
      );
      if (run.cancelled || lastAssistant?.stopReason === "aborted") {
        status(TaskState.TASK_STATE_CANCELED);
      } else if (!lastAssistant || !["stop", "toolUse"].includes(lastAssistant.stopReason)) {
        status(TaskState.TASK_STATE_FAILED, "Pi did not complete the response successfully.");
      } else {
        status(TaskState.TASK_STATE_COMPLETED, lastAssistant.text ? undefined : "Done.");
      }
    } catch {
      // Provider and integration errors may contain request bodies or credentials.
      status(
        run.cancelled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
        run.cancelled ? undefined : "Pi could not complete the request. Check runtime configuration.",
      );
    } finally {
      unsubscribe();
      this.active.delete(taskId);
      lease.release();
      bus.finished();
      done.resolve();
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) throw new GrpcTaskNotCancelableError({ message: "Task is not running." });
    run.cancelled = true;
    await run.session.abort();
    await run.done;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.all([...this.active].map(([taskId]) => this.cancelTask(taskId)));
    if (isProvider(this.sessions)) await this.sessions.close();
  }
}
