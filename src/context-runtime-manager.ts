import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionSession } from "./conversation.js";
import { PiConversation } from "./conversation.js";
import type { PiSession } from "./executor.js";

export type ContextLease = {
  session: PiSession;
  release(): void;
};

export interface ContextSessionProvider {
  acquire(contextId: string): Promise<ContextLease>;
  close(): Promise<void>;
}

type Entry = {
  conversation: PiConversation;
  ready: Promise<void>;
  busy: boolean;
  lastUsed: number;
};

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ContextBusyError extends Error {}

export function hashContextId(contextId: string): string {
  return createHash("sha256").update(contextId, "utf8").digest("hex");
}

export class ContextRuntimeManager implements ContextSessionProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private closing = false;
  private readonly evictionTimer: NodeJS.Timeout;

  constructor(
    private readonly sessionsRoot: string,
    private readonly createSession: (contextDirectory: string) => Promise<ExecutionSession>,
    private readonly options: { maxConcurrency: number; queueTimeoutMs: number; idleMs: number },
  ) {
    this.evictionTimer = setInterval(() => this.evictIdle(), Math.min(options.idleMs, 60_000));
    this.evictionTimer.unref();
  }

  private validateContextId(contextId: string): void {
    const hasControlCharacter = [...contextId].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!contextId || contextId.length > 512 || hasControlCharacter) {
      throw new Error("Invalid A2A context ID.");
    }
  }

  private async takeGlobalSlot(): Promise<() => void> {
    if (this.active < this.options.maxConcurrency) {
      this.active += 1;
      return () => this.releaseGlobalSlot();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ContextBusyError("The runtime concurrency queue timed out."));
        }, this.options.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  private releaseGlobalSlot(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(() => this.releaseGlobalSlot());
    } else {
      this.active -= 1;
    }
  }

  async acquire(contextId: string): Promise<ContextLease> {
    if (this.closing) throw new ContextBusyError("The runtime is shutting down.");
    this.validateContextId(contextId);
    const hash = hashContextId(contextId);
    let entry = this.entries.get(hash);
    let created = false;
    if (entry?.busy) throw new ContextBusyError("This context already has an active request.");
    if (!entry) {
      const contextDirectory = join(this.sessionsRoot, "contexts", hash);
      const ready = (async () => {
        await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
        try {
          await writeFile(
            join(contextDirectory, "metadata.json"),
            `${JSON.stringify({ version: 1, contextHash: hash })}\n`,
            { encoding: "utf8", mode: 0o600, flag: "wx" },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      })();
      entry = {
        conversation: new PiConversation(() => this.createSession(contextDirectory)),
        ready,
        busy: true,
        lastUsed: Date.now(),
      };
      this.entries.set(hash, entry);
      created = true;
    } else {
      entry.busy = true;
    }
    let releaseGlobal: (() => void) | undefined;
    try {
      await entry.ready;
      releaseGlobal = await this.takeGlobalSlot();
    } catch (error) {
      entry.busy = false;
      if (created && this.entries.get(hash) === entry) this.entries.delete(hash);
      throw error;
    }
    let released = false;
    const activeEntry = entry;
    const releaseSlot = releaseGlobal;
    return {
      session: activeEntry.conversation,
      release: () => {
        if (released) return;
        released = true;
        activeEntry.busy = false;
        activeEntry.lastUsed = Date.now();
        releaseSlot();
      },
    };
  }

  private evictIdle(): void {
    const cutoff = Date.now() - this.options.idleMs;
    for (const [hash, entry] of this.entries) {
      if (!entry.busy && entry.lastUsed < cutoff) this.entries.delete(hash);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.evictionTimer);
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new ContextBusyError("The runtime is shutting down."));
    }
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.busy)
        .map((entry) => entry.conversation.abort().catch(() => undefined)),
    );
  }
}
