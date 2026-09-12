import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { bindHeadlessSession } from "../src/session-lifecycle.js";

type Bindings = Parameters<AgentSession["bindExtensions"]>[0];

function fakeSession(onBind?: (bindings: Bindings) => void) {
  const calls = { bind: 0, shutdown: 0, dispose: 0 };
  const session = {
    async bindExtensions(bindings: Bindings) {
      calls.bind++;
      onBind?.(bindings);
    },
    extensionRunner: {
      async emit(event: { type: string }) {
        assert.equal(event.type, "session_shutdown");
        calls.shutdown++;
      },
    },
    dispose() {
      calls.dispose++;
    },
  } as unknown as AgentSession;
  return { session, calls };
}

test("headless session lifecycle closes exactly once", async () => {
  const { session, calls } = fakeSession();
  const lifecycle = await bindHeadlessSession(session, "extension failed");
  assert.equal(lifecycle.hasFailed(), false);
  await Promise.all([lifecycle.close(), lifecycle.close()]);
  assert.deepEqual(calls, { bind: 1, shutdown: 1, dispose: 1 });
});

test("extension startup errors dispose the partially bound session", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const { session, calls } = fakeSession((bindings) => {
      bindings.onError?.({ extensionPath: "test", event: "session_start", error: "boom" });
    });
    await assert.rejects(bindHeadlessSession(session, "extension failed"), /during startup/);
    assert.deepEqual(calls, { bind: 1, shutdown: 1, dispose: 1 });
  } finally {
    console.error = originalError;
  }
});
