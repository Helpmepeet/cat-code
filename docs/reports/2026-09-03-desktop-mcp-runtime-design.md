# Desktop MCP runtime wiring design

**Status:** investigated and designed 2026-09-03; revised after source-backed
authorization, lifecycle, and concurrency review; not implemented.

## Summary

Cat Code desktop sessions do not expose configured Model Context Protocol (MCP)
tools because the sidecar still constructs its runtime with empty MCP clients,
tools, commands, resources, and available-server state. This is a known deferred
integration, not an intentional desktop product limitation and not a locked
migration decision.

The smallest generally correct fix is not a blocking MCP prefetch before sidecar
readiness. It is a non-blocking, trust-gated MCP lifecycle owned by the Bun
sidecar but implemented from engine MCP primitives. That lifecycle should load
the same Cat Code configuration as the terminal runtime, exclude project MCP
servers that lack explicit server approval, connect each eligible server
incrementally after workspace trust, publish each result into the sidecar's live
`AppState.mcp`, and let `QueryEngine` read one coherent current MCP snapshot
during each turn.

This design requires no new renderer-authored authority, preload method, IPC
channel, transport, permission model, or process topology.

### Cold-review amendments

The current-source review validated seven changes that are now requirements of
this design:

- sidecar cleanup must finish before the supervisor's SIGKILL grace period, not
  race it;
- desktop must fail closed for MCP URL elicitation until it has a correlated UI;
- a subagent launched after waiting for a pending server must receive the latest
  atomic MCP snapshot in that same model iteration;
- the extensions read seam must project the lifecycle's explicitly approved MCP
  configuration instead of reading configuration again with default policy;
- dynamic tool assembly must retain caller-supplied base tools;
- new process-wide MCP acquisition state must expose a test-only reset; and
- source anchors below are kept aligned with current supervisor and host code.

## Incident and current defect

A CuaDriver MCP server configured in Cat Code is connected and visible to the
terminal CLI. A desktop session running `ToolSearch` for
`mcp__cua-driver__*` received no match and fell back to invoking CuaDriver
through Bash.

The behavior follows directly from current construction:

- [`app/sidecar/sessionController.ts:346-347`](../../app/sidecar/sessionController.ts:346)
  creates empty `mcpClients` and `availableMcpServers`.
- [`app/sidecar/sessionController.ts:407-423`](../../app/sidecar/sessionController.ts:407)
  passes empty MCP tools, commands, clients, and resources into the existing
  app-runtime adapter.
- [`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:39-101`](../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:39)
  already knows how to merge supplied MCP values into the model-visible tool and
  command pools and mirror them into `AppState.mcp`; the sidecar supplies no
  values.
- The migration status explicitly records live MCP wiring as deferred and warns
  against hand-wiring it in the sidecar
  ([`docs/migration/STATUS.md:447`](../migration/STATUS.md:447)).

Therefore the missing tools are an unwired integration bug.

## Constraints

### Preserve the locked desktop architecture

The fix must preserve:

- one Bun sidecar process per desktop session;
- Unix-domain-socket transport;
- raw `AppSessionEvent` fidelity;
- the app-session-id to engine-session-id model;
- die-with-window lifecycle.

MCP clients belong inside each sidecar. Moving clients into Electron main or the
supervisor would cross the engine trust boundary and introduce shared ownership
between otherwise isolated sessions.

### Treat MCP connection as execution

A `stdio` MCP configuration names a command and arguments
([`src/services/mcp/types.ts:28-35`](../../src/services/mcp/types.ts:28)).
Connecting it spawns that command. The terminal runtime deliberately loads MCP
configuration before trust but waits until after the trust flow to connect
([`src/main.tsx:1802-1819`](../../src/main.tsx:1802),
[`src/main.tsx:2419-2458`](../../src/main.tsx:2419)).

The desktop currently learns and accepts trust after the sidecar has spawned.
The sidecar trust domain persists trust for its own host-supplied working
directory and never accepts a renderer-authored path
([`app/sidecar/workspaceTrustDomain.ts:28-36`](../../app/sidecar/workspaceTrustDomain.ts:28),
[`app/sidecar/workspaceTrustDomain.ts:80-101`](../../app/sidecar/workspaceTrustDomain.ts:80)).
MCP configuration may be read before trust, as the CLI does, but no MCP transport
may connect before that domain reports `trusted: true`.

Workspace trust is necessary but not sufficient for project `.mcp.json`
execution. The terminal runs a separate post-trust project-server approval flow
([`src/interactiveHelpers.tsx:152-161`](../../src/interactiveHelpers.tsx:152),
[`src/services/mcpServerApproval.tsx:10-39`](../../src/services/mcpServerApproval.tsx:10)).
The desktop sidecar is non-interactive by default
([`src/bootstrap/state.ts:290-316`](../../src/bootstrap/state.ts:290)), and the
current project-server status helper treats non-interactive mode as implicit
approval
([`src/services/mcp/utils.ts:351-405`](../../src/services/mcp/utils.ts:351)).
Calling the ordinary config loader without an explicit-only approval mode would
therefore collapse two authorization decisions and execute a repository's
pending `stdio` server when the user accepted only general workspace trust.

The first patch must preserve the separate authority without adding UI: include
only project servers already named in the persisted approval settings (or
covered by the persisted approve-all setting), retain explicit rejections, and
exclude pending project servers. A future desktop project-MCP approval surface
is a separate engine-minted, sidecar-validated round trip. Do not widen the
workspace trust copy to imply approval that the first patch does not grant.

### Do not block sidecar readiness on MCP

The supervisor allows roughly ten seconds for the sidecar socket to appear and
kills a child that misses the deadline
([`app/supervisor/supervisor.ts:609-630`](../../app/supervisor/supervisor.ts:609)).
One MCP connection defaults to a thirty-second timeout
([`src/services/mcp/client.ts:464-465`](../../src/services/mcp/client.ts:464),
[`src/services/mcp/client.ts:1058-1090`](../../src/services/mcp/client.ts:1058)).
Multiple local servers are processed under a bounded concurrency limit, so an
aggregate wait can exceed either duration.

Consequently, awaiting `prefetchAllMcpResources()` before constructing the
sidecar server can turn one unavailable MCP server into total desktop-session
startup failure. Increasing the supervisor deadline is not a fix: it couples
session availability to an open-ended set of external processes and networks.

### Keep MCP permissions engine-owned

Discovered MCP tools already become ordinary engine `Tool` objects with:

- a fully qualified `mcp__server__tool` permission identity;
- the original server and tool identity in `mcpInfo`;
- bounded prompt text;
- existing call, reconnect, progress, and result behavior;
- engine-minted persistent permission suggestions.

The owner is
[`src/services/mcp/client.ts:1784-1904`](../../src/services/mcp/client.ts:1784).
Permission matching already uses the fully qualified MCP identity, including
server-level rules
([`src/utils/permissions/permissions.ts:235-270`](../../src/utils/permissions/permissions.ts:235)).
The app runtime converts asks into engine-minted permission requests
([`src/app-runtime/appRuntimeCanUseTool.ts:26-81`](../../src/app-runtime/appRuntimeCanUseTool.ts:26)).
The existing sidecar T5a, T6, and T6b checks remain the authority for renderer
responses.

No MCP-tool-execution-specific approval channel should be added. Project-server
configuration approval is a separate startup authority and remains excluded from
the first patch unless designed as its own correlated boundary.

## Proposed runtime

### 1. Add an imperative app-runtime MCP lifecycle

Add one narrow engine module under `src/app-runtime/`, provisionally named
`createAppRuntimeMcpLifecycle.ts`. It should compose existing MCP owners rather
than copy transport, configuration, tool-wrapping, permission, or retry logic.
Its configuration preparation and per-server state transition must be extracted
from all existing runtime paths, not only the React hook:

- interactive React:
  [`src/services/mcp/useManageMCPConnections.ts:204-309`](../../src/services/mcp/useManageMCPConnections.ts:204);
- print/headless:
  [`src/main.tsx:2734-2765`](../../src/main.tsx:2734);
- desktop: the new app-runtime lifecycle.

The shared extraction owns pending seeding, same-server replacement, resource
replacement/removal, disabled/failed clearing, and deduplication. React-only
notifications, reconnection timers, and UI effects remain in the hook.
Print-specific blocking policy and claude.ai timeout policy remain in
`main.tsx`. The desktop adds no fourth state implementation.

Its responsibilities are:

1. Load Cat Code MCP configuration with `getClaudeCodeMcpConfigs()` in an
   explicit-project-approval mode that disables the non-interactive auto-approve
   branch.
2. Represent every eligible server in `AppState.mcp.clients` as `pending` or
   `disabled` without connecting it.
3. Start connections only after a trusted-sidecar signal.
4. Feed each result from `getMcpToolsCommandsAndResources()` through the shared
   state transition as soon as that server settles.
5. Expose one immutable, coherent `McpRuntimeSnapshot` containing clients,
   tools, commands, and resources.
6. Expose idempotent `prepare()`, `start()`, and `dispose()` operations.
7. Carry a generation through initial connection, authentication, lazy
   reconnect, and session-expiry reconnect so a superseded or disposed lifecycle
   cannot publish.
8. Subscribe to engine connection acquisition/replacement events for this
   lifecycle's server keys, adopting every replacement before publication.
9. Install an owned close handler for each connected client that preserves the
   engine cache invalidation behavior and transitions that server out of
   executable state, removing its stale tools, commands, and resources.

A representative contract is:

```ts
type McpRuntimeSnapshot = Readonly<{
  clients: readonly MCPServerConnection[]
  tools: readonly Tool[]
  commands: readonly Command[]
  resources: Readonly<Record<string, readonly ServerResource[]>>
}>

type AppRuntimeMcpLifecycle = {
  prepare(): Promise<void>
  start(): void
  getSnapshot(): McpRuntimeSnapshot
  dispose(): Promise<void>
}
```

`prepare()` may read configuration and seed pending/disabled state. It must not
connect transports. `start()` should be non-blocking and idempotent. Connection
failures should update that server to `failed`; they must not reject sidecar
construction or stop other servers. A later transport close may remain failed
instead of automatically reconnecting in the first patch, but it must never
leave disconnected tools callable.

`dispose()` must also be idempotent, safe before either `prepare()` or `start()`,
and non-throwing for an already-disposed lifecycle. Repeated calls join the same
cleanup work rather than starting a second shutdown sequence.

The connection and discovery operation remains
[`getMcpToolsCommandsAndResources()`](../../src/services/mcp/client.ts:2262),
which already handles disabled servers, authentication state, bounded local and
remote concurrency, capability discovery, helper resource tools, and fail-soft
per-server results
([`src/services/mcp/client.ts:2262-2438`](../../src/services/mcp/client.ts:2262)).

#### Connection ownership begins before executable setup

The current callback is too late to own cancellation: it receives a client only
after connection and discovery settle
([`src/services/mcp/client.ts:2262-2269`](../../src/services/mcp/client.ts:2262),
[`src/services/mcp/client.ts:2360-2407`](../../src/services/mcp/client.ts:2360)).
For `stdio`, the transport is created before `client.connect()`
([`src/services/mcp/client.ts:954-968`](../../src/services/mcp/client.ts:954)),
while cleanup is not registered until the connected result is returned
([`src/services/mcp/client.ts:1582-1614`](../../src/services/mcp/client.ts:1582)).
A sidecar can therefore exit after child spawn but before any lifecycle sees the
cleanup handle.

Transport acquisition is not the earliest executable point. SSE, WebSocket, and
HTTP configuration can run `headersHelper` before creating a transport
([`src/services/mcp/client.ts:627-632`](../../src/services/mcp/client.ts:627),
[`src/services/mcp/client.ts:743-750`](../../src/services/mcp/client.ts:743),
[`src/services/mcp/client.ts:792-814`](../../src/services/mcp/client.ts:792)).
That helper starts an external shell process and currently receives no abort
signal, even though its underlying execution helper supports one
([`src/services/mcp/headersHelper.ts:26-71`](../../src/services/mcp/headersHelper.ts:26),
[`src/utils/execFileNoThrow.ts:46-56`](../../src/utils/execFileNoThrow.ts:46),
[`src/utils/execFileNoThrow.ts:89-120`](../../src/utils/execFileNoThrow.ts:89)).
WebSocket construction may acquire a live network resource before the common
transport point, and the built-in Chrome and Computer Use branches create and
start in-process servers first
([`src/services/mcp/client.ts:725-791`](../../src/services/mcp/client.ts:725),
[`src/services/mcp/client.ts:913-953`](../../src/services/mcp/client.ts:913)).

Create one generation-bound acquisition scope at the beginning of
`connectToServer()`, before entering any transport branch, and register that
scope with the cleanup registry immediately. The scope owns an `AbortController`
and a last-in-first-out resource stack:

```ts
type McpConnectionAcquisition = {
  signal: AbortSignal
  own(cleanup: () => Promise<void>): void
  complete(cleanup: () => Promise<void>): () => Promise<void>
  dispose(): Promise<void>
}
```

Thread `signal` through `getMcpServerHeaders()` to
`execFileNoThrowWithCwd({abortSignal})`. Register each WebSocket or in-process
server immediately when it is created, before awaiting its next setup step.
Thread the signal into any asynchronous in-process factory that can block or
spawn work; if an upstream factory lacks cancellation, extend that factory
rather than racing and abandoning it. Register a `stdio` transport immediately
after construction, before `client.connect()`.

On success, `complete()` transfers the same acquisition stack into the
connected client's existing cleanup. On setup failure, timeout, abort, or
lifecycle disposal, `dispose()` aborts pending work and settles every acquired
resource in reverse order. It must terminate a pending `stdio` child through the
same bounded signal escalation as a connected child. The memoized connection
owns one acquisition scope per cache key; callers awaiting the same promise do
not create duplicate ownership.

Expose a non-connecting disconnect operation for a cache key. Do not use
`clearServerCache()` as lifecycle disposal when the cache can be empty, because
it calls `connectToServer()` and can create a connection merely to close it
([`src/services/mcp/client.ts:1653-1683`](../../src/services/mcp/client.ts:1653)).

The same engine owner must emit or register connection replacements by cache key.
This covers connections created after initial discovery:

- the authentication pseudo-tool reconnects through
  `reconnectMcpServerImpl()` and currently publishes directly to app state
  ([`src/tools/McpAuthTool/McpAuthTool.ts:115-171`](../../src/tools/McpAuthTool/McpAuthTool.ts:115));
- ordinary MCP wrappers call `ensureConnectedClient()`, which can create a
  replacement after cache invalidation
  ([`src/services/mcp/client.ts:1685-1714`](../../src/services/mcp/client.ts:1685),
  [`src/services/mcp/client.ts:1885-1908`](../../src/services/mcp/client.ts:1885)).

Route both through the shared transition and lifecycle generation. If a model
request was issued with a wrapper just before its transport closed, the stale
returned tool call may attempt reconnection; the replacement must be acquired by
the same cleanup owner and adopted into live state before its result is
published. A disposed generation rejects publication and closes the replacement.

### 2. Make QueryEngine runtime inputs live per turn

`QueryEngine` currently destructures `tools`, `commands`, and `mcpClients` from
its construction-time configuration on every submit, but those fields are fixed
arrays
([`src/QueryEngine.ts:245-282`](../../src/QueryEngine.ts:245)). It also hard-codes
`mcpResources: {}` in both tool-use contexts
([`src/QueryEngine.ts:378-408`](../../src/QueryEngine.ts:378),
[`src/QueryEngine.ts:621-658`](../../src/QueryEngine.ts:621)). Updating only
`AppState.mcp` therefore does not make newly connected tools executable by that
`QueryEngine`.

Expose one atomic runtime reader rather than independent readers that can observe
different state generations:

```ts
type QueryEngineRuntimeSources = {
  getMcpRuntimeSnapshot?: () => McpRuntimeSnapshot
}
```

At the start of each `submitMessage()`, resolve this reader once. Assemble
built-ins plus snapshot tools, base plus snapshot commands, snapshot clients,
and snapshot resources from that same generation. Generalize the existing
`ToolUseContext.options.refreshTools` seam into an atomic runtime refresh that
updates tools, commands, clients, and resources together between model/tool
iterations.
The current query loop updates only tools
([`src/Tool.ts:184-185`](../../src/Tool.ts:184),
[`src/query.ts:2032-2043`](../../src/query.ts:2032)); that is insufficient
because subagent setup inherits `options.mcpClients` and
`options.mcpResources`
([`src/tools/AgentTool/runAgent.ts:780-824`](../../src/tools/AgentTool/runAgent.ts:780)),
and tool execution reads MCP metadata from `options.mcpClients`
([`src/services/tools/toolExecution.ts:338-367`](../../src/services/tools/toolExecution.ts:338)).

The app-runtime snapshot projection for tools should assemble built-ins and MCP tools
through the engine's existing permission-aware pool builder, not concatenate
unfiltered arrays. The current owner is
[`src/tools.ts:385-409`](../../src/tools.ts:385). Generalize that builder to
accept the caller's base tools, defaulting to `getTools(permissionContext)` only
when none were supplied. `QueryEngine` must preserve `config.tools` for
non-desktop callers, including tests and harnesses that intentionally inject
custom tools, rather than regenerating the default built-in set.
Commands should combine the sidecar's base command catalog with snapshot
commands.

Remove the app-runtime adapter's frozen MCP overlay for live callers. It
currently replaces `getAppState().mcp` with construction-time arrays on every
read
([`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:84-102`](../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:84)).
When `getMcpRuntimeSnapshot` is present, `getAppState()` must return the real
store MCP state unchanged. Static setup values remain the fallback only for
callers without the runtime source. Otherwise ToolSearch pending checks and
Agent required-server checks continue seeing the empty setup even if
`options.tools` is live.

Do not implement liveness by retaining caller-owned mutable arrays. The current
adapter deliberately snapshots and clones setup values
([`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:64-82`](../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:64));
an explicit atomic reader makes mutation and ownership visible.

The atomic reader must also be consulted at subagent launch. `AgentTool` waits
against `toolUseContext.getAppState().mcp.clients`, but `runAgent()` currently
receives `toolUseContext.options.mcpClients`
([`src/tools/AgentTool/AgentTool.tsx:907-924`](../../src/tools/AgentTool/AgentTool.tsx:907),
[`src/tools/AgentTool/runAgent.ts:780-823`](../../src/tools/AgentTool/runAgent.ts:780)).
Those can differ when a required server connects during the wait. Before
`runAgent()` builds `agentOptions`, it must obtain and pass the current atomic
clients, tools, commands, and resources, or `AgentTool` must pass that freshly
read snapshot explicitly. Deferring this refresh until the next main-query
iteration is insufficient: the subagent can be invoked in the iteration that
observed the newly connected server.

### 3. Wire trust without a new protocol

`createSidecarSessionController()` should construct the MCP lifecycle over the
same `AppStateStore` used by the runtime and return its `start` and `dispose`
operations alongside the existing domains.

The sidecar should then:

1. prepare the config-only MCP state, omitting project servers without an
   explicit persisted approval;
2. construct and bind the normal sidecar server without awaiting MCP
   connections;
3. call `start()` immediately when the workspace trust snapshot is already true;
4. call `start()` after the existing `workspace.trust` handler successfully
   persists and re-reads trust as true.

This can be an internal `SidecarServer` callback such as `onWorkspaceTrusted`.
It carries no renderer data and adds no frame kind. The existing
`workspace.trust` message still names no path and remains sidecar-validated.

Do not use automatic host restart as the trust transition. A newly opened
session can receive an engine id before any transcript exists, and host restart
correctly refuses to resume such a row
([`app/host/host.ts:841-846`](../../app/host/host.ts:841)). A live lifecycle
avoids that false dependency.

### 4. Preserve ToolSearch behavior

MCP tools are deferred by default unless the server marks them `alwaysLoad`
([`src/tools/ToolSearchTool/prompt.ts:53-71`](../../src/tools/ToolSearchTool/prompt.ts:53)).
`ToolSearchTool` searches the tool collection in its current tool-use context and
reads pending server names from live `AppState.mcp.clients`
([`src/tools/ToolSearchTool/ToolSearchTool.ts:328-393`](../../src/tools/ToolSearchTool/ToolSearchTool.ts:328)).

With the proposed lifecycle:

- before connection, ToolSearch can report the configured server as pending;
- after connection, the live tool reader includes
  `mcp__cua-driver__*` wrappers;
- if connection completes between model iterations, the atomic runtime refresh
  makes the tool and its matching commands/client/resources available together
  on the next iteration;
- no ToolSearch code or deferred-tool protocol changes.

### 5. Own cleanup at the sidecar lifecycle

Every connected MCP client includes a cleanup operation. For `stdio`, cleanup
explicitly escalates from SIGINT to SIGTERM and then SIGKILL because closing the
transport alone is not reliable
([`src/services/mcp/client.ts:1414-1580`](../../src/services/mcp/client.ts:1414)).
Successful connections register that operation with the engine's global cleanup
registry
([`src/services/mcp/client.ts:1582-1614`](../../src/services/mcp/client.ts:1582)).

The engine connection change above must register its acquisition scope before
any executable setup, so the global registry owns header helpers, pending
transports, in-process servers, connected clients, authentication reconnects,
and lazy/session-expiry replacements.

The current `runCleanupFunctions()` is not itself a safe sidecar shutdown
contract. It uses unbounded, fail-fast `Promise.all()`
([`src/utils/cleanupRegistry.ts:19-25`](../../src/utils/cleanupRegistry.ts:19)).
One rejecting unrelated registrant can return control while MCP cleanup is still
running, and one hanging registrant can hold a sidecar-initiated idle or park
exit forever. The supervisor's SIGTERM-to-SIGKILL timer applies only when the
supervisor initiated termination
([`app/supervisor/supervisor.ts:780-800`](../../app/supervisor/supervisor.ts:780));
it does not bound an idle, park, or fatal self-exit.

Add an all-settled cleanup operation to the registry, without changing existing
callers silently:

```ts
type CleanupRunResult = {
  rejected: number
}

runCleanupFunctionsSettled(): Promise<CleanupRunResult>
```

It snapshots the current registry, invokes every function, awaits
`Promise.allSettled()`, and reports only a count or similarly non-sensitive
summary. It must not throw because one registrant rejected. Keep the existing
`runCleanupFunctions()` behavior for callers that still depend on it, or migrate
them deliberately with focused tests.

The sidecar owns a single `runSidecarCleanup()` wrapper. It first marks the
app-runtime MCP generation disposed, preventing new publication and aborting
pending acquisition scopes, then races `runCleanupFunctionsSettled()` against a
1,500ms internal deadline modeled on the engine shutdown race
([`src/utils/gracefulShutdown.ts:449-476`](../../src/utils/gracefulShutdown.ts:449)).
On rejection it logs the bounded failure count; on timeout it records a bounded
cleanup-timeout diagnostic and proceeds to `process.exit()`. The timeout does
not claim every descendant was reaped: it is the self-exit liveness bound, while
the early generation abort and per-resource cleanup maximize reclamation within
it.

The default leaves 500ms for the supervisor's current 2,000ms SIGTERM grace
period before it force-kills the sidecar
([`app/supervisor/supervisor.ts:250-256`](../../app/supervisor/supervisor.ts:250)).
Any custom `killGraceMs` must remain strictly greater than the sidecar cleanup
deadline. This prevents SIGKILL from interrupting the sidecar before its timeout
diagnostic and transcript-lease release run.

All clean and fatal exit paths share this wrapper. Repeated calls join the same
promise; they do not rerun registrants. The app-runtime lifecycle's `dispose()`
and registry acquisition cleanup are idempotent.

Call it from every owned sidecar exit path:

- SIGTERM and SIGINT;
- idle time-to-live exit;
- idle park;
- best-effort fatal exit before `process.exit()`;
- any setup failure after executable MCP acquisition began.

The current clean path closes only the socket and transcript lease
([`app/sidecar/index.ts:590-620`](../../app/sidecar/index.ts:590)); the fatal path
exits directly
([`app/sidecar/index.ts:80-111`](../../app/sidecar/index.ts:80)).

Running the full registry is intentional. The sidecar is one engine process for
one session, and its other registrants (tasks, account refresh, watchers, and
bridges) also must not survive process shutdown. The bounded internal cleanup
race covers self-exit; externally initiated shutdown retains the supervisor's
independent SIGTERM-to-SIGKILL backstop. Neither path weakens die-with-window.

### 6. Keep agent MCP availability coherent

The runtime Agent tool already checks live `AppState.mcp.clients` and
`AppState.mcp.tools` and waits for matching pending servers, but its final
availability test parses `mcp__...` names and treats any MCP-prefixed tool as a
real server tool
([`src/tools/AgentTool/AgentTool.tsx:899-940`](../../src/tools/AgentTool/AgentTool.tsx:899)).
That is not a safe shared predicate: a `needs-auth` server contributes an
`mcp__...__authenticate` pseudo-tool
([`src/tools/McpAuthTool/McpAuthTool.ts:37-84`](../../src/tools/McpAuthTool/McpAuthTool.ts:37)),
and normalized display names can disagree with the original server name in
`mcpInfo`.

The desktop agent-config snapshot has a second, currently frozen MCP view:
`availableMcpServers` controls `missingMcpServers` and the displayed `available`
flag
([`app/sidecar/agentConfigDomain.ts:42-110`](../../app/sidecar/agentConfigDomain.ts:42)).
Add one engine-owned selector that returns server names satisfying both:

1. the matching client is `connected`; and
2. at least one tool has matching `mcpInfo.serverName` and a tool name other
   than the authentication pseudo-tool.

Use this selector from both `AgentTool` and `agentConfigDomain`, then rebroadcast
the existing `agent-config.snapshot` when the set changes. Do not treat merely
configured, pending, failed, or needs-auth clients as available. Tests must
cover needs-auth and original names containing spaces or punctuation.

This is an existing outbound snapshot, so it requires no new wire vocabulary or
preload surface. `SidecarServer` currently sends that snapshot only on attach
([`app/sidecar/sidecarServer.ts:1000-1005`](../../app/sidecar/sidecarServer.ts:1000));
add a `broadcastAgentConfigSnapshot()` counterpart to its existing task and goal
broadcasters and invoke it after lifecycle availability changes.

## Deliberate first-patch limits

### Project MCP approval

`getClaudeCodeMcpConfigs()` currently filters project servers through
`getProjectMcpServerStatus()`
([`src/services/mcp/config.ts:1164-1170`](../../src/services/mcp/config.ts:1164)).
That default behavior must remain unchanged for existing terminal and print
callers, but it is unsafe as the desktop selector because non-interactive mode
auto-approves pending project servers.

Add an explicit-only approval policy to the engine config API. It evaluates the
persisted rejected list, approved list, and approve-all setting from trusted
settings sources only (`userSettings`, `localSettings`, `flagSettings`, and
`policySettings`), explicitly excluding repository-authored `projectSettings`.
The existing dialogs persist their choices to `localSettings`
([`src/components/MCPServerApprovalDialog.tsx:24-52`](../../src/components/MCPServerApprovalDialog.tsx:24),
[`src/components/MCPServerMultiselectDialog.tsx:24-63`](../../src/components/MCPServerMultiselectDialog.tsx:24)).
The selector never uses the bypass/non-interactive fallback. The app-runtime
lifecycle requests this policy. Project servers that remain pending are absent
from both pending client state and connection work, so accepting workspace trust
cannot execute them.

The first patch adds no approval verb and does not edit the trust dialog.
Previously approved project servers continue to work. A new project's MCP
servers remain unavailable until approved from the terminal CLI. A future
desktop approval surface must identify the engine-discovered pending servers,
persist a selection through the engine's existing approval settings owner, and
use its own sidecar-validated request correlation.

The settings Extensions MCP view must use that same explicitly approved prepared
configuration. `extensionsDomain.ts` currently calls the default
`getClaudeCodeMcpConfigs()` independently
([`app/sidecar/extensionsDomain.ts:77-103`](../../app/sidecar/extensionsDomain.ts:77)),
which would otherwise show an unapproved project server that the lifecycle
correctly excludes. Pass the lifecycle's prepared configuration projection into
the extensions snapshot instead of rereading disk. This keeps the UI and runtime
consistent and avoids a second startup configuration read.

### Claude.ai connectors

The first implementation should load `getClaudeCodeMcpConfigs()`, which covers
enterprise, user, project, local, and plugin configuration with existing policy
and precedence
([`src/services/mcp/config.ts:1071-1250`](../../src/services/mcp/config.ts:1071)).
That is sufficient for the configured CuaDriver incident.

Do not silently use `getAllMcpConfigs()` in this first patch. It additionally
starts and awaits the network-backed claude.ai connector fetch
([`src/services/mcp/config.ts:1253-1289`](../../src/services/mcp/config.ts:1253)).
That fetch memoizes an empty result when no OAuth token exists and must be
explicitly cleared after login
([`src/services/mcp/claudeai.ts:39-59`](../../src/services/mcp/claudeai.ts:39),
[`src/services/mcp/claudeai.ts:136-143`](../../src/services/mcp/claudeai.ts:136)).
The desktop login callback currently changes the active provider but does not
refresh MCP
([`app/sidecar/sessionController.ts:655-659`](../../app/sidecar/sessionController.ts:655)).

Claude.ai MCP is a follow-up phase on the same lifecycle: clear and refetch after
successful OAuth, deduplicate against regular servers, then incrementally
connect. It must not force a second lifecycle implementation.

### Elicitation

Ordinary CuaDriver tool discovery and calls require no new protocol. Some MCP
tools can request URL elicitation. `QueryEngine` has an optional handler
([`src/QueryEngine.ts:169-171`](../../src/QueryEngine.ts:169)), and the MCP client
uses it when present
([`src/services/mcp/client.ts:2990-3001`](../../src/services/mcp/client.ts:2990)).
The desktop does not currently implement the corresponding request/response
control plane; P4-12 records it as separately deferred.

This design does not claim full elicitation parity. Adding it later requires its
own sidecar-local schema, engine-minted request correlation, boundary tests, and
renderer surface. It must not be hidden inside the tool-exposure patch. Until
then, the sidecar's `QueryEngineConfig` must supply an explicit fail-closed
`handleElicitation`, returning `{ action: 'cancel' }` for every request. Leaving
it undefined enters the REPL-only `AppState.elicitation.queue` promise path
([`src/services/mcp/client.ts:2990-3034`](../../src/services/mcp/client.ts:2990)),
which has no desktop renderer to resolve it and would hang the active turn.

### Runtime configuration changes

The first patch does not need settings-panel add/remove/toggle/reconnect verbs,
hot `.mcp.json` watching, plugin reload, list-changed notification rebroadcast,
or automatic remote reconnect. Those are distinct control and lifecycle work.
A new sidecar process must load current configuration correctly, initial
connections must be live and fail-soft, and a closed connection must immediately
lose its executable surfaces even when automatic reconnect is deferred.

### MCP resources

The lifecycle should retain discovered resources in `AppState.mcp.resources`.
The dynamic `QueryEngine` resource reader should also replace the current empty
context so MCP resource mentions work. The attachment resolver reads
`toolUseContext.options.mcpResources`, not the app-state store directly
([`src/utils/attachments.ts:2029-2043`](../../src/utils/attachments.ts:2029)).

If resource-context wiring is intentionally split from the CuaDriver fix, the
landed change must be described as MCP tool support rather than full MCP runtime
parity. The `ListMcpResourcesTool` and `ReadMcpResourceTool` helpers can work from
clients even while the separate `@`-resource attachment path remains absent.

## Implementation surface

### Engine

- `src/services/mcp/config.ts` and `src/services/mcp/utils.ts`: add the
  explicit-only project approval policy without changing default CLI/SDK
  semantics.
- `src/services/mcp/client.ts`: create and register the acquisition scope before
  any transport branch, immediately register each acquired resource, expose
  non-connecting disconnect, and publish every initial/auth/lazy replacement
  through one generation-aware owner. Export a narrowly scoped
  `_resetMcpClientStateForTest()` that clears every new acquisition registry,
  generation, replacement listener, and memoized connection state.
- `src/services/mcp/headersHelper.ts`: accept the acquisition abort signal and
  pass it to `execFileNoThrowWithCwd`.
- The Chrome and Computer Use MCP factories reached by `client.ts`: accept
  cancellation for blocking/executable setup and expose immediate cleanup
  ownership; no raced-and-abandoned setup promises.
- `src/utils/cleanupRegistry.ts`: add an all-settled cleanup runner while
  retaining existing behavior for unmigrated callers.
- `src/services/mcp/useManageMCPConnections.ts`: extract and reuse the pure
  per-server MCP state transition; retain React-only timers, notifications,
  elicitation registration, and reconnect effects in the hook.
- `src/main.tsx`: replace the print-mode pending/result update copy with the same
  extracted preparation and transition.
- One adjacent shared MCP state/availability module: own pending preparation,
  same-server replacement, disabled/failed clearing, resource handling, and the
  connected-with-real-tools selector used by React, print, desktop, and Agent.
- `src/tools/McpAuthTool/McpAuthTool.ts`: route post-auth replacement through the
  shared acquisition/transition owner instead of directly mutating MCP state.
- `src/tools/AgentTool/AgentTool.tsx`: use the shared availability selector
  rather than parsing MCP tool names, and pass the current atomic runtime
  snapshot after a pending-server wait.
- `src/tools/AgentTool/runAgent.ts`: initialize subagent MCP clients, tools,
  commands, and resources from that same current atomic snapshot rather than
  the turn-start `options.mcpClients`.
- One new `src/app-runtime/createAppRuntimeMcpLifecycle.ts`: imperative,
  trust-gated, generation-aware connection publication over the shared state
  transition and existing MCP client functions.
- `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts`: expose live
  atomic runtime snapshots, remove the frozen MCP `getAppState()` overlay for
  live callers, and preserve static defaults for other callers.
- `src/QueryEngine.ts`, `src/Tool.ts`, and `src/query.ts`: resolve one atomic
  runtime snapshot per submit, refresh tools/commands/clients/resources together
  between model iterations, and stop hard-coding empty resources.

### Desktop sidecar

- `app/sidecar/sessionController.ts`: create the MCP lifecycle over the existing
  store, remove empty MCP setup, return start/dispose ownership, and pass its
  prepared explicitly approved MCP configuration to `extensionsDomain.ts`.
- `app/sidecar/sidecarServer.ts`: invoke an internal callback after successful
  trust acceptance and rebroadcast the existing agent-config snapshot when MCP
  availability changes through a new `broadcastAgentConfigSnapshot()`.
- `app/sidecar/agentConfigDomain.ts`: derive available MCP servers from live MCP
  state through the shared connected-with-real-tools selector rather than a
  spawn-time empty array.
- `app/sidecar/index.ts`: start after trust without delaying socket readiness and
  route every clean/fatal exit through one idempotent 1,500ms
  all-settled-cleanup race, strictly below the supervisor grace period.

No change is required in Electron main, preload, renderer, shared protocol,
supervisor topology, or permission-response vocabulary.

## Tests

### Focused engine tests

1. Non-interactive desktop config excludes a pending project server, preserves
   explicit trusted-source approval/rejection, rejects a repository-authored
   approval key, and leaves default terminal/print behavior unchanged.
2. The extracted MCP state transition replaces one server's old tools, commands,
   and resources without disturbing other servers.
3. React, print, and app-runtime callers use that same transition rather than
   local copies.
4. Disabled and failed results clear that server's executable surfaces.
5. The app-runtime lifecycle seeds pending state without connecting before
   `start()`.
6. `start()` is idempotent and publishes each server as it settles.
7. Shutdown after a `stdio` child spawns but before connection/discovery settles
   aborts the pending transport and reaps the child.
8. Shutdown aborts a hanging `headersHelper`, and a failure after an in-process
   server starts closes that server before the connection promise rejects.
9. A transport close clears that server's tools, commands, and resources without
   disturbing peers.
10. Disposal closes initial and replacement connections, ignores late
   publication, and closes a late successful connection.
11. Authentication and `ensureConnectedClient()` replacements pass through the
    same acquisition generation and state transition.
12. A model request issued before transport close can reconnect a stale wrapper
    only after the replacement is registered to the active generation; a
    disposed or superseded generation fails closed before `tools/call`.
13. The app-runtime adapter returns real live `AppState.mcp` when runtime sources
    are present and retains static overlay behavior otherwise.
14. `QueryEngine` reads one current tools/commands/clients/resources snapshot on
    each submit.
15. The between-iteration refresh updates tools, commands, clients, and
    resources atomically.
16. A subagent launched after its pending required server settles receives the
    same-iteration atomic MCP clients, tools, commands, and resources.
17. Dynamic assembly retains injected `config.tools` for callers without a
    desktop runtime source.
18. The shared availability selector rejects needs-auth-only servers and matches
    connected server names containing spaces or punctuation via `mcpInfo`.
19. The all-settled registry runner starts every cleanup and waits for remaining
    cleanup when an unrelated registrant rejects.
20. Lifecycle disposal is safe before prepare/start and repeated calls share one
    cleanup operation. The MCP client test reset prevents acquisition state,
    listeners, and memoized clients leaking between tests.
21. The sidecar exits after its internal deadline when an unrelated registrant
    hangs, while a rejecting registrant does not skip MCP cleanup.

### Focused desktop tests

Use an isolated `CLAUDE_CONFIG_DIR`, isolated workspace, and a local fixture MCP
server. Never read or mutate the operator's live configuration.

1. A trusted user-configured fixture reaches pending and then connected state.
2. `ToolSearch select:mcp__fixture__ping` succeeds after connection.
3. An untrusted project `.mcp.json` command is never spawned.
4. A trusted but unapproved project `.mcp.json` command is never spawned, while
   a previously explicitly approved project server does start.
5. Accepting trust starts eligible MCP in the same sidecar without
   renderer-authored paths
   or a restart.
6. A fixture server that never completes connection does not delay socket
   creation or sidecar readiness beyond the supervisor deadline.
7. A failed server does not fail the desktop session or hide successful peers.
8. Calling the fixture tool emits `permission.requested`, and the fixture
   receives no `tools/call` before approval.
9. Allow and deny responses follow the existing T5a/T6/T6b behavior.
10. SIGTERM, idle exit, park, fatal exit, setup failure, shutdown during
    connection, and shutdown during a hanging headers helper leave no fixture
    child process alive.
11. Idle, park, and fatal self-exit remain bounded when an unrelated cleanup
    hangs; a rejecting unrelated cleanup does not prevent MCP cleanup.
12. A failing in-process setup invokes immediate cleanup for the server it
    already created.
13. An agent requiring the fixture server remains unavailable for needs-auth and
    transitions to available only after a connected server contributes a real
    tool.
14. A URL-eliciting fixture tool fails closed and completes the turn without
    placing an unrendered request in `AppState.elicitation.queue`.
15. The Extensions MCP snapshot excludes an unapproved project server and matches
    the lifecycle's prepared server set without a second configuration read.
16. The configured supervisor grace period exceeds the sidecar cleanup deadline,
    and SIGTERM permits timeout diagnostics plus transcript-lease release before
    force-kill eligibility.
17. If resource wiring lands in the same change, an MCP resource mention resolves
    through the real `QueryEngine` context.

A live CuaDriver GUI run is not required to prove the runtime join. A headless
real-sidecar fixture is stronger and deterministic. CuaDriver remains the
observed reproducer for final operator acceptance, which must be run only with
per-run GUI authorization.

## Verification battery

An implementation touches engine and desktop areas, so run both batteries:

```sh
bun test <focused app-runtime, MCP, ToolSearch, and permission tests>
bun run build:dev:full
bun test <focused sidecar MCP and lifecycle tests>
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
```

Run `renderer:build` only if renderer inputs change. This design requires no
renderer change.

Before completion, search source, tests, docs, configuration, YAML, and Markdown
for the empty desktop MCP setup and stale statements that desktop MCP is
config-only. Update the owning migration status row only when implementation and
the full battery have landed.

## Security and architecture rationale

This boundary is intentionally narrow:

- Configuration parsing, policy, transport setup, tool wrapping, permission
  identity, result handling, and cleanup remain engine-owned.
- The sidecar decides when workspace-trusted execution may begin; the engine's
  trusted-source approval selector independently decides which project MCP
  servers are eligible.
- Connection cleanup is acquired before transport start and follows every
  replacement path, while the sidecar owns only its process's shutdown.
- Electron main and preload gain no MCP data or authority.
- The renderer continues to submit prompts and answer engine-minted permission
  requests; it cannot name MCP commands, credentials, headers, environment
  variables, clients, or policy rules.
- Existing raw events carry MCP tool use, results, progress, and permission
  requests, so no lossy event mapper or protocol extension is needed.
- One process per session preserves MCP cache, client, child-process, and cleanup
  isolation.

Changing transport, process topology, permission-response architecture, or
renderer authority would not make the missing MCP wrappers appear in
`QueryEngine`. Those changes would enlarge the trust and lifecycle surface while
leaving the actual startup integration defect unresolved.

## Unresolved follow-ups

These do not block the first Cat Code-configured MCP tool implementation:

- desktop approval UI for previously unapproved project `.mcp.json` servers;
- claude.ai connector refresh after first login and account changes;
- MCP URL elicitation UI and correlated response protocol;
- settings-panel MCP mutation and reconnect controls;
- hot config/plugin reload and server list-change notifications;
- operator-authorized live CuaDriver acceptance after headless verification.
