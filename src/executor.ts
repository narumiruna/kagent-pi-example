import { randomUUID } from "node:crypto";
import { Artifact, Message, Part, Role, Task, TaskState } from "@a2a-js/sdk";
import { GrpcTaskNotCancelableError } from "@a2a-js/sdk/errors/grpc";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type PiSession = Pick<AgentSession, "prompt" | "abort" | "subscribe">;

type ActiveRun = {
  taskId: string;
  cancelled: boolean;
  done: Promise<void>;
};

// One Actor owns one pi conversation. Parallel prompts must never become pi
// steering messages, since they would mix otherwise independent A2A tasks.
export class PiExecutor implements AgentExecutor {
  private active?: ActiveRun;
  private contextId?: string;
  private closing = false;

  constructor(private readonly session: PiSession) {}

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
    if (this.closing || this.active || (this.contextId && this.contextId !== contextId)) {
      status(TaskState.TASK_STATE_REJECTED, "This runtime accepts one context and one active request at a time.");
      bus.finished();
      return;
    }
    this.contextId = contextId;
    const done = Promise.withResolvers<void>();
    const run: ActiveRun = { taskId, cancelled: false, done: done.promise };
    this.active = run;
    let lastAssistant: { stopReason: string; text: string } | undefined;
    const unsubscribe = this.session.subscribe((event) => {
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
      await this.session.prompt(text, { expandPromptTemplates: false, source: "extension" });
      if (run.cancelled || lastAssistant?.stopReason === "aborted") {
        status(TaskState.TASK_STATE_CANCELED);
      } else if (!lastAssistant || !["stop", "toolUse"].includes(lastAssistant.stopReason)) {
        status(TaskState.TASK_STATE_FAILED, "Pi did not complete the response successfully.");
      } else {
        status(TaskState.TASK_STATE_COMPLETED, lastAssistant.text || "Done.");
      }
    } catch {
      // Provider errors may contain request bodies or credentials. Return a safe failure.
      status(
        run.cancelled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED,
        run.cancelled ? undefined : "Pi could not complete the request. Check provider configuration.",
      );
    } finally {
      unsubscribe();
      this.active = undefined;
      bus.finished();
      done.resolve();
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const run = this.active;
    if (!run || run.taskId !== taskId) throw new GrpcTaskNotCancelableError({ message: "Task is not running." });
    run.cancelled = true;
    await this.session.abort();
    await run.done;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.active) await this.cancelTask(this.active.taskId);
  }
}
