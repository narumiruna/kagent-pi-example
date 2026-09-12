import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { extname } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { WorkspacePolicy } from "../security/workspace-policy.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function definition(tool: unknown): ToolDefinition {
  return tool as ToolDefinition;
}

export function sandboxArguments(policy: WorkspacePolicy, command: string): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
    "--ro-bind",
    "/app",
    "/app",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/data",
    "--bind",
    policy.workspaceRoot,
    policy.workspaceRoot,
  ];
  for (const root of policy.readOnlyRoots) {
    if (!root.startsWith("/app/")) throw new Error("Bash trusted read roots must be image-baked under /app.");
  }
  args.push(
    "--chdir",
    policy.workspaceRoot,
    "--setenv",
    "HOME",
    policy.workspaceRoot,
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--",
    "/bin/bash",
    "-lc",
    command,
  );
  return args;
}

export async function createWorkspaceTools(
  workspaceRoot: string,
  trustedReadRoots: readonly string[],
): Promise<ToolDefinition[]> {
  const policy = await WorkspacePolicy.create(workspaceRoot, trustedReadRoots);

  const read = createReadTool(workspaceRoot, {
    operations: {
      access: (path) => policy.assertReadable(path),
      readFile: async (path) => readFile(await policy.readPath(path)),
      detectImageMimeType: async (path) => IMAGE_MIME_TYPES[extname(await policy.readPath(path)).toLowerCase()],
    },
  });
  const write = createWriteTool(workspaceRoot, {
    operations: {
      mkdir: async (path) => mkdir(await policy.writePath(path), { recursive: true }).then(() => undefined),
      writeFile: async (path, content) => writeFile(await policy.writePath(path), content),
    },
  });
  const edit = createEditTool(workspaceRoot, {
    operations: {
      access: async (path) => access(await policy.writePath(path)),
      readFile: async (path) => readFile(await policy.readPath(path)),
      writeFile: async (path, content) => writeFile(await policy.writePath(path), content),
    },
  });
  const grepBase = createGrepTool(workspaceRoot, {
    operations: {
      isDirectory: async (path) => (await stat(await policy.readPath(path))).isDirectory(),
      readFile: async (path) => readFile(await policy.readPath(path), "utf8"),
    },
  });
  const grepExecute = grepBase.execute.bind(grepBase);
  const grep = {
    ...grepBase,
    execute: async (...args: Parameters<typeof grepExecute>) => {
      const input = args[1];
      input.path = await policy.readPath(input.path ?? workspaceRoot);
      return grepExecute(...args);
    },
  };
  const findBase = createFindTool(workspaceRoot);
  const findExecute = findBase.execute.bind(findBase);
  const find = {
    ...findBase,
    execute: async (...args: Parameters<typeof findExecute>) => {
      const input = args[1];
      input.path = await policy.readPath(input.path ?? workspaceRoot);
      return findExecute(...args);
    },
  };
  const ls = createLsTool(workspaceRoot, {
    operations: {
      exists: async (path) => {
        try {
          await policy.readPath(path);
          return true;
        } catch {
          return false;
        }
      },
      stat: async (path) => stat(await policy.readPath(path)),
      readdir: async (path) => readdir(await policy.readPath(path)),
    },
  });
  const bash = createBashTool(workspaceRoot, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (command, cwd, options) => {
        const canonicalCwd = await policy.readPath(cwd);
        if (canonicalCwd !== policy.workspaceRoot && !canonicalCwd.startsWith(`${policy.workspaceRoot}/`)) {
          throw new Error("Shell working directory is outside the workspace.");
        }
        const socketPath = process.env.PI_BASH_SANDBOX_SOCKET;
        if (socketPath) {
          return new Promise((resolve, reject) => {
            const request = httpRequest(
              { socketPath, path: "/exec", method: "POST", headers: { "content-type": "application/json" } },
              (response) => {
                if (response.statusCode !== 200) {
                  response.resume();
                  reject(new Error("Sandbox helper rejected the command"));
                  return;
                }
                response.on("data", options.onData);
                response.once("end", () => resolve({ exitCode: Number(response.trailers["x-exit-code"] ?? 1) }));
              },
            );
            request.once("error", () => reject(new Error("Sandbox helper is unavailable")));
            const abort = () => request.destroy(new Error("Operation aborted"));
            options.signal?.addEventListener("abort", abort, { once: true });
            request.once("close", () => options.signal?.removeEventListener("abort", abort));
            request.end(JSON.stringify({ command, timeoutMs: Math.max(1, options.timeout ?? 120_000) }));
          });
        }
        await access("/usr/bin/bwrap");
        return new Promise((resolve, reject) => {
          const child = spawn("/usr/bin/bwrap", sandboxArguments(policy, command), {
            cwd: policy.workspaceRoot,
            env: {},
            stdio: ["ignore", "pipe", "pipe"],
          });
          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            callback();
          };
          const stop = () => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1000).unref();
          };
          const abort = () => {
            stop();
            finish(() => reject(new Error("Operation aborted")));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          child.stdout.on("data", options.onData);
          child.stderr.on("data", options.onData);
          child.once("error", (error) => finish(() => reject(new Error(`Sandbox failed to start: ${error.message}`))));
          child.once("close", (exitCode) => finish(() => resolve({ exitCode })));
          const timeoutMs = Math.max(1, options.timeout ?? 120_000);
          const timer = setTimeout(() => {
            stop();
            finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)));
          }, timeoutMs);
          timer.unref();
        });
      },
    },
  });

  return [read, write, edit, bash, grep, find, ls].map(definition);
}
