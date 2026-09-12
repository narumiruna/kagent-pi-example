import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiConversation } from "../src/conversation.js";
import { FakePi } from "./helpers.js";

class ExecutionSession extends FakePi {
  disposed = false;
  shutdownCount = 0;
  async shutdown() {
    this.shutdownCount++;
  }
  dispose() {
    this.disposed = true;
  }
}

const options = { expandPromptTemplates: false };

test("every prompt opens and disposes its execution session", async () => {
  const sessions: ExecutionSession[] = [];
  const conversation = new PiConversation(async () => {
    const session = new ExecutionSession();
    sessions.push(session);
    return session;
  });
  const events: AgentSessionEvent[] = [];
  const unsubscribe = conversation.subscribe((event) => events.push(event));
  await conversation.prompt("first", options);
  await conversation.prompt("second", options);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.prompts),
    [["first"], ["second"]],
  );
  assert.ok(sessions.every((session) => session.disposed));
  assert.ok(sessions.every((session) => session.shutdownCount === 1));
  assert.equal(events.filter((event) => event.type === "message_end").length, 2);
  unsubscribe();
});

test("cancellation during session creation prevents a model call", async () => {
  const created = Promise.withResolvers<ExecutionSession>();
  const session = new ExecutionSession();
  const conversation = new PiConversation(() => created.promise);
  const prompting = conversation.prompt("must not run", options);
  const aborting = conversation.abort();
  created.resolve(session);
  await Promise.all([prompting, aborting]);
  assert.deepEqual(session.prompts, []);
  assert.equal(session.disposed, true);
});

test("execution failures release the session and permit another prompt", async () => {
  const session = new ExecutionSession();
  session.mode = "throw";
  const conversation = new PiConversation(async () => session);
  await assert.rejects(conversation.prompt("fail", options));
  assert.equal(session.disposed, true);
  session.mode = "ok";
  await conversation.prompt("retry", options);
  assert.deepEqual(session.prompts, ["fail", "retry"]);
});
