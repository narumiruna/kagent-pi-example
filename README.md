# Pi coding agent on kagent

A TypeScript BYO runtime using pi's SDK and an A2A gRPC pi extension. It targets this repository's `kagent.dev/v1alpha3` API, not legacy `Agent` deployments.

```mermaid
flowchart LR
    Gateway[kagent A2A gateway] -->|A2A v1 gRPC :80| Extension[pi A2A extension]
    Extension --> SDK[pi SDK session]
    SDK --> Tools[read / write / edit / bash]
    SDK --> Model[Model provider]
    SDK --> Data[DurableDir /data]
```

## Layout

- `src/index.ts`: headless SDK host, model selection, durable pi session, process shutdown.
- `extensions/a2a.ts`: starts the server on `session_start` and closes it on `session_shutdown`.
- `src/server.ts`: upstream A2A gRPC transport and HTTP readiness.
- `src/request-handler.ts`: adapts kagent-preallocated task IDs to the upstream JS request handler.
- `src/executor.ts`: maps pi execution to upstream A2A tasks, status updates, artifacts, and cancellation.
- `src/conversation.ts`: opens a fresh execution session from durable pi history for each prompt.

The extension is an SDK-injected factory, not a standalone `pi -e` extension. An in-memory pi host session owns the extension lifecycle; it never prompts the model. Requests use a separate execution session, await `session.prompt()` including retries, then dispose it. Each execution reopens the same durable conversation. This matters because restoring a Substrate golden process does not rerun `index.ts`: caching execution history in that process would retain stale context after `/data` changes.

There is no second pi process, stdin RPC bridge, TUI, or dependency on UI APIs. Importing the extension does not open sockets.

`@a2a-js/sdk` supplies the `lf.a2a.v1.A2AService` implementation and generated wire bindings corresponding to [`proto/a2a.proto`](../../proto/a2a.proto). No protobuf copy or hand-maintained task schema is added here.

## Local development

Requires Node.js 22.19+ and npm. From `samples/pi-agent/`:

```sh
npm ci --ignore-scripts
npm run format
npm run check
npm test

# Use credentials, model defaults, and thinking defaults from this checkout's
# ignored .pi/agent directory.
PI_CODING_AGENT_DIR="$PWD/.pi/agent" npm run dev
```

Local defaults bind gRPC to `127.0.0.1:8080` and readiness to `127.0.0.1:8081/readyz`. The workspace and pi session live in `.data/`, not your repository checkout. Each request resumes the most recent pi session in that directory, including after a process restart. `PI_CODING_AGENT_DIR` may point pi's credential and model-cache lookup at another directory without moving the workspace or sessions.

`npm run check` runs **Biome check and TypeScript typecheck**. `npm run format` uses **Biome format**. `npm run build && npm start` runs the compiled package.

To send a local request with `grpcurl`, run from the repository root. Supply a checkout of `googleapis` for the imports in `proto/a2a.proto`; the server does not enable reflection.

```sh
grpcurl -plaintext -H 'a2a-version: 1.0' \
  -import-path proto -import-path /path/to/googleapis -proto a2a.proto \
  -d '{"message":{"messageId":"local-message-1","contextId":"local-context","role":"ROLE_USER","parts":[{"text":"Create hello.txt containing hello."}]}}' \
  127.0.0.1:8080 lf.a2a.v1.A2AService/SendStreamingMessage
```

## Deploy with BYO Harness

Requires kagent with the BYO compiler, Substrate, a same-namespace WorkerPool, snapshot storage, and credentials for your model provider. You need permission to write Harnesses. Do not expose the runtime directly through a public Service or Ingress.

1. Build and publish the image, using this sample directory as build context:

   ```sh
   docker build -t ghcr.io/YOUR_ORG/pi-agent:demo samples/pi-agent
   docker push ghcr.io/YOUR_ORG/pi-agent:demo
   ```

2. Provision a Secret named `pi-agent-openai-codex` in namespace `kagent` from your pi OAuth credentials, using your normal secret-management workflow. Do not put credentials in the manifest or image. For a local test cluster:

   ```sh
   kubectl -n kagent create secret generic pi-agent-openai-codex \
     --from-file=auth.json=.pi/agent/auth.json
   ```

3. Set the image **digest**, WorkerPool name, and snapshot location for your installation, then render `deploy.yaml` using `envsubst`:

   ```sh
   export PI_AGENT_IMAGE='ghcr.io/YOUR_ORG/pi-agent@sha256:YOUR_64_HEX_DIGEST'
   export PI_WORKER_POOL='YOUR_WORKER_POOL'
   export PI_SNAPSHOT_LOCATION='YOUR_SNAPSHOT_STORAGE_LOCATION'
   envsubst '${PI_AGENT_IMAGE} ${PI_WORKER_POOL} ${PI_SNAPSHOT_LOCATION}' \
     < samples/pi-agent/deploy.yaml | kubectl apply -f -
   kubectl -n kagent get agenttemplate pi-agent -o yaml
   ```

   Wait for the `pi-agent` entry under `status.harnesses` to have a successful prepared revision. Admission is label-based: `AgentTemplate.spec` does not contain a Harness reference. The Harness explicitly supplies the command because Substrate does not use Docker `CMD`.

4. With your kagent CLI connection/authentication configured:

   ```sh
   kagent -n kagent create agent-instance --harness pi-agent --agent-template pi-agent
   kagent -n kagent invoke --agent-instance INSTANCE_ID --stream \
     --task 'Create hello.txt containing hello.'
   ```

The container serves A2A gRPC on port **80**, readiness on **8081**, and keeps workspace, pi conversation, and pi configuration under **`/data`**. The ModelConfig declares `chatgpt.com` as the model destination for compiled egress; OpenAI Codex OAuth token refresh also requires `auth.openai.com`, which must be allowed by the target compiler/egress policy. This sample does not declare destinations for arbitrary network commands run by the model.

## Configuration

| Environment variable | Local default | Purpose |
| --- | --- | --- |
| `PI_MODEL_PROVIDER` | `settings.json`, then `anthropic` | pi provider ID; deployment uses `openai-codex` |
| `PI_MODEL_ID` | `settings.json`, then `claude-sonnet-4-5` | pi model ID; deployment uses `gpt-5.6-sol` |
| `PI_CODING_AGENT_AUTH_JSON` | Unset | Optional Secret-injected `auth.json`; initializes the agent directory without replacing refreshed credentials |
| `PI_DATA_DIR` | `.data` | Private workspace and session root; also contains the default `agent/` directory; container uses `/data` |
| `PI_CODING_AGENT_DIR` | `<PI_DATA_DIR>/agent` | pi agent directory used for `auth.json`, `settings.json`, and `models-store.json`; set to `$PWD/.pi/agent` to reuse local pi configuration |
| `PI_GRPC_ADDRESS` | `127.0.0.1:8080` | Local bind address; container uses `0.0.0.0:80` |
| `PI_HEALTH_HOST` | `127.0.0.1` | Local readiness bind host; container uses `0.0.0.0` |
| `PI_HEALTH_PORT` | `8081` | Local readiness port; keep 8081 in Substrate |
| `KAGENT_AGENT_CARD_JSON` | Minimal sample card | Generated card supplied by kagent |

The sample deliberately **ignores `KAGENT_CONFIG_JSON`**. AgentTemplate prompts, MCP tools, skills, plugins, and model settings are not translated into pi configuration. pi uses its built-in coding prompt/tools, global settings from `PI_CODING_AGENT_DIR`, and explicit provider environment overrides. Executable extensions, skills, prompt templates, themes, project settings, and context files are not automatically loaded. Remote text is not expanded as pi slash commands.

## Semantics and limits

- One Actor serves one context and one active prompt. Overlapping requests or another context are rejected rather than becoming steering messages. A fresh runtime can accept a new context ID while resuming checkpointed pi history, as required for forks.
- Text input only. Streaming publishes working status, tool names, and completed assistant-message artifacts, **not token-by-token deltas**. Thinking and raw tool arguments/results are not published.
- Completion waits for `session.prompt()` to settle, not the first `agent_end`, so retries do not prematurely complete an A2A task. Provider failures and truncation become failed tasks; cancel calls abort pi.
- kagent owns durable public A2A task history. The upstream in-memory TaskStore is only runtime-local state, is not checkpointed separately, and grows until runtime replacement. The private pi JSONL conversation is the durable model context, not a new public session API.
- No HITL/interrupted-task continuation, reference tasks, push notifications, API-key passthrough from invocation headers, or guaranteed replay of an interrupted tool side effect. Do not use automatic retry to assume exactly-once execution of shell commands.
- The runtime has **no public authentication layer**; kagent's gateway owns authorization. Local ports are loopback-only. pi tools execute with the container's privileges and can read its credentials. Use trusted callers, scoped credentials, and Substrate isolation; do not mount a developer home directory or Docker socket.
- Tests use real local gRPC and a real pi SDK session with a mocked model endpoint. **Live model access, Substrate preparation, Node/V8 checkpoint/restore, suspend/resume, and fork are not cluster-validated by this sample's tests.** Bookworm matches the existing BYO glibc baseline but does not prove Node checkpoint compatibility.
