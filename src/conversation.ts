import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiSession } from "./executor.js";

type ExecutionSession = PiSession & { dispose(): void };

// Substrate can resume a golden process with a newer /data snapshot. Never
// cache the execution session in that process: reopen pi's JSONL each prompt.
// The separate in-memory host session only owns the A2A extension lifecycle.
export class PiConversation implements PiSession {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private pending?: Promise<ExecutionSession>;
  private aborted = false;

  constructor(private readonly createSession: () => Promise<ExecutionSession>) {}

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options?: Parameters<PiSession["prompt"]>[1]): Promise<void> {
    if (this.pending) throw new Error("A pi execution session is already active.");
    this.aborted = false;
    this.pending = this.createSession();
    let session: ExecutionSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      session = await this.pending;
      unsubscribe = session.subscribe((event) => {
        for (const listener of this.listeners) listener(event);
      });
      if (!this.aborted) await session.prompt(text, options);
    } finally {
      unsubscribe?.();
      session?.dispose();
      this.pending = undefined;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const session = await this.pending;
    await session?.abort();
  }
}
