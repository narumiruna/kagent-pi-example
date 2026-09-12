import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspacePolicy } from "../src/security/workspace-policy.js";

test("workspace policy blocks traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-policy-"));
  const workspace = join(root, "workspace");
  const skills = join(root, "skills");
  const secret = join(root, "secret.txt");
  await Promise.all([mkdir(workspace), mkdir(skills), writeFile(secret, "secret")]);
  await writeFile(join(workspace, "ok.txt"), "ok");
  await writeFile(join(skills, "SKILL.md"), "reviewed");
  await symlink(secret, join(workspace, "escape"));
  await symlink(root, join(workspace, "escape-dir"));
  const policy = await WorkspacePolicy.create(workspace, [skills]);

  assert.equal(await policy.readPath("ok.txt"), join(workspace, "ok.txt"));
  assert.equal(await policy.readPath(join(skills, "SKILL.md")), join(skills, "SKILL.md"));
  await assert.rejects(policy.readPath("../secret.txt"), /outside/);
  await assert.rejects(policy.readPath("escape"), /outside/);
  await assert.rejects(policy.writePath(join(skills, "new.txt")), /restricted/);
  await assert.rejects(policy.writePath("escape"), /symlink/);
  await assert.rejects(policy.writePath("escape-dir/new.txt"), /symlink/);
  assert.equal(await policy.writePath("new/child.txt"), join(workspace, "new/child.txt"));
});
