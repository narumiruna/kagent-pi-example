import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContextBusyError, ContextRuntimeManager, hashContextId } from "../src/context-runtime-manager.js";
import type { ExecutionSession } from "../src/conversation.js";
import { FakePi } from "./helpers.js";

function session(): ExecutionSession {
  return Object.assign(new FakePi(), { async close() {} });
}

test("context manager hashes durable paths and serializes each context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-"));
  const created: string[] = [];
  const manager = new ContextRuntimeManager(
    root,
    async (directory) => {
      created.push(directory);
      return session();
    },
    { maxConcurrency: 2, queueTimeoutMs: 1000, idleMs: 60_000 },
  );
  t.after(() => manager.close());

  const first = await manager.acquire("context/A");
  await assert.rejects(manager.acquire("context/A"), ContextBusyError);
  await first.session.prompt("hello", { expandPromptTemplates: false });
  first.release();

  const second = await manager.acquire("context/B");
  await second.session.prompt("hello", { expandPromptTemplates: false });
  second.release();

  assert.equal(created.length, 2);
  assert.ok(created[0]?.endsWith(hashContextId("context/A")));
  assert.ok(created[1]?.endsWith(hashContextId("context/B")));
  assert.ok(!created.join("/").includes("context/A"));
  const metadataPath = join(root, "contexts", hashContextId("context/A"), "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { contextHash?: string };
  assert.equal(metadata.contextHash, hashContextId("context/A"));
});

test("context manager enforces bounded global concurrency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-context-limit-"));
  const manager = new ContextRuntimeManager(root, async () => session(), {
    maxConcurrency: 1,
    queueTimeoutMs: 1000,
    idleMs: 60_000,
  });
  t.after(() => manager.close());
  const first = await manager.acquire("one");
  let acquired = false;
  const pending = manager.acquire("two").then((lease) => {
    acquired = true;
    return lease;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acquired, false);
  first.release();
  const second = await pending;
  second.release();
});
