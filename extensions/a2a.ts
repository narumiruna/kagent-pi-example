import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ContextSessionProvider } from "../src/context-runtime-manager.js";
import type { PiSession } from "../src/executor.js";
import { type ServerOptions, startServer } from "../src/server.js";

// The SDK host supplies its durable conversation rather than a second pi process.
// Factories may load without a session, so sockets belong in session_start.
export function createA2AExtension(
  conversation: PiSession | ContextSessionProvider,
  options: ServerOptions,
): ExtensionFactory {
  return (pi) => {
    let server: ReturnType<typeof startServer> | undefined;
    pi.on("session_start", async () => {
      if (server) throw new Error("A2A server is already starting or running.");
      const starting = startServer(conversation, options);
      server = starting;
      try {
        await starting;
      } catch (error) {
        if (server === starting) server = undefined;
        throw error;
      }
    });
    pi.on("session_shutdown", async () => {
      const current = server;
      server = undefined;
      if (current) await (await current).close();
    });
  };
}
