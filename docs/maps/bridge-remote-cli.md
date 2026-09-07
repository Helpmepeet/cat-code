# Bridge, Remote, And CLI Transport Map

Last refreshed: 2026-09-06 against the current source tree and the current
ChatGPT review-bridge validation record.

## Purpose

Daily-refreshable routing map for Remote Control bridge, remote sessions,
structured CLI/SDK transport, direct-connect, upstream proxy, remote
permissions, transport validation in Cat Code, and the separately owned
ChatGPT review bridge.

Use this file to choose the first implementation surfaces to inspect before
changing bridge or remote transport behavior. This is a routing map, not the
behavioral source of truth. Verify current code paths before editing.

## Refresh Checklist

- Re-read `docs/maps/WORKSPACE_MAP.md`.
- Check command exposure in `src/commands.ts` and the command module under
  `src/commands/bridge/`.
- Check REPL bridge startup in `src/bridge/initReplBridge.ts`, then branch into
  `src/bridge/remoteBridgeCore.ts` for env-less bridge or `src/bridge/replBridge.ts`
  / `src/bridge/bridgeMain.ts` for env-based bridge.
- Check child CLI structured transport in `src/cli/structuredIO.ts`,
  `src/cli/remoteIO.ts`, and `src/cli/transports/`.
- Check local remote-viewer clients in `src/remote/`, `src/hooks/useRemoteSession.ts`,
  and `src/hooks/useDirectConnect.ts`.
- Check direct-connect session creation in `src/server/createDirectConnectSession.ts`
  and `src/server/directConnectManager.ts`.
- Check CCR container upstream proxy in `src/upstreamproxy/`.
- For docs-only refreshes, run `git diff --check` and path/link checks.

## First Files To Inspect

Read in this order for most bridge or remote-control work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Current map index and broad subsystem routing. |
| 2 | [`../../src/bridge/initReplBridge.ts`](../../src/bridge/initReplBridge.ts) | Shared REPL bridge gate, auth/policy checks, title derivation, and v1/v2 branch point. |
| 3 | [`../../src/bridge/remoteBridgeCore.ts`](../../src/bridge/remoteBridgeCore.ts) | Env-less REPL bridge: create code session, call `/bridge`, build v2 transport, refresh JWT, teardown. |
| 4 | [`../../src/bridge/bridgeMain.ts`](../../src/bridge/bridgeMain.ts) | Standalone `cat-code remote-control`: arg parsing, multi-session spawn, resume, work polling. |
| 5 | [`../../src/bridge/sessionRunner.ts`](../../src/bridge/sessionRunner.ts) | Spawned child CLI command, env vars, stdout parsing, permission request detection, token refresh injection. |
| 6 | [`../../src/cli/structuredIO.ts`](../../src/cli/structuredIO.ts) | Stream-json parsing, control request/response lifecycle, permission prompt protocol, sandbox asks. |
| 7 | [`../../src/cli/remoteIO.ts`](../../src/cli/remoteIO.ts) | `--sdk-url` transport wrapper, CCR v2 client setup, session keepalive, internal event hooks. |

The Entry Points table below routes the remaining surfaces (command exposure,
env-based bridge, transport selection, ptclove local bridge, remote viewer,
direct connect, upstream proxy).

## Entry Points

| Concern | Start here | Then inspect | Notes |
|---|---|---|---|
| `/remote-control` command exposure | `src/commands.ts` | `src/commands/bridge/index.ts`, `src/commands/bridge/bridge.tsx` | `remote-control` / `rc` is included only when `BRIDGE_MODE` is compiled and `isBridgeEnabled()` passes. |
| Standalone Remote Control CLI | `src/bridge/bridgeMain.ts` | `src/bridge/bridgeApi.ts`, `src/bridge/createSession.ts`, `src/bridge/sessionRunner.ts` | Owns `cat-code remote-control` args, env registration, polling, spawned session workers, archive/deregister, and headless daemon helpers. |
| In-REPL bridge toggle | `src/hooks/useReplBridge.tsx` | `src/bridge/initReplBridge.ts`, `src/bridge/replBridgeHandle.ts` | REPL state enables the bridge; the hook owns connection lifecycle and forwards messages/control events. |
| Env-less REPL bridge | `src/bridge/remoteBridgeCore.ts` | `src/bridge/codeSessionApi.ts`, `src/bridge/replBridgeTransport.ts` | Uses `/v1/code/sessions` then `/bridge`; no environment register/poll/ack/heartbeat layer. |
| Local ptclove socket bridge | `src/hooks/usePtcloveBridge.ts` | `src/bridge/ptcloveBridgeProtocol.ts`, `src/bridge/bridgeBroadcaster.ts`, `src/bridge/mergeBridgePermissionCallbacks.ts` | Local-only NDJSON socket that mirrors session state/activity and can surface approval requests; used to drive an external UI/controller without CCR. |
| Env-based bridge | `src/bridge/replBridge.ts`, `src/bridge/bridgeMain.ts` | `src/bridge/bridgeApi.ts`, `src/bridge/workSecret.ts` | Registers a bridge environment, polls for work, decodes work secrets, and uses session-ingress or CCR v2 transport for sessions. |
| Child SDK transport | `src/cli/remoteIO.ts` | `src/cli/transports/`, `src/cli/print.ts` | `--sdk-url` creates `RemoteIO`, which extends `StructuredIO` and chooses WebSocket/hybrid/SSE transport by env and URL. |
| Structured SDK protocol | `src/cli/structuredIO.ts` | SDK control schemas and `src/cli/print.ts` | Owns NDJSON line parsing, `control_request`, `control_response`, duplicate response suppression, and permission prompt requests. |
| Remote CCR TUI session | `src/remote/RemoteSessionManager.ts` | `src/remote/SessionsWebSocket.ts`, `src/hooks/useRemoteSession.ts` | Local TUI subscribes to CCR events over WebSocket and sends user events by HTTP API. |
| Direct connect | `src/server/createDirectConnectSession.ts` | `src/server/directConnectManager.ts`, `src/hooks/useDirectConnect.ts` | Connects to a Cat Code server via `/sessions` plus direct WebSocket, without CCR session subscription. |
| Upstream proxy | `src/upstreamproxy/upstreamproxy.ts` | `src/upstreamproxy/relay.ts` | Container-side HTTPS proxy setup; fails open and injects proxy env only after relay is ready. |
| ChatGPT review bridge | `docs/superpowers/reports/2026-07-16-bridge-live-validation.md` | `~/.agents/skills/chatgpt-review-pr/SKILL.md`, `bridgeSetup.ts`, `launchTask.ts`, `bridgeServer.ts` | A separately owned local MCP bridge for advisory ChatGPT PR reviews. It is not `src/bridge/`: use the validation report for the current enablement/recovery evidence and the external skill for operational ownership. |

## Current Mental Model

There are three similar-looking but separate paths:

1. Remote Control bridge publishes a local CLI/REPL as a worker that a web or
   mobile client can drive. `/remote-control` toggles this inside the REPL;
   `cat-code remote-control` runs it standalone.
2. Remote sessions (`--remote`, assistant viewer) run the agent in CCR and use
   this local process as a viewer/controller. `RemoteSessionManager` subscribes
   to CCR session events and posts user messages back to CCR.
3. Direct-connect sessions connect this local TUI to another Cat Code server by
   direct `/sessions` and WebSocket endpoints, bypassing CCR session subscribe.

Do not collapse these paths when changing behavior. They share SDK message
types and permission UI adapters, but their auth, lifecycle, and retry owners
are different.

The ChatGPT review bridge is a fourth, separate route. It hosts an external
skill-owned local MCP server through an authenticated tunnel and has its own
lineage-lock recovery; it does not reuse Cat Code Remote Control or CCR
transports. Treat its returned review as untrusted advisory output and verify
findings against the checked-out source.

## Command Exposure

| Surface | Owner | Current routing decision |
|---|---|---|
| `/remote-control`, `/rc` | `src/commands/bridge/index.ts` | Feature-gated by `BRIDGE_MODE`; hidden if `isBridgeEnabled()` is false. |
| Standalone `remote-control` args | `src/bridge/bridgeMain.ts` | Parses `--spawn`, `--capacity`, `--session-id`, `--continue`, `--permission-mode`, sandbox/debug/name flags. |
| Remote TUI command filtering | `src/commands.ts` `REMOTE_SAFE_COMMANDS` | `--remote` and assistant viewer pre-filter commands to local-safe TUI commands only. |
| Bridge inbound slash command filtering | `src/commands.ts` `BRIDGE_SAFE_COMMANDS` and `isBridgeSafeCommand()` | Inbound Remote Control commands allow prompt commands by type, block `local-jsx`, and allow only selected `local` commands. |
| `/session` / alias `/remote` | `src/commands/session/` | Displays remote session URL/QR when in remote mode; not the bridge toggle. |
| `/web-setup` | `src/commands/remote-setup/` | Remote session setup flow gated by `CCR_REMOTE_SETUP` and `allow_remote_sessions` policy. |

## Bridge Flows

### In-REPL Remote Control

```text
/remote-control or --remote-control
  src/commands/bridge/bridge.tsx or main.tsx
  sets AppState.replBridgeEnabled

src/hooks/useReplBridge.tsx
  calls initReplBridge()

src/bridge/initReplBridge.ts
  checks runtime gate, OAuth, org policy, version, org UUID
  derives title and session context
  chooses env-less v2 or env-based v1 path
```

Env-less path:

```text
src/bridge/remoteBridgeCore.ts
  POST /v1/code/sessions via createCodeSession()
  POST /v1/code/sessions/{id}/bridge via fetchRemoteCredentials()
  createV2ReplTransport()
    SSETransport reads /worker/events/stream
    CCRClient writes /worker/events, /worker, heartbeat, delivery
  forwards REPL messages/control events
  refreshes worker JWT before expiry or after SSE 401
  archives session on teardown
```

Env-based path:

```text
src/bridge/replBridge.ts or src/bridge/bridgeMain.ts
  createBridgeApiClient()
  POST /v1/environments/bridge
  poll /work/poll
  decode work secret
  create/reconnect session
  build session transport
  ack, heartbeat, stop, archive, deregister
```

### Standalone `cat-code remote-control`

`src/bridge/bridgeMain.ts` owns the standalone command. It validates
permission mode early, enables config/sinks directly because it bypasses normal
init, gates multi-session flags, registers an environment, optionally resumes
via `bridgePointer.ts`, and enters a poll loop.

When work arrives, `src/bridge/sessionRunner.ts` spawns this same binary with:

```text
--print
--sdk-url <url>
--session-id <id>
--input-format stream-json
--output-format stream-json
--replay-user-messages
```

It sets `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`, injects
`CLAUDE_CODE_SESSION_ACCESS_TOKEN`, enables hybrid session-ingress POST writes
with `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1`, and enables CCR v2 child
transport with `CLAUDE_CODE_USE_CCR_V2=1` plus `CLAUDE_CODE_WORKER_EPOCH` when
the work item is using CCR v2.

## Structured CLI And Transport Flow

```text
src/main.tsx
  --sdk-url implies stream-json input/output
  validates --sdk-url is only used with stream-json

src/cli/print.ts
  getStructuredIO()
  sdkUrl ? new RemoteIO(...) : new StructuredIO(...)

src/cli/remoteIO.ts
  chooses transport via getTransportForUrl()
  wires stdin-style data into StructuredIO
  optionally creates CCRClient for CCR v2
  registers internal-event writer/reader for resume
  sends bridge keep_alive when running as bridge

src/cli/structuredIO.ts
  parses NDJSON stdin/control messages
  sends control_request for tool permissions, hooks, MCP, elicitation
  resolves control_response and suppresses duplicate tool responses
  applies update_environment_variables token refresh messages
```

Transport selection lives in `src/cli/transports/transportUtils.ts`:

| Condition | Transport | Read path | Write path |
|---|---|---|---|
| `CLAUDE_CODE_USE_CCR_V2` truthy | `SSETransport` plus `CCRClient` in `RemoteIO` | SSE `/worker/events/stream` | CCRClient POST `/worker/events`, internal events, state, heartbeat |
| WebSocket URL and `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` truthy | `HybridTransport` | WebSocket session-ingress | HTTP POST session-ingress events with serial batch uploader |
| WebSocket URL default | `WebSocketTransport` | WebSocket | WebSocket |
| Anything else | error | N/A | `Unsupported protocol` |

## Remote Sessions

`--remote` and assistant viewer mode run the agent remotely and render/control
it locally:

```text
src/main.tsx
  creates or selects CCR session
  createRemoteSessionConfig()
  filters commands with filterCommandsForRemoteMode()
  launches REPL with remoteSessionConfig

src/screens/REPL.tsx
  useRemoteSession()
  routes input/cancel through activeRemote

src/hooks/useRemoteSession.ts
  creates RemoteSessionManager
  converts SDK messages via sdkMessageAdapter
  renders permission prompts through local ToolUseConfirm queue
  filters echoed local user messages by uuid

src/remote/RemoteSessionManager.ts
  SessionsWebSocket subscribe for inbound SDK/control messages
  sendEventToRemoteSession() for user messages
  send control_response for permissions
  send interrupt control_request for cancel
```

`src/remote/SessionsWebSocket.ts` owns subscription retry policy. It connects
to `/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`, authenticates
with OAuth headers, pings every 30 seconds, retries transient closes, treats
4003 as permanent, and gives 4001 a small retry budget for compaction races.

## Direct Connect

Direct connect is separate from CCR remote sessions:

```text
cc:// or open <cc-url>
  main.tsx parses pending connect state
  createDirectConnectSession()
    POST {serverUrl}/sessions
    validates connectResponseSchema
  REPL gets directConnectConfig
  useDirectConnect()
    DirectConnectSessionManager WebSocket
```

`src/server/directConnectManager.ts` sends SDK user messages directly over the
server WebSocket, converts inbound stdout/control messages, prompts locally for
remote `can_use_tool`, and sends SDK-shaped control responses or interrupts
back over the same socket.

## Remote Permissions

| Direction | Owner | Notes |
|---|---|---|
| Child CLI asks bridge/web for tool permission | `src/cli/structuredIO.ts` | `can_use_tool` control requests are emitted by `sendRequest()` and tracked in `pendingRequests`. |
| Spawned bridge child exposes permission prompt to parent | `src/bridge/sessionRunner.ts` | Parses child stdout for `control_request` so the bridge parent can forward it. |
| REPL bridge sends/cancels permission prompts | `src/bridge/remoteBridgeCore.ts`, `src/bridge/replBridge.ts` | `sendControlRequest`, `sendControlResponse`, and `sendControlCancelRequest` mirror SDK control protocol. |
| Remote CCR session prompts local TUI | `src/remote/RemoteSessionManager.ts`, `src/hooks/useRemoteSession.ts` | Stores pending request, builds synthetic `ToolUseConfirm`, responds over session WebSocket. |
| Direct-connect prompts local TUI | `src/server/directConnectManager.ts`, `src/hooks/useDirectConnect.ts` | Same synthetic permission UI pattern, but response goes over direct WebSocket. |
| Synthetic permission message/tool | `src/remote/remotePermissionBridge.ts` | Creates a synthetic assistant message and fallback tool stub for tools unknown to the local viewer. |
| Sandbox network ask in SDK mode | `src/cli/structuredIO.ts` | Uses synthetic `SandboxNetworkAccess` tool name over `can_use_tool`. |

Key distinction: remote permission state belongs to the remote worker/container.
The local viewer constructs UI stubs and responses, but it does not re-run local
permission rules for remote tools.

## Resume And Persistence

| Concern | Owner | Notes |
|---|---|---|
| Bridge crash pointer | `src/bridge/bridgePointer.ts` | Stores recent bridge session/environment pointer per working directory; `--continue` can scan worktrees. |
| Standalone bridge resume | `src/bridge/bridgeMain.ts` | `--session-id` / `--continue` re-registers environment, calls `bridge/reconnect`, and only clears pointer on fatal reconnect failure. |
| CCR v2 internal events | `src/cli/remoteIO.ts`, `src/cli/transports/ccrClient.ts` | Registers internal event writer/reader so session storage can write/read worker-internal events for resume. |
| CCR worker external metadata | `src/cli/transports/ccrClient.ts` | Reads prior worker metadata during init and reports metadata changes through `/worker`. |
| Remote viewer history | `src/hooks/useAssistantHistory.ts`, `src/remote/sdkMessageAdapter.ts` | Converts historical CCR SDK events for viewer mode; live subscription remains in `useRemoteSession`. |

## Upstream Proxy

Upstream proxy is CCR container-side egress plumbing, not the bridge control
plane:

```text
src/upstreamproxy/upstreamproxy.ts
  initUpstreamProxy()
  requires CLAUDE_CODE_REMOTE_SESSION_ID and /run/ccr/session_token
  downloads /v1/code/upstreamproxy/ca-cert
  starts local CONNECT relay
  returns HTTPS_PROXY / SSL_CERT_FILE / NO_PROXY env for child processes

src/upstreamproxy/relay.ts
  listens on 127.0.0.1:<port>
  accepts HTTP CONNECT
  opens WebSocket to /v1/code/upstreamproxy/ws
  wraps tunneled bytes in UpstreamProxyChunk protobuf wire format
```

Every setup step fails open. A broken proxy logs a warning and disables proxy
env injection; it should not block the agent session.

## Validation And Safety Owners

| Validation | Owner | What it protects |
|---|---|---|
| Bridge environment/session/work IDs in URL paths | `src/bridge/bridgeApi.ts` `validateBridgeId()` | Rejects server-provided IDs containing unsafe path characters before interpolation. |
| Work secret shape | `src/bridge/workSecret.ts` `decodeWorkSecret()` | Requires version 1, `session_ingress_token`, and `api_base_url`. |
| CCR code-session create response | `src/bridge/codeSessionApi.ts` `createCodeSession()` | Requires `session.id` string starting with `cse_`. |
| `/bridge` credential response | `src/bridge/codeSessionApi.ts` `fetchRemoteCredentials()` | Requires `worker_jwt`, numeric `expires_in`, string `api_base_url`, and safe integer `worker_epoch`. |
| Direct-connect create response | `src/server/types.ts`, `src/server/createDirectConnectSession.ts` | Zod validates `session_id`, `ws_url`, optional `work_dir`; errors become `DirectConnectError`. |
| SDK URL format | `src/main.tsx`, `src/cli/transports/transportUtils.ts` | `--sdk-url` requires stream-json input/output; transport selection rejects unsupported protocols. |
| SSE frames | `src/cli/transports/SSETransport.ts` | Parses SSE frames, accepts only `client_event`, tracks sequence numbers and liveness. |
| Permission mode args | `src/bridge/bridgeMain.ts` | Validates bridge `--permission-mode` against `PERMISSION_MODES` before polling. |
| Settings permission rules | `src/utils/settings/permissionValidation.ts` | Settings-level permission rule syntax, separate from remote prompt transport. |

## Tests And Validation

Use focused checks first, then the documented build if behavior changed:

| Area | Focused checks |
|---|---|
| Bridge argument parsing and resume | Search for `bridgeMain` / `parseArgs` tests; otherwise add focused tests near `src/bridge/bridgeMain.ts`. |
| Bridge ID and session API validation | Tests near `src/bridge/bridgeApi.ts`, `src/bridge/codeSessionApi.ts`, and `src/bridge/workSecret.ts` if present; otherwise add unit coverage around pure validators. |
| Structured IO permission flow | Tests near `src/cli/structuredIO.ts` and `src/cli/print.ts`; cover duplicate `control_response` and permission cancellation behavior. |
| Transport parsing/retry | Tests near `src/cli/transports/SSETransport.ts`, `HybridTransport.ts`, and `ccrClient.ts`. |
| Remote viewer behavior | Tests around `src/remote/` and hooks if present; otherwise pair source review with manual remote session verification. |
| Direct connect | Tests near `src/server/createDirectConnectSession.ts` and `src/server/directConnectManager.ts`. |
| Docs-only refresh | `git diff --check` plus link/path spot checks. |
| Build-level validation | `bun run build:dev:full`. |

## Traps And Stale Assumptions

- Do not treat env-less bridge and CCR v2 transport as the same gate. Env-less
  removes the environment poll layer; env-based sessions can still use CCR v2
  child transport.
- Do not route remote viewer permission decisions through local permission
  rules. The remote worker owns policy; the local TUI only presents and returns
  the user's decision.
- Do not assume all slash commands are safe from Remote Control. `local-jsx`
  commands are blocked for bridge inbound; remote TUI mode has a separate
  allowlist.
- Do not send OAuth tokens where worker JWTs are required. CCR v2 worker
  endpoints use session worker JWTs and worker epochs.
- Do not use process-wide `CLAUDE_CODE_SESSION_ACCESS_TOKEN` for concurrent
  sessions when a per-transport `getAuthToken` closure is available.
- Do not archive or deregister on transient bridge reconnect failure; the
  pointer/resume path intentionally preserves retryability.
- Do not close CCR v2 transports before flushing when delivery matters.
  `CCRClient.close()` abandons uploader queues unless callers flushed first.
- Do not assume WebSocket is always the write path. Hybrid and CCR v2 transports
  read over WS/SSE and write over HTTP POST.
- Do not make upstream proxy required for session startup. Its contract is
  best-effort and fail-open.
- Do not route ChatGPT review-bridge incidents through `src/bridge/` or assume
  its bridge is disabled from older reports. Its current enablement and recovery
  evidence live in the dated validation report; its implementation is external
  to this repository.
