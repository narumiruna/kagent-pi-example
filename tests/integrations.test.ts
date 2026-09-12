import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithRequestIdentity } from "../src/integrations/identity.js";
import { parseMcpServers, toolAllowed } from "../src/integrations/mcp/config.js";
import { normalizeMcpToolName } from "../src/integrations/mcp/pi-tool-adapter.js";
import { createMemoryTools } from "../src/integrations/memory/memory-tools.js";

test("MCP configuration requires non-secret URLs and explicit allowlists", () => {
  const [server] = parseMcpServers(
    JSON.stringify([
      {
        id: "cluster",
        transport: "streamable-http",
        url: "https://mcp.internal/mcp",
        allowedTools: ["get_*"],
        headerEnv: { authorization: "PI_MCP_CLUSTER_TOKEN" },
      },
    ]),
  );
  assert.ok(server);
  assert.equal(toolAllowed("get_pods", server.allowedTools), true);
  assert.equal(toolAllowed("delete_pods", server.allowedTools), false);
  assert.equal(normalizeMcpToolName("cluster", "Get Pods"), "mcp_cluster_get_pods");
  assert.throws(
    () =>
      parseMcpServers(
        JSON.stringify([{ id: "bad", transport: "sse", url: "https://token@example.test", allowedTools: ["*"] }]),
      ),
    /inline credentials/,
  );
});

test("Memory tools require verified per-request identity", async () => {
  const calls: string[] = [];
  const embedding = {
    async embed() {
      return Array.from({ length: 768 }, () => 0);
    },
  };
  const memory = {
    async search(userId: string) {
      calls.push(userId);
      return [{ id: "m1", content: "untrusted fact", score: 0.9 }];
    },
    async save(userId: string) {
      calls.push(userId);
      return "m2";
    },
  };
  const [load, save] = createMemoryTools(embedding as never, memory as never);
  assert.ok(load && save);
  const anonymous = await load.execute("load", { query: "q" }, undefined, undefined, {} as never);
  assert.match((anonymous.content[0] as { text: string }).text, /no verified user/);
  await runWithRequestIdentity({ userId: "alice" }, () =>
    load.execute("load", { query: "q" }, undefined, undefined, {} as never),
  );
  await runWithRequestIdentity({ userId: "bob" }, () =>
    save.execute("save", { content: "fact" }, undefined, undefined, {} as never),
  );
  assert.deepEqual(calls, ["alice", "bob"]);
});
