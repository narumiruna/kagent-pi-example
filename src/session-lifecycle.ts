import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionSession } from "./conversation.js";

export type SessionLifecycle = {
  hasFailed(): boolean;
  close(): Promise<void>;
};

async function disposeSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

export async function bindHeadlessSession(session: AgentSession, label: string): Promise<SessionLifecycle> {
  let failed = false;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= disposeSession(session));
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        failed = true;
        console.error(`${label}: ${error.event ?? "unknown event"}`);
      },
    });
    if (failed) throw new Error(`${label} during startup.`);
  } catch (error) {
    await close();
    throw error;
  }
  return { hasFailed: () => failed, close };
}

export async function bindExecutionSession(session: AgentSession, label: string): Promise<ExecutionSession> {
  const lifecycle = await bindHeadlessSession(session, label);
  return {
    prompt: session.prompt.bind(session),
    abort: session.abort.bind(session),
    subscribe: session.subscribe.bind(session),
    close: lifecycle.close,
  };
}
