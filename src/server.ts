import { once } from "node:events";
import { createServer } from "node:http";
import { AgentCard } from "@a2a-js/sdk";
import { A2AService, grpcService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server, ServerCredentials } from "@grpc/grpc-js";
import { PiExecutor, type PiSession } from "./executor.js";
import { KagentRequestHandler } from "./request-handler.js";

export type ServerOptions = {
  grpcAddress: string;
  healthHost: string;
  healthPort: number;
  card: AgentCard;
};

export function agentCard(json?: string): AgentCard {
  const card = json
    ? AgentCard.fromJSON(JSON.parse(json))
    : AgentCard.fromJSON({
        name: "pi-agent",
        description: "Pi coding agent",
        version: "0.1.0",
        supportedInterfaces: [{ url: "http://127.0.0.1:80", protocolBinding: "GRPC", protocolVersion: "1.0" }],
      });
  if (
    !card.name ||
    !card.supportedInterfaces.some((item) => item.protocolBinding === "GRPC" && item.protocolVersion === "1.0")
  ) {
    throw new Error("Agent card must have a name and an A2A 1.0 GRPC interface.");
  }
  // Advertise only what this adapter actually implements.
  card.capabilities = { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [] };
  card.defaultInputModes = ["text/plain"];
  card.defaultOutputModes = ["text/plain"];
  return card;
}

export async function startServer(session: PiSession, options: ServerOptions) {
  const executor = new PiExecutor(session);
  const grpc = new Server();
  grpc.addService(
    A2AService,
    grpcService({
      requestHandler: new KagentRequestHandler(options.card, executor),
      // This is private Actor ingress. kagent owns public authentication and authorization.
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  let ready = false;
  const health = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(ready ? 200 : 503, { "content-type": "text/plain" }).end(ready ? "ready\n" : "not ready\n");
  });
  try {
    const grpcPort = await new Promise<number>((resolve, reject) => {
      grpc.bindAsync(options.grpcAddress, ServerCredentials.createInsecure(), (error, port) =>
        error ? reject(error) : resolve(port),
      );
    });
    health.listen(options.healthPort, options.healthHost);
    await once(health, "listening");
    ready = true;
    const healthAddress = health.address();
    if (!healthAddress || typeof healthAddress === "string") throw new Error("Missing readiness address.");
    let stopping: Promise<void> | undefined;
    return {
      grpcPort,
      healthPort: healthAddress.port,
      close(): Promise<void> {
        stopping ??= (async () => {
          ready = false;
          // Close stuck client connections; the host separately bounds process shutdown.
          const timeout = setTimeout(() => {
            grpc.forceShutdown();
            health.closeAllConnections();
          }, 5000);
          timeout.unref();
          try {
            await executor.close();
          } finally {
            await Promise.all([
              new Promise<void>((resolve, reject) => grpc.tryShutdown((error) => (error ? reject(error) : resolve()))),
              new Promise<void>((resolve, reject) => health.close((error) => (error ? reject(error) : resolve()))),
            ]);
            clearTimeout(timeout);
          }
        })();
        return stopping;
      },
    };
  } catch (error) {
    grpc.forceShutdown();
    health.close();
    throw error;
  }
}
