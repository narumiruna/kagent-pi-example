# Pi BYO runtime implementation plan

## Objectives

Implement these capabilities in order:

1. Restrict local tools to the workspace while keeping reviewed skills readable.
2. Give each A2A context an independent durable Pi conversation.
3. Integrate explicitly configured kagent MCP tools and kagent long-term Memory.

The order is intentional. MCP and Memory increase the amount of external and user-scoped data available to the model, so they must not be added before filesystem and session isolation are reliable.

## Implementation status

Completed on 2026-09-12. The runtime now has canonical workspace tools, a credential-free Bubblewrap sidecar, non-root/read-only deployment hardening, hashed durable context sessions, bounded concurrency, and feature-flagged MCP/Memory adapters. The docker-desktop kagent 0.10.1 database was logically backed up, moved to digest-pinned pgvector PostgreSQL, migrated, and verified (`vector`, `memory`, and HTTP 200 Memories list). MCP and Memory remain disabled in deployment defaults until destination-specific endpoints and Secrets are configured.

## Baseline state (before implementation)

- The execution workspace is `/data/workspace`.
- Pi credentials and settings are under `/data/agent`.
- Pi conversation files are under `/data/sessions`.
- `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` are enabled.
- Reviewed image-baked skills are loaded from `/app/skills`.
- Project-local skills and extensions are not auto-discovered.
- Legacy A2A v0.3 requests are currently normalized to `legacy-default`, so all kagent UI sessions share one Pi conversation.
- Pi conversation history is durable, but kagent long-term Memory is not integrated.
- kagent 0.10.1 BYO Agents do not automatically translate declarative MCP or Memory configuration into the custom Pi runtime.

## Target architecture

```text
kagent A2A gateway
        |
        v
A2A request validation
        |
        v
ContextRuntimeManager ------------------------------+
  |                                                  |
  +-- context A -> /data/sessions/contexts/<hash-A>  |
  +-- context B -> /data/sessions/contexts/<hash-B>  |
  |                                                  |
  +-- bounded per-context execution                  |
        |                                            |
        v                                            |
Pi execution session                                 |
  |                                                  |
  +-- workspace-scoped local tools                   |
  +-- reviewed read-only skills                      |
  +-- configured MCP tool adapters ------------------+
  +-- user-scoped Memory prefetch/save/search
```

## Cross-cutting invariants

The following invariants apply to every phase:

- Model-authentication files must never be visible to local tools, MCP servers, tool output, logs, or A2A artifacts.
- Untrusted files under `/data/workspace` must never become executable Pi extensions, skills, settings, or prompt templates.
- A context must never read another context's Pi conversation.
- A user's kagent memories must never be queried or stored under another user's identity.
- Tool and Memory failures must return sanitized errors without provider payloads or credentials.
- Every network integration must have explicit destinations, timeouts, cancellation, output limits, and credentials.
- Features are deployed by OCI digest and can be disabled independently.

---

# Phase 1: restrict tools to the workspace

## 1.1 Define the access policy

Use two classes of filesystem roots:

| Root | Access |
| --- | --- |
| `/data/workspace` | Read/write for selected local tools |
| `/app/skills` and other administrator-selected skill roots | Read-only |
| `/data/agent`, `/data/sessions`, Kubernetes token mounts, `/proc` for the host process | Never accessible to tools |

The policy must apply to absolute paths, relative paths, symlinks, hard links where relevant, and paths that do not exist yet.

## 1.2 Replace unrestricted file-tool operations

Add modules similar to:

```text
src/security/workspace-policy.ts
src/tools/workspace-file-operations.ts
src/tools/workspace-tools.ts
```

Implementation tasks:

1. Resolve every relative path against the configured workspace root.
2. For reads, canonicalize the final path with `realpath` and require it to remain under an allowed read root.
3. For new write targets, canonicalize the nearest existing parent before creating the file.
4. For writes and edits, allow only the workspace root; skill roots remain read-only.
5. Reject traversal through a workspace symlink that points to `/data/agent`, `/data/sessions`, `/proc`, `/sys`, a service-account mount, or any other external path.
6. Re-check the canonical target inside the per-file mutation queue to reduce time-of-check/time-of-use races.
7. Build `read`, `write`, `edit`, `grep`, `find`, and `ls` with explicit operations rather than relying on unrestricted defaults.
8. Keep existing output truncation limits: 50 KB or 2,000 lines.

A `tool_call` event that checks path strings is useful as defense in depth, but it is not the security boundary.

## 1.3 Sandbox `bash`

Command-string filtering is not a safe shell sandbox. Replace or wrap the Bash tool so each command executes in a separate OS-level sandbox, preferably Bubblewrap on the current Debian image.

Proposed sandbox properties:

- Bind `/data/workspace` as the only writable persistent path.
- Bind reviewed skill directories read-only when skill helper scripts need them.
- Mount only the runtime binaries and libraries required by approved commands.
- Use a private PID namespace and private `/proc` so the command cannot inspect the Pi host process or its environment.
- Clear the environment, then add only an explicit allowlist such as `PATH`, `HOME`, `LANG`, and safe task metadata.
- Set `HOME` to a directory inside the sandbox, not `/data`.
- Do not mount `/data/agent`, `/data/sessions`, Kubernetes service-account tokens, or `/config`.
- Disable network by default. Networked work should use explicit MCP tools rather than arbitrary shell egress.
- Apply execution timeout, process-tree termination, CPU/memory limits, and output truncation.

Container changes:

- Install and pin the selected sandbox runtime.
- Run the Pi host as a non-root user.
- Use `readOnlyRootFilesystem` where compatible.
- Drop Linux capabilities and disable privilege escalation.
- Give `/data/workspace` and required writable directories explicit ownership.

If Bubblewrap is unavailable in the target runtime, disable `bash` rather than silently running it unrestricted.

## 1.4 Protect extension and skill loading

Retain the current fail-closed resource policy:

- `noExtensions: true`
- `noSkills: true`
- `noPromptTemplates: true`
- `noContextFiles: true`
- Load only administrator-selected absolute skill and extension paths.

Additionally:

- Verify trusted resource paths at startup.
- Refuse paths located under the writable workspace or agent/session directories.
- Mount externally managed skills and extensions read-only.
- Record only resource names and trusted source paths in startup diagnostics; do not expose file contents.

## 1.5 Phase 1 tests

Add unit and container-level adversarial tests for:

- `../agent/auth.json`
- `/data/agent/auth.json`
- A workspace symlink pointing to `/data/agent/auth.json`
- A nested symlink introduced between validation and mutation
- New-file creation through an external symlinked parent
- `bash -c 'cat /data/agent/auth.json'`
- Reading `/proc/1/environ` and the host Pi process environment
- Accessing Kubernetes token mounts
- Writing into `/app/skills`
- Network access from Bash
- Reading a valid skill and modifying a valid workspace file
- Cancellation and timeout of a shell process tree

### Phase 1 acceptance criteria

- Valid workspace coding tasks still pass.
- Skills remain readable but immutable.
- No enabled local tool can read model credentials, session files, or service-account tokens.
- Bash has no arbitrary network access.
- Sandbox startup failure causes the Bash tool to fail closed.

---

# Phase 2: independent Pi sessions per A2A context

## 2.1 Stop overwriting valid context IDs

Change the legacy HTTP compatibility middleware so it:

- Generates `messageId` only when legacy kagent omits it.
- Preserves a supplied `contextId` from the kagent UI.
- Uses `legacy-default` only when a legacy CLI caller supplies no context ID.
- Continues to preserve all IDs for A2A v1 requests.

## 2.2 Introduce `ContextRuntimeManager`

Replace the single global `PiConversation`/fixed-context model with a context router, for example:

```text
src/contexts/context-id.ts
src/contexts/context-runtime.ts
src/contexts/context-runtime-manager.ts
```

Responsibilities:

1. Validate context IDs and reject oversized or malformed values.
2. Derive a filesystem-safe key using SHA-256 rather than putting raw context IDs into paths.
3. Store sessions under:

   ```text
   /data/sessions/contexts/<sha256(contextId)>
   ```

4. Create each execution session with `SessionManager.continueRecent()` scoped to that context directory.
5. Keep `/data/workspace` shared unless a later product requirement calls for per-context workspaces.
6. Permit only one active prompt per context.
7. Allow different contexts to run concurrently up to a configurable global limit.
8. Maintain `taskId -> active execution` state for cancellation.
9. Evict idle in-memory context handles without deleting durable session files.
10. Bound the number of active/idle handles to prevent unbounded memory growth.

Because the current `PiConversation` deliberately reopens JSONL state for each prompt, the manager should preserve that behavior. The registry coordinates identity and locking; it must not keep stale Pi session state across Substrate restore.

## 2.3 Refactor executor ownership

Refactor `PiExecutor` so a request resolves its conversation from `contextId` instead of owning one global conversation.

Suggested interface:

```ts
interface ContextConversationRouter {
  execute(input: {
    contextId: string;
    taskId: string;
    text: string;
    signal: AbortSignal;
    onEvent: (event: AgentSessionEvent) => void;
  }): Promise<void>;

  cancel(taskId: string): Promise<void>;
  close(): Promise<void>;
}
```

Keep A2A task/status/artifact conversion in `PiExecutor`; keep Pi session selection and lifecycle in the context manager.

## 2.4 Migration strategy

Existing conversation history currently lives in the shared session directory.

- Back up the `pi-agent-data` PVC before rollout.
- Reserve the existing history for `legacy-default` so CLI continuity is preserved.
- New UI context IDs start in their own directories.
- Do not copy shared historical data into every new context; that would perpetuate cross-session leakage.
- Document an optional one-time command for intentionally moving the old history to a selected context.

## 2.5 Phase 2 tests

Add tests covering:

- Context A remembers a value; context B cannot see it.
- Context A resumes its own value after another request and after process restart.
- Two requests in the same context are rejected or serialized according to the chosen policy.
- Two different contexts can run concurrently within the global limit.
- Cancellation affects only the matching task/context.
- Context IDs cannot cause path traversal.
- Registry eviction does not delete or lose durable history.
- `legacy-default` can resume pre-migration history.
- A2A v0.3 UI context IDs and A2A v1 context IDs are preserved.

### Phase 2 acceptance criteria

- Separate kagent UI sessions no longer share model conversation history.
- Restarting the Pod preserves each context independently.
- No context can select another context's session path.
- Existing `legacy-default` history remains available only to the legacy fallback context.

---

# Phase 3: kagent MCP tools and Memory

Implement MCP and Memory as separate sub-phases and feature flags. MCP tool execution must not be required for basic local coding, and Memory outages must not fail normal prompts.

## 3A: kagent MCP tools

### 3A.1 Configuration contract

kagent 0.10.1 does not inject declarative Agent tools into a BYO runtime. Define an explicit BYO configuration contract, initially through a ConfigMap/Secret-backed setting such as `PI_MCP_SERVERS_JSON`.

Each server entry should contain only non-secret routing data:

- Stable server ID
- Transport and internal URL
- Allowed tool names or patterns
- Request timeout
- Optional destination policy identifier

Credentials must come from Secret references or the projected kagent identity, never inline JSON or the image.

A later v1alpha3 implementation may translate Harness/AgentTemplate configuration into the same internal representation.

### 3A.2 MCP client and tool registry

Add modules similar to:

```text
src/integrations/mcp/config.ts
src/integrations/mcp/client-manager.ts
src/integrations/mcp/pi-tool-adapter.ts
```

Implementation tasks:

1. Use the official MCP SDK and pin its version.
2. Connect lazily and apply connect/call deadlines.
3. Discover tools and convert MCP JSON Schema into schemas accepted by Pi/provider APIs.
4. Normalize tool names and reject collisions with built-in or other MCP tools.
5. Support an explicit allowlist; do not expose every discovered tool by default.
6. Forward cancellation to MCP calls.
7. Truncate tool results and preserve a safe indication that truncation occurred.
8. Initially support text and structured JSON results; reject unsupported binary/image payloads explicitly.
9. Sanitize remote errors and never log request headers, Secret values, raw tool arguments, or sensitive results.
10. Reconnect after Pod restart or Substrate restore; do not checkpoint live sockets.
11. Close clients on execution/runtime shutdown and evict idle connections.

### 3A.3 MCP network and identity policy

- Add every MCP destination to the deployment's explicit egress policy.
- Prefer cluster-internal TLS and workload identity.
- Scope credentials per server.
- Do not pass OpenAI Codex OAuth credentials to MCP servers.
- Treat MCP tool descriptions and results as untrusted remote content.

### 3A.4 MCP tests and acceptance criteria

Test with a deterministic local MCP server:

- Discovery and allowlist filtering
- Schema conversion
- Name collision handling
- Successful call and structured result
- Timeout and cancellation
- Oversized output truncation
- Server disconnect/reconnect
- Secret-safe logging
- One context's cancellation does not close another context's active call

Acceptance requires one configured kagent MCP tool to be visible to Pi and callable through the kagent UI without enabling arbitrary Bash network access.

## 3B: kagent long-term Memory

### 3B.1 Cluster prerequisites

The current cluster reports:

```text
relation "memory" does not exist
```

and has `DATABASE_VECTOR_ENABLED=false` with a standard PostgreSQL image. Before runtime integration:

1. Back up the PostgreSQL PVC.
2. Switch to a PostgreSQL image containing a compatible pgvector extension.
3. Set `database.postgres.vectorEnabled=true`.
4. Run and verify the kagent vector migration.
5. Confirm the `memory` table and vector indexes exist.
6. Verify that the Memories UI returns an empty list instead of HTTP 500.
7. Create a dedicated embedding ModelConfig and Secret; use 768-dimensional embeddings expected by kagent 0.10.1.

Perform this as a separate infrastructure change with its own rollback procedure.

### 3B.2 Trusted user identity

Memory requires both agent and user identity. Do not infer a user solely from model text or accept an arbitrary user ID from an untrusted A2A body.

Define and verify a gateway-to-runtime identity contract:

- Agent key derived from canonical namespace/name, matching the key used by the Memories UI.
- User ID supplied by trusted kagent gateway metadata or a verified workload token claim.
- Direct runtime access remains private.
- Missing trusted user identity disables kagent Memory for that request rather than falling back to a shared user.

Keep A2A `contextId` and kagent `userId` separate: context selects conversational history; user selects long-term Memory tenancy.

### 3B.3 Memory client

Add modules similar to:

```text
src/integrations/memory/config.ts
src/integrations/memory/embedding-client.ts
src/integrations/memory/kagent-memory-client.ts
src/integrations/memory/memory-tools.ts
```

Implement:

- Embedding generation with an explicit model, 768 output dimensions, timeout, cancellation, and retry limits.
- `POST /api/memories/search`
- `POST /api/memories/sessions`
- Optional batch save endpoint
- Sanitized handling for list/search/store failures
- Configurable TTL, result limit, and minimum score

Credentials for embeddings must be independent from Pi's ChatGPT OAuth credential unless the provider explicitly supports embeddings through that credential.

### 3B.4 Pi Memory behavior

Add two reviewed custom tools:

- `load_memory(query)` performs user- and agent-scoped semantic search.
- `save_memory(content)` stores an explicit durable fact.

Then add optional automation:

1. Prefetch relevant memories on the first turn of a context and inject them as clearly delimited untrusted context.
2. Never treat recalled memory as higher priority than system/developer instructions.
3. Auto-save only after an agreed interval, initially every five user turns.
4. Summarize/extract facts before auto-save; avoid saving raw secrets, tool output, credentials, or the full workspace.
5. Let explicit user requests delete memories through kagent's authorized UI/API, not an unrestricted model tool initially.
6. Continue the normal prompt when Memory search/save is unavailable.

### 3B.5 Memory tests and acceptance criteria

Test with fake embedding and Memory APIs:

- Explicit save appears in kagent Memories for the correct agent/user.
- Relevant memory can be loaded in a later context belonging to the same user.
- Another user receives no result.
- Context separation remains intact while long-term memories are shared only within the same user/agent scope.
- Malicious recalled text cannot override system instructions.
- Embedding or database outage does not fail the primary agent request.
- Timeout, cancellation, TTL, score filtering, and output limits work.
- No auth token, prompt secret, or raw tool result is auto-saved.

Acceptance requires an explicit `save_memory` call to appear in the Memories UI and a later `load_memory` call to retrieve it for the same user only.

---

# Delivery sequence

Use separate changes and immutable image digests:

1. **PR/commit A:** workspace path policy and restricted file tools.
2. **PR/commit B:** sandboxed Bash and hardened container/deployment.
3. **PR/commit C:** context ID preservation and context-scoped Pi sessions.
4. **Infrastructure change:** pgvector image, migration, backup, and UI verification.
5. **PR/commit D:** MCP client and selected tool adapters behind `PI_MCP_ENABLED=false`.
6. **PR/commit E:** Memory identity/client/tools behind `PI_MEMORY_ENABLED=false`.
7. Enable each integration in a canary `pi-agent-v2`, run adversarial and restart tests, then move the primary Agent to the verified digest.

## Rollback

- Keep the previous OCI digest in deployment history.
- Back up both Pi and PostgreSQL PVCs before schema or session-layout changes.
- Disabling MCP or Memory must not require rolling back local coding functionality.
- Do not downgrade PostgreSQL after a pgvector migration without restoring the database backup.
- If context migration fails, restore the old digest and PVC snapshot; do not merge context directories automatically.

## Definition of done

The complete work is done when:

- Local tools cannot access credentials, runtime sessions, host process state, or undeclared network destinations.
- Skills are readable from reviewed roots and cannot be modified by the agent.
- Two kagent contexts have independently durable Pi histories.
- One approved MCP tool is callable with cancellation, timeout, output truncation, and scoped credentials.
- `save_memory` and `load_memory` work through kagent's Memory store with verified per-user isolation.
- Unit, integration, container, A2A v0.3/v1, restart, concurrency, and adversarial security tests pass.
- README and both v1alpha2/v1alpha3 manifests describe configuration, threat boundaries, migration, and rollback.
