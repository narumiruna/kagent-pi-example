import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { AgentCard, AgentInterface } from "@a2a-js/sdk";
import type { User } from "@a2a-js/sdk/server";
import { agentCardHandler, UserBuilder as HttpUserBuilder, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { A2AService, UserBuilder as GrpcUserBuilder, grpcService } from "@a2a-js/sdk/server/grpc";
import { Server, ServerCredentials } from "@grpc/grpc-js";
import express from "express";
import type { ContextSessionProvider } from "./context-runtime-manager.js";
import { PiExecutor, type PiSession } from "./executor.js";
import { KagentRequestHandler } from "./request-handler.js";

export type ServerOptions = {
  grpcAddress: string;
  healthHost: string;
  healthPort: number;
  httpHost?: string;
  httpPort?: number;
  expandPromptTemplates?: boolean;
  card: AgentCard;
  identity?: {
    userHeader: string;
    tokenHeader?: string;
    sharedSecret?: string;
  };
};

function verifiedUser(userId: unknown, suppliedToken: unknown, identity: ServerOptions["identity"]): User | undefined {
  if (!identity || typeof userId !== "string") return undefined;
  const hasControlCharacter = [...userId].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (!userId || userId.length > 256 || hasControlCharacter) return undefined;
  if (identity.sharedSecret) {
    if (typeof suppliedToken !== "string") return undefined;
    const expected = Buffer.from(identity.sharedSecret);
    const supplied = Buffer.from(suppliedToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return undefined;
  }
  return { isAuthenticated: true, userName: userId };
}

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

export async function startServer(session: PiSession | ContextSessionProvider, options: ServerOptions) {
  const executor = new PiExecutor(session, options.expandPromptTemplates);
  const identity = options.identity;
  const grpcUserBuilder = identity
    ? async (call: { metadata: { get(name: string): Array<string | Buffer> } }) => {
        const value = (name: string) => {
          const raw = call.metadata.get(name)[0];
          return Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
        };
        return (
          verifiedUser(
            value(identity.userHeader),
            identity.tokenHeader ? value(identity.tokenHeader) : undefined,
            identity,
          ) ?? (await GrpcUserBuilder.noAuthentication())
        );
      }
    : GrpcUserBuilder.noAuthentication;
  const httpUserBuilder = identity
    ? async (request: express.Request) =>
        verifiedUser(
          request.get(identity.userHeader),
          identity.tokenHeader ? request.get(identity.tokenHeader) : undefined,
          identity,
        ) ?? (await HttpUserBuilder.noAuthentication())
    : HttpUserBuilder.noAuthentication;
  const card = AgentCard.fromJSON(AgentCard.toJSON(options.card));
  if (options.httpPort !== undefined) {
    for (const protocolVersion of ["1.0", "0.3"]) {
      if (
        !card.supportedInterfaces.some(
          (item) => item.protocolBinding === "JSONRPC" && item.protocolVersion === protocolVersion,
        )
      ) {
        card.supportedInterfaces.push(
          AgentInterface.fromJSON({
            url: `http://${options.httpHost ?? "127.0.0.1"}:${options.httpPort}`,
            protocolBinding: "JSONRPC",
            protocolVersion,
          }),
        );
      }
    }
  }
  const requestHandler = new KagentRequestHandler(card, executor);
  const grpc = new Server();
  grpc.addService(
    A2AService,
    grpcService({
      requestHandler,
      // These are private kagent ingress endpoints; kagent owns public authentication.
      userBuilder: grpcUserBuilder,
    }),
  );
  const http =
    options.httpPort === undefined
      ? undefined
      : createServer(
          express()
            .use(express.json())
            .use((request, _response, next) => {
              // kagent 0.10 may omit the v0.3 message ID; the compatibility
              // decoder requires one before DefaultRequestHandler can allocate a task.
              const body = request.body as { method?: string; params?: { message?: Record<string, unknown> } };
              const requestedVersion = request.get("a2a-version")?.trim() || "0.3";
              if (requestedVersion.startsWith("0.3") && body?.method?.startsWith("message/") && body.params?.message) {
                if (!body.params.message.messageId) body.params.message.messageId = randomUUID();
                // Preserve a gateway-provided conversation ID. Very old callers may
                // omit it, in which case isolate the request instead of sharing a
                // process-wide fallback conversation.
                if (!body.params.message.contextId) {
                  body.params.message.contextId =
                    body.params.message.taskId ?? `legacy-${body.params.message.messageId}`;
                }
              }
              next();
            })
            .use(
              "/.well-known/agent-card.json",
              agentCardHandler({ agentCardProvider: requestHandler, legacyCompat: { enabled: true } }),
            )
            .use(
              jsonRpcHandler({
                requestHandler,
                userBuilder: httpUserBuilder,
                legacyCompat: { enabled: true },
              }),
            ),
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
    if (http) http.listen(options.httpPort, options.httpHost ?? "127.0.0.1");
    await Promise.all([once(health, "listening"), ...(http ? [once(http, "listening")] : [])]);
    ready = true;
    const healthAddress = health.address();
    const httpAddress = http?.address();
    if (!healthAddress || typeof healthAddress === "string") throw new Error("Missing readiness address.");
    if (http && (!httpAddress || typeof httpAddress === "string")) throw new Error("Missing HTTP address.");
    let stopping: Promise<void> | undefined;
    return {
      grpcPort,
      healthPort: healthAddress.port,
      httpPort: httpAddress && typeof httpAddress !== "string" ? httpAddress.port : undefined,
      close(): Promise<void> {
        stopping ??= (async () => {
          ready = false;
          // Close stuck client connections; the host separately bounds process shutdown.
          const timeout = setTimeout(() => {
            grpc.forceShutdown();
            health.closeAllConnections();
            http?.closeAllConnections();
          }, 5000);
          timeout.unref();
          try {
            await executor.close();
          } finally {
            await Promise.all([
              new Promise<void>((resolve, reject) => grpc.tryShutdown((error) => (error ? reject(error) : resolve()))),
              new Promise<void>((resolve, reject) => health.close((error) => (error ? reject(error) : resolve()))),
              ...(http
                ? [new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))]
                : []),
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
    http?.close();
    throw error;
  }
}
