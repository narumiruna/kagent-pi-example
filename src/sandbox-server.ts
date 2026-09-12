import { spawn } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { WorkspacePolicy } from "./security/workspace-policy.js";
import { sandboxArguments } from "./tools/workspace-tools.js";

const socketPath = resolve(process.env.PI_BASH_SANDBOX_SOCKET ?? "/run/pi-sandbox/sandbox.sock");
const workspace = resolve(process.env.PI_WORKSPACE_DIR ?? "/workspace");
const policy = await WorkspacePolicy.create(workspace, ["/app/skills"]);
await mkdir(dirname(socketPath), { recursive: true });
await rm(socketPath, { force: true });

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/exec") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    let body: { command?: unknown; timeoutMs?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (typeof body.command !== "string" || body.command.length > 256_000) {
      response.writeHead(400).end();
      return;
    }
    const timeoutMs = Number(body.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", trailer: "X-Exit-Code" });
    const child = spawn("/usr/bin/bwrap", sandboxArguments(policy, body.command), {
      cwd: workspace,
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    const output = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 10 * 1024 * 1024) response.write(chunk);
      else child.kill("SIGTERM");
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    response.once("close", () => child.kill("SIGTERM"));
    child.once("error", () => {
      clearTimeout(timer);
      if (!response.destroyed) response.end();
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!response.destroyed) {
        response.addTrailers({ "X-Exit-Code": String(code ?? 1) });
        response.end();
      }
    });
  });
});
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  console.error("Pi Bash sandbox helper ready.");
});

async function shutdown() {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await rm(socketPath, { force: true });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void shutdown());
