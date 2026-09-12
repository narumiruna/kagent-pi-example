import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export class WorkspacePolicy {
  private constructor(
    readonly workspaceRoot: string,
    readonly readOnlyRoots: readonly string[],
  ) {}

  static async create(workspaceRoot: string, readOnlyRoots: readonly string[] = []): Promise<WorkspacePolicy> {
    const workspace = await realpath(workspaceRoot);
    const readOnly = await Promise.all(readOnlyRoots.map((root) => realpath(root)));
    return new WorkspacePolicy(
      workspace,
      [...new Set(readOnly)].filter((root) => root !== workspace),
    );
  }

  resolveInput(path: string): string {
    return resolve(this.workspaceRoot, path);
  }

  async readPath(path: string): Promise<string> {
    const canonical = await realpath(this.resolveInput(path));
    if (![this.workspaceRoot, ...this.readOnlyRoots].some((root) => isWithin(root, canonical))) {
      throw new Error("Tool path is outside the workspace and trusted read-only roots.");
    }
    return canonical;
  }

  async writePath(path: string): Promise<string> {
    const target = this.resolveInput(path);
    if (!isWithin(this.workspaceRoot, target)) throw new Error("Tool writes are restricted to the workspace.");
    const existing = await nearestExisting(target);
    const canonicalExisting = await realpath(existing);
    if (!isWithin(this.workspaceRoot, canonicalExisting)) {
      throw new Error("Tool writes cannot traverse a symlink outside the workspace.");
    }
    if (existing === target) {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Tool writes through symlinks are not allowed.");
    }
    return target;
  }

  async assertReadable(path: string): Promise<void> {
    await access(await this.readPath(path));
  }
}
