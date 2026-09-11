import { type AgentCard, type Message, Role, type SendMessageRequest, Task, TaskState } from "@a2a-js/sdk";
import {
  GrpcContentTypeNotSupportedError,
  GrpcRequestMalformedError,
  GrpcUnsupportedOperationError,
} from "@a2a-js/sdk/errors/grpc";
import {
  type AgentExecutor,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type ServerCallContext,
} from "@a2a-js/sdk/server";

// kagent allocates the task ID before dialing its private runtime. The upstream
// JS handler normally interprets any supplied task ID as an existing task.
// Seed that upstream store at this private boundary; public history stays in kagent.
export class KagentRequestHandler extends DefaultRequestHandler {
  private readonly runtimeTasks: InMemoryTaskStore;

  constructor(card: AgentCard, executor: AgentExecutor) {
    const tasks = new InMemoryTaskStore();
    super(card, tasks, executor);
    this.runtimeTasks = tasks;
  }

  private async prepare(request: SendMessageRequest, context: ServerCallContext): Promise<void> {
    const message = request.message;
    if (!message?.messageId || !message.contextId || message.role !== Role.ROLE_USER) {
      throw new GrpcRequestMalformedError({ message: "A user message with messageId and contextId is required." });
    }
    if (!message.parts.length || message.parts.some((part) => part.content?.$case !== "text")) {
      throw new GrpcContentTypeNotSupportedError({ message: "Only text parts are supported." });
    }
    if (!message.parts.some((part) => part.content?.$case === "text" && part.content.value.trim())) {
      throw new GrpcRequestMalformedError({ message: "Message text must not be empty." });
    }
    if (
      message.referenceTaskIds.length ||
      message.metadata?.["https://kagent.dev/internal/stored-task/v1"] !== undefined
    ) {
      throw new GrpcUnsupportedOperationError({
        message: "Reference tasks and interrupted-task continuation are not supported by this sample.",
      });
    }
    const modes = request.configuration?.acceptedOutputModes;
    if (modes?.length && !modes.some((mode) => mode === "text" || mode === "text/plain")) {
      throw new GrpcContentTypeNotSupportedError({ message: "Only text output is supported." });
    }
    if (message.taskId && !(await this.runtimeTasks.load(message.taskId, context))) {
      await this.runtimeTasks.save(
        Task.fromJSON({
          id: message.taskId,
          contextId: message.contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED },
        }),
        context,
      );
    }
  }

  override async sendMessage(request: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    await this.prepare(request, context);
    return super.sendMessage(request, context);
  }

  override async *sendMessageStream(request: SendMessageRequest, context: ServerCallContext) {
    await this.prepare(request, context);
    yield* super.sendMessageStream(request, context);
  }
}
