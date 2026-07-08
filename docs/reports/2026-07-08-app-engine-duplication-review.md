# App ↔ Engine Machinery Duplication Review

Report-only review of the `migration` branch for module-level duplication where `app/` reimplements engine machinery already available under `src/`.

Architecture rule applied throughout: only `app/sidecar/` may import `src/` directly. Other desktop planes are engine-free; overlap there is a true duplication only when the capability should flow over the existing raw `AppSessionEvent` wire or `hostApi` control plane instead of being recomputed app-side.

## Verdict counts

- True duplication: 1
- Drift risk: 15
- Legitimate overlap: 30
- Candidates reviewed: 46

The single true duplication is `app/sidecar/sessionController.ts`: it still reassembles the normal QueryEngine app-session setup and hardcodes empty MCP runtime inputs instead of reusing an engine runtime setup entry point.

## Findings table

| Module | Capability | Engine counterpart | Overlap | Verdict | Action |
|---|---|---|---|---|---|
| `app/shared/limits.ts` | Desktop IPC/frame/history caps | `src/web/AppSessionWebSocketServer.ts:29`, `src/web/AppSessionWebSocketServer.ts:42`, `src/web/AppSessionWebSocketServer.ts:90`, `src/utils/sessionStorage.ts:260` | partial | legit | Keep. Desktop security/replay caps are sidecar/preload boundary policy, not reusable engine session limits. |
| `app/shared/hostApi.ts` | Desktop host control plane and session descriptors | `src/utils/listSessionsImpl.ts:33`, `src/utils/listSessionsImpl.ts:79`, `src/utils/listSessionsImpl.ts:439`, `src/entrypoints/agentSdkTypes.ts:129`, `src/entrypoints/agentSdkTypes.ts:204` | partial | legit | Keep. Host control plane is a separate desktop plane; engine SDK declarations are not the desktop host implementation. |
| `app/shared/protocol.ts` | Wire protocol plus mirrored snapshot types | `src/app-runtime/sessionEvents.ts:6`, `src/entrypoints/sdk/coreTypes.generated.ts:326`, `src/utils/settings/constants.ts:7`, `src/tools/AgentTool/loadAgentsDir.ts:136`, `src/utils/threadGoal.ts:4`, `src/utils/claudemd.ts:229` | partial | drift risk | Keep the raw-event protocol, but add parity/generated checks for mirrored unions. |
| `app/supervisor/supervisor.ts` | Sidecar process lifecycle, readiness, routing, restart | `src/bridge/sessionRunner.ts:248`, `src/bridge/sessionRunner.ts:335`, `src/bridge/sessionRunner.ts:491`, `src/remote/SessionsWebSocket.ts:84`, `src/remote/SessionsWebSocket.ts:369` | partial | legit | Keep. Desktop N-process Unix-socket supervision is app-owned. |
| `app/host/host.ts` | Durable host API over desktop sessions | `src/utils/listSessionsImpl.ts:439`, `src/utils/sessionRestore.ts:493`, `src/utils/conversationRecovery.ts:469`, `src/app-runtime/AppSessionController.ts:48` | partial | legit | Keep. It composes host registry/supervisor behavior around engine sessions. |
| `app/host/registry.ts` | Durable session registry, transcript path codec, liveness, locks, atomic JSON | `src/utils/sessionStorage.ts:220`, `src/utils/sessionStorage.ts:233`, `src/utils/sessionStoragePortable.ts:293`, `src/utils/sessionStoragePortable.ts:311`, `src/utils/lockfile.ts:33`, `src/utils/config.ts:835`, `src/utils/config.ts:1207`, `src/utils/config.ts:1355` | partial | drift risk | Add parity tests or extract an engine-free path codec for transcript/config path behavior. |
| `app/main/replayBuffer.ts` | Bounded renderer reload replay buffer | none found | none | legit | Keep. No engine counterpart found; this is desktop attachment replay state. |
| `app/main/attachmentGate.ts` | Renderer attach/readiness replay gate | `src/web/AppSessionWebSocketServer.ts:80`, `src/web/AppSessionWebSocketServer.ts:86`, `src/web/AppSessionWebSocketServer.ts:219` | partial | legit | Keep. Web ready/status handling is similar but not the Electron attach gate. |
| `app/main/devHarness.ts` | Dev/debug export persistence | `src/utils/config.ts:835`, `src/utils/config.ts:1172`, `src/utils/config.ts:1279`, `src/utils/config.ts:1350`, `src/utils/sessionStorage.ts:1923` | partial | legit | Keep. Dev harness export is not runtime engine machinery. |
| `app/main/main.ts` | Electron IPC bridge, supervisor frame routing, cwd token lifecycle, permission-response shaping | `src/web/AppSessionWebSocketServer.ts:80`, `src/web/AppSessionWebSocketServer.ts:136`, `src/web/AppSessionWebSocketServer.ts:160`, `src/app-runtime/AppSessionController.ts:87`, `src/app-runtime/appRuntimeCanUseTool.ts:61` | partial | legit | Keep. Main routes fixed IPC/control-plane calls while sidecar remains the engine boundary. |
| `app/sidecar/permissionDomain.ts` | Permission mode/context control over engine app-state store | `src/utils/permissions/permissionSetup.ts:896`, `src/utils/permissions/permissionSetup.ts:1063`, `src/utils/permissions/PermissionUpdate.ts:52`, `src/utils/permissions/PermissionUpdate.ts:193`, `src/utils/permissions/PermissionUpdate.ts:367` | full | legit | Keep. It is a thin adapter over the same store/runtime permission machinery. |
| `app/sidecar/sessionResume.ts` | Engine session resume | `src/utils/sessionRestore.ts:105`, `src/utils/sessionRestore.ts:493`, `src/utils/conversationRecovery.ts:417`, `src/utils/conversationRecovery.ts:469`, `src/utils/sessionStorage.ts:3122` | full | legit | Keep. It routes through real engine resume machinery. |
| `app/sidecar/settingsDomain.ts` | Settings source/precedence snapshot | `src/utils/settings/constants.ts:7`, `src/utils/settings/constants.ts:159`, `src/utils/settings/settings.ts:310`, `src/utils/settings/settings.ts:733`, `src/utils/settings/settings.ts:900` | full | drift risk | Add parity tests for source order, labels, editability, and precedence. |
| `app/sidecar/agentConfigDomain.ts` | Agent/tool/MCP metadata snapshot | `src/tools/AgentTool/loadAgentsDir.ts:136`, `src/tools/AgentTool/loadAgentsDir.ts:186`, `src/tools/AgentTool/loadAgentsDir.ts:193`, `src/tools/AgentTool/loadAgentsDir.ts:229`, `src/tools.ts:217`, `src/tools.ts:385`, `src/services/mcp/client.ts:2228` | full | drift risk | Add generated/fixture parity tests against real `AgentDefinitionsResult`, tool, and MCP metadata. |
| `app/sidecar/index.ts` | Runtime init, resume, restored messages, sidecar session construction | `src/main.tsx:3159`, `src/main.tsx:3173`, `src/main.tsx:3197`, `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:39` | partial | legit | Keep. Entrypoint composition is desktop-specific, though it should consume extracted setup if `sessionController` is fixed. |
| `app/sidecar/goalDomain.ts` | Thread-goal snapshot projection | `src/app-runtime/sessionEvents.ts:6`, `src/app-runtime/AppSessionController.ts:74`, `src/app-runtime/AppSessionController.ts:80`, `src/utils/threadGoal.ts:10`, `src/utils/threadGoalActions.ts:23`, `src/utils/threadGoalController.ts:15` | full | drift risk | Add compile-time shape and fixture checks for every goal status/progress case. |
| `app/sidecar/memoryDomain.ts` | Instruction and auto-memory metadata snapshot | `src/utils/claudemd.ts:92`, `src/utils/claudemd.ts:229`, `src/utils/claudemd.ts:618`, `src/utils/claudemd.ts:697`, `src/utils/claudemd.ts:790`, `src/services/SessionMemory/sessionMemoryUtils.ts:32`, `src/services/SessionMemory/sessionMemoryUtils.ts:110` | full | drift risk | Add parity fixtures for memory type unions and metadata fields. |
| `app/sidecar/sessionController.ts` | QueryEngine config seam: tools, commands, agents, permissions, file cache, initial messages, MCP state | `src/main.tsx:3159`, `src/main.tsx:3173`, `src/main.tsx:3197`, `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:10`, `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:39` | full | true duplication | Extract/reuse the engine runtime setup builder instead of manually reassembling setup with empty MCP inputs. |
| `app/sidecar/sidecarServer.ts` | Sidecar trust boundary, inbound validation, permission hardening, raw frames, restored-history replay | `src/web/AppSessionWebSocketServer.ts:42`, `src/web/AppSessionWebSocketServer.ts:90`, `src/web/AppSessionWebSocketServer.ts:136`, `src/app-runtime/appRuntimeCanUseTool.ts:67`, `src/app-runtime/appRuntimeCanUseTool.ts:76`, `src/app-runtime/sessionEvents.ts:46` | partial | legit | Keep. Sidecar-local validation and raw frame forwarding are protected boundary behavior. |
| `app/renderer/src/PermissionPrompt.tsx` | Permission card actions and suggestion display | `src/components/permissions/PermissionRequest.tsx`, `src/hooks/toolPermission/PermissionContext.ts:291`, `src/utils/permissions/PermissionPromptToolResultSchema.ts:84` | partial | drift risk | Add fixture coverage for every `PermissionUpdate` variant displayed by the renderer. |
| `app/renderer/src/PermissionQueue.tsx` | Pending permission queue UI | `src/hooks/toolPermission/PermissionContext.ts:57`, `src/hooks/toolPermission/PermissionContext.ts:357`, `src/components/permissions/PermissionRequest.tsx` | partial | legit | Keep. Renderer queue is projection/presentation over sidecar permission frames. |
| `app/renderer/src/PermissionRulesEditor.tsx` | Permission modes/rules UI and mode-switch requests | `src/utils/permissions/permissionSetup.ts:689`, `src/utils/permissions/permissionSetup.ts:896`, `src/utils/permissions/permissions.ts:123`, `src/utils/permissions/permissions.ts:214`, `src/components/Settings/Config.tsx:492` | partial | legit | Keep. Renderer displays read-only context and sends allowed mode changes; sidecar owns validation. |
| `app/renderer/src/connectionState.ts` | Fold server frames into renderer connection state | `src/web/AppSessionWebSocketServer.ts:219`, `src/web/AppSessionWebSocketServer.ts:223`, `src/remote/SessionsWebSocket.ts:84`, `src/remote/SessionsWebSocket.ts:134`, `src/remote/SessionsWebSocket.ts:232` | partial | legit | Keep. Desktop display projection. |
| `app/renderer/src/TranscriptView.tsx` | Transcript/tool/diff rendering | `src/components/Messages.tsx:344`, `src/components/Messages.tsx:481`, `src/components/Message.tsx:419`, `src/components/Message.tsx:498`, `src/components/messages/AssistantToolUseMessage.tsx:72` | partial | legit | Keep. Engine Ink UI cannot be imported into renderer; this is presentation over projected rows. |
| `app/renderer/src/tabStatus.ts` | Tab status derivation | none found | none | legit | Keep. Desktop-shell presentation state. |
| `app/renderer/src/permissionState.ts` | Permission queue reducer/selectors and allow/deny response builders | `src/entrypoints/sdk/coreTypes.generated.ts:356`, `src/entrypoints/sdk/coreTypes.generated.ts:364`, `src/utils/permissions/PermissionPromptToolResultSchema.ts:47`, `src/utils/permissions/PermissionPromptToolResultSchema.ts:60`, `src/hooks/toolPermission/PermissionContext.ts:285` | partial | legit | Keep. Renderer builds bounded responses for sidecar validation; engine still verifies request IDs. |
| `app/renderer/src/rawMessageLog.ts` | Diagnostic raw SDK message retention | none found | none | legit | Keep. No engine in-memory debug log counterpart found. |
| `app/renderer/src/transcriptProjector.ts` | SDKMessage/server-frame projection to desktop rows | `src/remote/sdkMessageAdapter.ts:168`, `src/remote/sdkMessageAdapter.ts:173`, `src/remote/sdkMessageAdapter.ts:217`, `src/remote/sdkMessageAdapter.ts:250`, `src/components/Messages.tsx:520`, `src/components/MessageRow.tsx:151` | partial | legit | Keep. This is the designed renderer anti-corruption/projection boundary over raw events. |
| `app/renderer/src/SlashCommandPicker.tsx` | Slash-command typeahead over `system/init` metadata | `src/commands.ts:437`, `src/commands.ts:501`, `src/commands.ts:572`, `src/commands.ts:588`, `src/commands.ts:611`, `src/commands.ts:753`, `src/entrypoints/sdk/coreTypes.generated.ts:449` | partial | legit | Keep. It consumes engine-provided command names rather than rediscovering commands. |
| `app/renderer/src/commandPaletteModel.ts` | Desktop command/session palette model | `src/utils/listSessionsImpl.ts:439`, `src/utils/sessionRestore.ts:493`, `src/screens/ResumeConversation.tsx:231`, `src/entrypoints/agentSdkTypes.ts:129` | partial | legit | Keep. Desktop shell actions over host API. |
| `app/renderer/src/CommandPalette.tsx` | Command palette UI/dispatcher | none found | none | legit | Keep. Pure desktop UI. |
| `app/renderer/src/ToolInspector.tsx` | Tool input/result/diff summaries | `src/Tool.ts:391`, `src/Tool.ts:494`, `src/Tool.ts:530`, `src/Tool.ts:572`, `src/Tool.ts:611`, `src/components/messages/AssistantToolUseMessage.tsx:306`, `src/components/messages/AssistantToolUseMessage.tsx:330` | partial | drift risk | Add fixture coverage from representative built-in tool inputs, or move summary metadata into projected engine/tool metadata. |
| `app/renderer/src/SettingsField.tsx` | Setting source/provenance/effective value display | `src/utils/settings/constants.ts:26`, `src/utils/settings/constants.ts:46`, `src/utils/settings/constants.ts:72`, `src/utils/settings/settings.ts:930`, `src/components/Settings/Config.tsx:492` | partial | drift risk | Add parity tests for source labels and order. |
| `app/renderer/src/SettingsShell.tsx` | Settings page over settings snapshots | `src/utils/settings/settings.ts:930`, `src/utils/settings/settings.ts:935`, `src/components/Settings/Settings.tsx:89`, `src/components/Settings/Config.tsx:1264` | partial | legit | Keep. Desktop/prototype presentation over sidecar snapshots. |
| `app/renderer/src/agentIdentity.ts` | Agent/worker display vocabulary and status derivation | `src/tools/AgentTool/UI.tsx:780`, `src/tools/AgentTool/UI.tsx:867`, `src/agent-mode/AgentModeWorkerRoster.tsx:11`, `src/agent-mode/AgentModeWorkerRoster.tsx:77` | partial | drift risk | Add shared/generated fixtures for worker role/status labels and agent-tool state vocabulary. |
| `app/renderer/src/TabBar.tsx` | Desktop tab UI | none found | none | legit | Keep. No engine tab-bar counterpart. |
| `app/renderer/src/ConnectionChip.tsx` | Connection/session status chip | `src/remote/SessionsWebSocket.ts:38`, `src/remote/SessionsWebSocket.ts:134`, `src/remote/SessionsWebSocket.ts:232`, `src/components/StatusLine.tsx:41`, `src/web/AppSessionWebSocketServer.ts:223` | partial | legit | Keep. Desktop status display projection. |
| `app/renderer/src/shellState.ts` | Host-event roster/tab reducer | `src/utils/listSessionsImpl.ts:33`, `src/utils/listSessionsImpl.ts:439`, `src/app-runtime/AppSessionController.ts:63`, `src/app-runtime/sessionEvents.ts:46` | partial | legit | Keep. Host-event projection for desktop shell state. |
| `app/renderer/src/sidebarState.ts` | Sidebar rows from descriptors/status/restorability | `src/utils/listSessionsImpl.ts:33`, `src/utils/listSessionsImpl.ts:79`, `src/utils/listSessionsImpl.ts:278`, `src/utils/listSessionsImpl.ts:439` | partial | legit | Keep. Desktop host roster presentation. |
| `app/renderer/src/agentConfigState.ts` | Agent config reducers/selectors and grouping | `src/tools/AgentTool/loadAgentsDir.ts:186`, `src/tools/AgentTool/loadAgentsDir.ts:193`, `src/tools/AgentTool/loadAgentsDir.ts:229`, `src/tools.ts:385`, `src/services/mcp/client.ts:2228`, `src/services/mcp/client.ts:2410` | partial | drift risk | Sync tests for source taxonomy, active/overridden status, and MCP metadata. |
| `app/renderer/src/AgentsPage.tsx` | Agent/tool/MCP metadata page | `src/components/agents/AgentsList.tsx:96`, `src/components/agents/AgentsList.tsx:146`, `src/components/agents/AgentEditor.tsx:47`, `src/tools/AgentTool/loadAgentsDir.ts:136`, `src/services/mcp/client.ts:2228` | partial | drift risk | Add fixture parity against real `AgentDefinition` snapshots. |
| `app/renderer/src/goalMemoryState.ts` | Goal and memory snapshot reducers/selectors/counts | `src/utils/threadGoal.ts:222`, `src/utils/threadGoal.ts:235`, `src/utils/claudemd.ts:1178`, `src/utils/claudemd.ts:1189`, `src/services/SessionMemory/sessionMemoryUtils.ts:143` | partial | drift risk | Add protocol/engine union parity fixtures for goal and memory snapshots. |
| `app/renderer/src/GoalsPage.tsx` | Thread-goal status/progress/time display | `src/utils/threadGoal.ts:10`, `src/utils/threadGoal.ts:209`, `src/utils/threadGoal.ts:222`, `src/utils/threadGoal.ts:464`, `src/utils/threadGoalActions.ts:23`, `src/utils/threadGoalActions.ts:102` | partial | drift risk | Add fixtures against engine thread-goal formatting/status cases. |
| `app/renderer/src/MemoryPage.tsx` | Instruction-file and auto-memory display | `src/utils/claudemd.ts:229`, `src/utils/claudemd.ts:790`, `src/utils/claudemd.ts:1178`, `src/utils/claudemd.ts:1220`, `src/services/SessionMemory/sessionMemoryUtils.ts:110` | partial | drift risk | Add memory type/label/count parity fixtures. |
| `app/renderer/src/App.tsx` | Renderer shell composition, bridge subscriptions, session actions, permission handling, transcript/debug state | `src/app-runtime/AppSessionController.ts:63`, `src/app-runtime/AppSessionController.ts:87`, `src/app-runtime/AppSessionController.ts:127`, `src/web/AppSessionWebSocketServer.ts:80`, `src/utils/sessionRestore.ts:493`, `src/remote/sdkMessageAdapter.ts:168` | partial | legit | Keep. Desktop orchestration/projection over existing wire/control planes. |
| `app/renderer/src/Sidebar.tsx` | Session roster/restore/close/restart UI | `src/utils/listSessionsImpl.ts:439`, `src/screens/ResumeConversation.tsx:231`, `src/utils/sessionRestore.ts:493`, `src/entrypoints/agentSdkTypes.ts:204`, `src/entrypoints/agentSdkTypes.ts:219` | partial | legit | Keep. Desktop host roster presentation. |

## True duplication reasoning

### `app/sidecar/sessionController.ts`

`app/sidecar/sessionController.ts` is the one true module-level duplication found in this review.

The sidecar manually constructs the QueryEngine app-session setup in `createNormalSidecarQueryEngineConfig` (`app/sidecar/sessionController.ts:139-206`). It does correctly load the real permission context, built-in tools, slash command catalog, and agent definitions, which means the prior P1-3/P2-4/P3-7 failures have been partially repaired. But it still reassembles the runtime setup app-side and hardcodes MCP runtime inputs to empty values: `mcpClients: []`, `availableMcpServers: []`, `mcpTools: []`, `mcpCommands: []`, and `mcpResources: {}` (`app/sidecar/sessionController.ts:172-187`).

The engine web runtime already has the real setup pattern in `src/main.tsx:3159-3198`: it creates the app-state store, waits for `mcpPromise`, writes real MCP clients/tools/commands/resources into app state, and calls `createQueryEngineAppSessionConfigFromSetup` with those real runtime values. The canonical config combiner is already factored at `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:39-118`, and its setup type explicitly includes `mcpTools`, `mcpCommands`, `mcpClients`, `mcpResources`, agents, app state accessors, and the read-file cache (`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:10-34`).

This is the same structural defect class as the earlier `tools: []`, empty permission context, and `commands: []` incidents: the sidecar seam can silently diverge from normal engine startup while the desktop still appears to work for simpler sessions.

Migration path:

1. Extract the runtime-backed app-session setup currently embedded in `src/main.tsx:3159-3198` into an engine entry point under `src/app-runtime/`, for example `createRuntimeAppSessionSetup(...)`.
2. Have that entry point return the app-state store, `QueryEngineAppSessionConfig`, agent definitions, available MCP server metadata, and any snapshot inputs the sidecar needs.
3. Make `app/sidecar/sessionController.ts` import and call that engine entry point instead of reassembling tools, commands, agents, permission context, file cache, and MCP runtime state by hand.
4. Add a live-path sidecar test with fake MCP tools, commands, resources, and agent definitions proving the desktop sidecar config contains the same runtime state as the engine web runtime.

## Drift-risk reasoning

### `app/shared/protocol.ts`

The protocol itself is legitimate: raw `AppSessionEvent` fidelity and sidecar-local validation are locked migration decisions. The drift risk is in the mirrored snapshot vocabulary around settings, agents, goals, memory, and permissions. The app protocol must define serializable wire shapes, but fields such as setting source identifiers, agent source/status shapes, goal statuses, and memory metadata can rot when engine source evolves. Add type-level parity tests or generated snapshot types from the corresponding engine definitions.

### `app/host/registry.ts`

The host registry is engine-free by design, so it cannot import `src/` directly. However, it mirrors engine-sensitive behavior: config-home selection, transcript path derivation, project path sanitization/hash fallback, lock handling, and atomic JSON persistence. That is legitimate host-plane code but high drift risk because restore depends on exact agreement with engine transcript layout. Add parity tests for normal paths, long-path hash fallback, Unicode normalization, and `CLAUDE_CONFIG_DIR`, or extract an engine-free path codec that both host and engine can consume.

### `app/sidecar/settingsDomain.ts`

This module uses real engine settings readers, so it is not true duplication. The drift risk is the app snapshot model around source order, display labels, editability, and precedence. If engine settings sources or policy behavior change, the desktop settings page could display stale provenance. Add tests that compare the sidecar snapshot source list/order/editability against `src/utils/settings/constants.ts` and effective settings behavior from `src/utils/settings/settings.ts`.

### `app/sidecar/agentConfigDomain.ts`, `app/renderer/src/agentConfigState.ts`, and `app/renderer/src/AgentsPage.tsx`

These surfaces legitimately expose agent/tool/MCP metadata to an engine-free renderer. The drift risk is the duplicated taxonomy: source ordering, active versus overridden semantics, MCP requirement availability, display labels, and tool metadata. Add generated fixture snapshots from real `AgentDefinitionsResult` cases, including built-ins, user/project/local agents, policy/flag overrides, plugins if applicable, and required MCP servers.

### `app/sidecar/goalDomain.ts`, `app/renderer/src/goalMemoryState.ts`, and `app/renderer/src/GoalsPage.tsx`

Goal state must flow to the renderer as snapshots, but the app mirrors engine facts about goal statuses, progress, token/time budgets, and display states. Add compile-time shape checks against the engine goal type and fixture coverage for every status, completed/paused/budget-limited state, and budget/no-budget display case.

### `app/sidecar/memoryDomain.ts`, `app/renderer/src/goalMemoryState.ts`, and `app/renderer/src/MemoryPage.tsx`

Memory and instruction metadata are engine-owned domains exposed as read-only desktop snapshots. The app-side display and grouping are legitimate, but memory type labels, frontmatter fields, `contentDiffersFromDisk`, parent/glob metadata, and auto-memory headers can drift. Add parity fixtures covering every memory type and representative instruction-file metadata from engine scanners.

### `app/renderer/src/PermissionPrompt.tsx`

The renderer must display engine-minted permission update suggestions and return a selected decision through the sidecar boundary. The drift risk is `PermissionUpdate` display semantics: if the engine adds or changes update variants, the renderer can mislabel what the user is accepting. Add a fixture test covering every `PermissionUpdate` variant and make new variants fail visibly.

### `app/renderer/src/ToolInspector.tsx`

The inspector is display-only, so it is not true duplication of tool execution or tool validation. The drift risk is hardcoded tool-input summary heuristics. As tool schemas evolve, the inspector can emphasize stale fields or miss important ones. Add fixture coverage from representative built-in tool inputs, or have the sidecar/projector supply summary metadata derived from engine tool definitions.

### `app/renderer/src/SettingsField.tsx`

The component is legitimate desktop presentation over sidecar settings snapshots. The drift risk is hardcoded setting source labels/classes and source-order presentation. Add parity tests against engine source labels and order from `src/utils/settings/constants.ts`.

### `app/renderer/src/agentIdentity.ts`

Agent and worker display labels are renderer presentation, but the vocabulary overlaps terminal AgentTool and Agent Mode status semantics. Add shared/generated fixtures for worker roles, task statuses, stale/result-ready states, and agent-tool display labels.

## Non-findings worth preserving

- `app/renderer/src/transcriptProjector.ts` is not a true duplication finding. It is the designed renderer anti-corruption boundary over raw engine events and SDK messages. Keep the existing exhaustiveness/fixture discipline rather than trying to import Ink message UI.
- `app/sidecar/permissionDomain.ts` is not true duplication. It operates over the same engine app-state store and routes updates through engine permission machinery; keep it thin.
- `app/sidecar/sessionResume.ts` is not true duplication. It already routes through engine resume/recovery machinery instead of parsing transcripts independently.
- `app/main/replayBuffer.ts` and `app/main/attachmentGate.ts` are desktop attachment/reload mechanics. They are not engine transcript replay machinery.
