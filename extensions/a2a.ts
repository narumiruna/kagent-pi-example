import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiSession } from "../src/executor.js";
import { type ServerOptions, startServer } from "../src/server.js";

// The SDK host supplies its durable conversation rather than a second pi process.
// Factories may load without a session, so sockets belong in session_start.
export function createA2AExtension(conversation: PiSession, options: ServerOptions): ExtensionFactory {
  return (pi) => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    pi.on("session_start", async () => {
      if (server) throw new Error("A2A server is already running.");
      server = await startServer(conversation, options);
    });
    pi.on("session_shutdown", async () => {
      const current = server;
      server = undefined;
      await current?.close();
    });
  };
}
