import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createQueryEngineAppSessionConfigFromSetup } from '../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { createRuntimeBackedWebAppSession } from '../../src/app-runtime/createRuntimeBackedWebAppSession.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { getInitialEffortSetting } from '../../src/utils/effort.js'
import {
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
  type ModelSetting,
} from '../../src/utils/model/model.js'
import {
  getEnvAPIProvider,
  resolveStartupProvider,
} from '../../src/utils/model/providers.js'
import {
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setProviderSwitchLocked,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { getTools } from '../../src/tools.js'
import { getCommands, type Command } from '../../src/commands.js'
import type { SlashCatalogEntry } from '../shared/protocol.js'
import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinitionsResult,
} from '../../src/tools/AgentTool/loadAgentsDir.js'
import { createStore } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import {
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from '../../src/utils/permissions/permissionSetup.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../src/utils/fileStateCache.js'
import type { Message } from '../../src/types/message.js'
import { SYNTHETIC_MODEL } from '../../src/utils/messages.js'
import { createProbeAdapter } from './probeAdapter.js'
import {
  createSidecarPermissionDomain,
  type SidecarPermissionDomain,
} from './permissionDomain.js'
import {
  createSidecarSettingsDomain,
  loadAvailableSettingOptions,
  type SidecarSettingsDomain,
} from './settingsDomain.js'
import {
  createSidecarAgentConfigDomain,
  type SidecarAgentConfigDomain,
} from './agentConfigDomain.js'
import {
  createSidecarGoalDomain,
  type SidecarGoalDomain,
} from './goalDomain.js'
import {
  createSidecarMemoryDomain,
  type SidecarMemoryDomain,
} from './memoryDomain.js'
import {
  createSidecarTasksDomain,
  type SidecarTasksDomain,
} from './tasksDomain.js'
import {
  createSidecarAgentModeDomain,
  type SidecarAgentModeDomain,
} from './agentModeDomain.js'
import {
  createSidecarTaskControlDomain,
  type SidecarTaskControlDomain,
} from './taskControlDomain.js'
import {
  createSidecarRunControlsDomain,
  type SidecarRunControlsDomain,
} from './runControlsDomain.js'
import {
  createSidecarSessionActionsDomain,
  type SidecarSessionActionsDomain,
} from './sessionActionsDomain.js'
import {
  createSidecarAccountsDomain,
  type SidecarAccountsDomain,
} from './accountsDomain.js'
import {
  createSidecarWorkspaceTrustDomain,
  type SidecarWorkspaceTrustDomain,
} from './workspaceTrustDomain.js'
import {
  createSidecarDiagnosticsDomain,
  type SidecarDiagnosticsDomain,
} from './diagnosticsDomain.js'
import {
  createSidecarExtensionsDomain,
  loadExtensionsSnapshot,
  type SidecarExtensionsDomain,
} from './extensionsDomain.js'
import {
  createSidecarRemoteSettingsDomain,
  type SidecarRemoteSettingsDomain,
} from './remoteSettingsDomain.js'

/**
 * Load the REAL settings-derived permission context for a desktop session,
 * mirroring the CLI bootstrap (src/main.tsx:1787-1811): mode from
 * `initialPermissionModeFromCLI` (settings `permissions.defaultMode`, no CLI
 * flags), rules/directories/bypass-availability from
 * `initializeToolPermissionContext`, then the CLI's two post-steps. This
 * fixes the PERMISSION-BOUNDARY.md §8 defect (same class as P1-3's
 * `tools: []`): the P1-2..P2-3 sidecar built its context from
 * `getEmptyToolPermissionContext()`, so settings-file allow/deny rules and
 * defaultMode were never in effect and C3 snapshots would have shown a
 * falsely empty policy.
 */
export async function loadSidecarToolPermissionContext(): Promise<ToolPermissionContext> {
  const { mode } = initialPermissionModeFromCLI({
    permissionModeCli: undefined,
    dangerouslySkipPermissions: undefined,
  })
  const initResult = await initializeToolPermissionContext({
    allowedToolsCli: [],
    disallowedToolsCli: [],
    permissionMode: mode,
    allowDangerouslySkipPermissions: false,
    addDirs: [],
  })

  // The CLI's post-steps (main.tsx:1802-1811). Both arrays are only populated
  // under their own engine-side gates (ant overly-broad detection; auto-mode
  // dangerous-rule stripping), so presence is the faithful condition here.
  let toolPermissionContext = initResult.toolPermissionContext
  if (initResult.overlyBroadBashPermissions.length > 0) {
    toolPermissionContext = removeDangerousPermissions(
      toolPermissionContext,
      initResult.overlyBroadBashPermissions,
    )
  }
  if (initResult.dangerousPermissions.length > 0) {
    toolPermissionContext = stripDangerousPermissionsForAutoMode(
      toolPermissionContext,
    )
  }
  return {
    ...toolPermissionContext,
    // PERMISSION-BOUNDARY.md §3: bypass is only grantable from a TRUSTED
    // surface. The desktop's trusted surface is the launch env var
    // `CATCODE_ALLOW_BYPASS=1` (the operator sets it before the renderer loads,
    // mirroring the CLI's --dangerously-skip-permissions launch flag). Read
    // here at session construction — NEVER from a renderer frame — so a
    // browser-like renderer cannot self-escalate. Off by default; when set, the
    // sidecar's `permission.setMode` boundary honours a bypass request
    // (`sidecarServer.ts` handleSetMode reads this same context flag).
    isBypassPermissionsModeAvailable:
      process.env.CATCODE_ALLOW_BYPASS === '1',
  }
}

/**
 * Load the real command catalog, degrading to `[]` on any failure. The catalog
 * is not session-critical (see the call site), so a failed load must never
 * throw out of session construction — it logs loudly and the session runs
 * without slash commands (the pre-P3-7 behaviour).
 */
async function loadCommandCatalog(cwd: string): Promise<Command[]> {
  try {
    return await getCommands(cwd)
  } catch (error) {
    process.stderr.write(
      `[sidecar] command catalog load failed (session runs without slash commands): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return []
  }
}

/**
 * Load the real agent definitions for this desktop session. This is runtime
 * setup, not the P4-7 snapshot read path: the returned active definitions are
 * passed into QueryEngine and the same result is mirrored to the read-only UI
 * snapshot, so the page never claims agents that the session did not configure.
 */
async function loadAgentDefinitionsForRuntime(
  cwd: string,
): Promise<AgentDefinitionsResult> {
  try {
    return await getAgentDefinitionsWithOverrides(cwd)
  } catch (error) {
    process.stderr.write(
      `[sidecar] agent definition load failed (session runs without custom agents): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return { activeAgents: [], allAgents: [] }
  }
}

/**
 * Seed the desktop sidecar's process-local model/provider state using the same
 * explicit-vs-implicit startup rule as the CLI. A sidecar is one process per
 * session, so these bootstrap globals are correctly session-scoped.
 */
export function initializeSidecarModelProvider(
  resumedModel?: string,
): ModelSetting {
  // A resumed conversation owns its prior model choice. The transcript's latest
  // assistant message contains the provider-returned model id, so prefer it over
  // today's global/settings default when reconstructing this session.
  const specifiedModel = resumedModel ?? getUserSpecifiedModelSetting()
  const selectedModel = specifiedModel ?? null
  const implicitProvider = getEnvAPIProvider()
  // The model argument is ignored for an implicit startup. Avoid resolving the
  // Anthropic default here: credential-less desktop startup must still reach
  // the first-run sign-in surface (and the test guard intentionally throws).
  const resolvedModel =
    specifiedModel === undefined || specifiedModel === null
      ? null
      : parseUserSpecifiedModel(specifiedModel)

  setInitialMainLoopModel(selectedModel)
  setMainLoopModelOverride(selectedModel)
  setSessionProvider(
    resolveStartupProvider(
      resolvedModel,
      specifiedModel !== undefined && specifiedModel !== null,
      implicitProvider,
    ),
  )
  return selectedModel
}

export function selectResumedProviderModel(
  messages: readonly Message[],
): string | undefined {
  return [...messages]
    .reverse()
    .find(
      (message): message is Extract<Message, { type: 'assistant' }> =>
        message.type === 'assistant' &&
        message.isApiErrorMessage !== true &&
        typeof message.message.model === 'string' &&
        message.message.model.length > 0 &&
        message.message.model !== SYNTHETIC_MODEL,
    )?.message.model
}

export function hasProviderBoundHistory(messages: readonly Message[]): boolean {
  return messages.some(
    message =>
      (message.type === 'assistant' &&
        message.isApiErrorMessage !== true &&
        message.message.model !== SYNTHETIC_MODEL) ||
      (message.type === 'user' &&
        message.isMeta !== true &&
        message.isVisibleInTranscriptOnly !== true),
  )
}

export async function createNormalSidecarQueryEngineConfig(
  cwd: string,
  initialMessages?: readonly Message[],
) {
  // Must run before QueryEngine construction: it captures the initial provider
  // and model for prompt assembly and request routing.
  const resumedModel = initialMessages
    ? selectResumedProviderModel(initialMessages)
    : undefined
  const initialModelSetting = initializeSidecarModelProvider(resumedModel)
  const toolPermissionContext = await loadSidecarToolPermissionContext()
  const appStateStore = createStore({
    ...getDefaultAppState(),
    toolPermissionContext,
    mainLoopModel: initialModelSetting,
    mainLoopModelForSession: null,
    // Honour the user's persisted reasoning-effort setting, exactly as the CLI
    // seeds it at startup (`main.tsx:2688` — `getInitialEffortSetting()`). The
    // desktop session otherwise ran on `getDefaultAppState()`'s `undefined`
    // effort, silently ignoring the user's `/effort` choice; the QueryEngine
    // reads `appState.effortValue` per request (`query.ts:744`). undefined when
    // no effort is set (→ provider default), which the diagnostics snapshot
    // reports as null rather than a fabricated label.
    effortValue: getInitialEffortSetting(),
  })
  const tools = getTools(appStateStore.getState().toolPermissionContext)

  // Load the REAL command catalog for this cwd, mirroring the non-interactive
  // CLI path (`cli/print.ts:1783` / `main.tsx:2069` both pass `getCommands(cwd)`
  // into the query). Shipping `commands: []` was the same defect class as
  // P1-3's `tools: []` and P2-4's empty permission context: the engine could
  // parse/execute no slash command, and the `system/init` SDKMessage's
  // `slash_commands` field (built from these commands in
  // `systemInit.ts:69`, filtered to `userInvocable !== false`) arrived EMPTY —
  // so the desktop shell's slash typeahead had nothing real to show. Populating
  // it surfaces the catalog through the EXISTING outbound `system/init` frame
  // (P3-7 CommandPalette/SlashCommandPicker wiring) with no new wire vocabulary,
  // and lets the engine parse `/command` submits (execution stays engine-side;
  // QueryEngine runs them under `isNonInteractiveSession: true`, the same guard
  // print-mode relies on).
  //
  // Unlike resume (anti-Potemkin-critical → fail loud), the command catalog is
  // NOT session-critical: a session is fully usable without slash commands. So a
  // catalog-load failure degrades to `[]` (empty picker + no engine-side slash
  // parsing — exactly the prior behaviour) with a loud stderr log, rather than
  // crashing session construction. `getCommands` is already internally fail-soft
  // for skill/plugin loads; this guards the remaining eager built-in factories.
  const commands = await loadCommandCatalog(cwd)
  const agentDefinitions = await loadAgentDefinitionsForRuntime(cwd)
  const mcpClients: [] = []
  const availableMcpServers: string[] = []

  // P4-12 settings-extensions read-seam: build the spawn-time MCP/plugins/skills/
  // hooks snapshot from the SAME loaded catalogs the runtime uses (skills ⊂
  // `commands`, plugin provides ⊂ `agentDefinitions`) plus the live app-state
  // (hooks). Never throws — a per-slice failure degrades to null inside the loader.
  const extensionsSnapshot = await loadExtensionsSnapshot({
    commands,
    agentDefinitions: agentDefinitions.allAgents,
    appState: appStateStore.getState(),
  })

  // The composer SlashCommandPicker renders name + arg-hint + description columns
  // (prototype parity). The engine's `system/init.slash_commands` is NAMES ONLY
  // (the locked SDK shape, `systemInit.ts:69`), so the P3-7 picker shipped
  // name-only — the drift the operator saw. The description/argumentHint live on
  // the `Command` objects the sidecar already loaded (`commands`, above); project
  // the SAME user-invocable set `slash_commands` ships (`userInvocable !== false`)
  // into the rich display catalog, delivered as a read-only outbound snapshot on
  // connect (`slash-catalog.snapshot`, the C3 read-seam pattern) so the picker
  // has real descriptions before the first turn. `name` matches `slash_commands`
  // exactly (`c.name`), so completing a pick still inserts `/name` the engine
  // parses. Spawn-frozen; the sidecar never re-broadcasts it.
  const slashCatalog: SlashCatalogEntry[] = commands
    .filter(command => command.userInvocable !== false)
    .map(command => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint
        ? { argumentHint: command.argumentHint }
        : {}),
    }))

  return {
    appStateStore,
    agentDefinitions,
    availableMcpServers,
    extensionsSnapshot,
    slashCatalog,
    /**
     * The session's REAL model-visible tool list (same array wired into the query
     * engine below) — returned so the P4-6b session-actions domain can render an
     * export with the engine's actual tools, never `[]` (the P1-3 defect).
     */
    tools,
    /**
     * The real command catalog for this cwd (same array wired into the query
     * engine above) — returned so the RemoteSettings domain (P4-13) can derive
     * its command-filter truth from THIS session's actual commands, never a
     * second `getCommands()` call or a copied array.
     */
    commands,
    queryEngineConfig: {
      ...createQueryEngineAppSessionConfigFromSetup({
        cwd,
        tools,
        commands,
        mcpTools: [],
        mcpCommands: [],
        mcpClients,
        mcpResources: {},
        agents: agentDefinitions.activeAgents,
        getAppState: appStateStore.getState,
        setAppState: appStateStore.setState,
        readFileCache: createFileStateCacheWithSizeLimit(
          READ_FILE_STATE_CACHE_SIZE,
        ),
      }),
      // F1 (host-plane review 2026-07-05): seed the resumed transcript into the
      // QueryEngine's live turn context (`initialMessages` → `mutableMessages`,
      // QueryEngine.ts:208) — the same hand-off the TUI's --resume makes via the
      // REPL's initialMessages (main.tsx:3784-3797). Without this, a restored
      // session adopts the id and appends to the right transcript but answers
      // with no pre-quit context (the D6 anti-Potemkin failure). Copied so the
      // engine's in-place mutation never aliases the caller's resumed array.
      ...(initialMessages !== undefined
        ? { initialMessages: [...initialMessages] }
        : {}),
    },
  }
}

export type SidecarSession = {
  controller: AppSessionController
  /**
   * Permissions domain over the SAME store the runtime enforces (so C2 mode
   * switches and C3 snapshots act on exactly what `canUseTool` reads). Null
   * in probe mode, which has no engine app-state store.
   */
  permissions: SidecarPermissionDomain | null
  /**
   * Settings read-seam (P4-3) — the engine's real settings source/precedence
   * model, resolved at this session's cwd. Read-only; null in probe mode (no
   * cwd-configured engine, so a disk read would be meaningless).
   */
  settings: SidecarSettingsDomain | null
  /**
   * Agents config read-seam (P4-7) — the real agent definition snapshot rooted at
   * this session's cwd. Read-only; null in probe mode.
   */
  agentConfig: SidecarAgentConfigDomain | null
  /**
   * Goals read-seam (P4-10) — live threadGoal state from the same app-state store
   * the runtime mutates. Read-only; null in probe mode.
   */
  goals: SidecarGoalDomain | null
  /**
   * Memory read-seam (P4-10) — metadata over the real CLAUDE.md hierarchy and
   * auto-memory memdir. Read-only; null in probe mode.
   */
  memory: SidecarMemoryDomain | null
  /**
   * Tasks read-seam (P4-9) — live background-task state from the same
   * app-state store the runtime mutates. Read-only; null in probe mode.
   */
  tasks: SidecarTasksDomain | null
  /**
   * Accounts domain (P4-5) — the redacted Codex pool read-seam + lifecycle verbs
   * over the engine's own account machinery. The pool is a process-global
   * singleton (not per-session), so this shares one live pool with the engine;
   * null in probe mode (no engine). Read-seam is secretGuard-clean by construction.
   */
  accounts: SidecarAccountsDomain | null
  /**
   * Workspace-trust read-seam (P4-14) — trust state + detected repo for this
   * session's cwd. Read-only; null in probe mode (no cwd-configured engine).
   */
  workspaceTrust: SidecarWorkspaceTrustDomain | null
  /**
   * Diagnostics read-seam (P4-14) — /doctor + /status facts for this session.
   * Read-only; null in probe mode (no cwd-configured engine).
   */
  diagnostics: SidecarDiagnosticsDomain | null
  /**
   * Settings extensions read-seam (P4-12) — the spawn-time MCP/plugins/skills/
   * hooks config snapshot. Read-only; null in probe mode (no cwd-configured engine).
   */
  extensions: SidecarExtensionsDomain | null
  /**
   * RemoteSettings domain (P4-13, D3 cut scope) — bridge toggle/status +
   * command-filter truth + direct-connect verb over the engine's own bridge
   * flag and command catalog. Null in probe mode (no engine app-state store,
   * no cwd-configured command catalog).
   */
  remoteSettings: SidecarRemoteSettingsDomain | null
  /**
   * Agent-mode / Orchestrator read-seam (P4-8, D2) — the joined worker snapshot
   * (persisted agent-mode state ∪ live `local_agent` workers) for this session.
   * Read-only; null in probe mode (no engine app-state store).
   */
  agentMode: SidecarAgentModeDomain | null
  /**
   * Task-control write-seam (P4-8b) — the deferred worker Stop/kill verb over the
   * engine's own `stopTask`, against the SAME app-state store the runtime mutates.
   * Read-only capability (no snapshot); null in probe mode (no engine app-state).
   */
  taskControl: SidecarTaskControlDomain | null
  /**
   * Composer run-controls domain (P4-24c) — the live Model/effort/fast read seam +
   * the per-session `/model`, `/effort`, `/fast` write verbs over the engine's own
   * setters. Over the SAME app-state store the runtime enforces. Null in probe mode.
   */
  runControls: SidecarRunControlsDomain | null
  /**
   * Session-action write domain (P4-6b) — the Rename / Export / Branch verbs over
   * the engine's OWN `saveCustomTitle` / `renderMessagesToPlainText` / `createFork`.
   * Null in probe mode (no engine session to rename/export/fork).
   */
  sessionActions: SidecarSessionActionsDomain | null
  /**
   * The session's real user-invocable slash commands WITH display metadata (name
   * + description + optional arg hint), built at spawn from the SAME `getCommands`
   * catalog that feeds `slash_commands`. The server pushes it on connect as a
   * read-only `slash-catalog.snapshot` so the composer picker renders rich rows
   * (prototype parity) before the first turn. Empty in probe mode / when the
   * catalog load degraded.
   */
  slashCatalog: SlashCatalogEntry[]
}

export async function createSidecarSessionController({
  probe,
  cwd,
  initialMessages,
}: {
  probe: boolean
  /** Session root; the engine's QueryEngine is configured here. Ignored in probe mode. */
  cwd: string
  /**
   * The resumed transcript from `resumeEngineSession` (F1): seeds the
   * QueryEngine's turn context so a restored session actually operates on its
   * pre-quit history. Absent for a fresh session; ignored in probe mode.
   */
  initialMessages?: readonly Message[]
}): Promise<SidecarSession> {
  if (probe) {
    return {
      controller: createQueryEngineSessionController({
        submitMessage(prompt, options) {
          return createProbeAdapter().runTurn({
            prompt,
            options: { uuid: options?.uuid, isMeta: options?.isMeta },
            signal: new AbortController().signal,
            onPermissionRequest: async () => ({
              behavior: 'deny',
              message: 'probe: no permission handler',
            }),
          })
        },
      }),
      permissions: null,
      settings: null,
      agentConfig: null,
      goals: null,
      memory: null,
      tasks: null,
      accounts: null,
      workspaceTrust: null,
      diagnostics: null,
      extensions: null,
      remoteSettings: null,
      agentMode: null,
      taskControl: null,
      runControls: null,
      sessionActions: null,
      slashCatalog: [],
    }
  }

  // Derive the model-visible tool list from the SAME permission context the
  // runtime enforces (QueryEngine reads getAppState().toolPermissionContext),
  // so what the model sees and what canUseTool allows never diverge. P1-2
  // shipped `tools: []`, which made every live turn text-only — the model
  // could not emit a tool_use at all (found in P1-3).
  const {
    appStateStore,
    agentDefinitions,
    availableMcpServers,
    extensionsSnapshot,
    commands,
    queryEngineConfig,
    slashCatalog,
    tools,
  } = await createNormalSidecarQueryEngineConfig(cwd, initialMessages)
  const providerBoundHistory = initialMessages
    ? hasProviderBoundHistory(initialMessages)
    : false
  setProviderSwitchLocked(providerBoundHistory)
  const runControls = createSidecarRunControlsDomain(appStateStore, {
    providerSwitchLocked: providerBoundHistory,
  })

  return {
    controller: createRuntimeBackedWebAppSession({ queryEngineConfig }),
    permissions: createSidecarPermissionDomain(appStateStore),
    settings: createSidecarSettingsDomain(await loadAvailableSettingOptions(cwd)),
    agentConfig: createSidecarAgentConfigDomain({
      agentDefinitions,
      availableMcpServers,
    }),
    goals: createSidecarGoalDomain(appStateStore),
    memory: createSidecarMemoryDomain(),
    tasks: createSidecarTasksDomain(appStateStore),
    accounts: createSidecarAccountsDomain({
      onProviderActivated: provider => {
        const result = runControls.activateProvider(provider)
        if (!result.ok) throw new Error(result.message)
      },
    }),
    workspaceTrust: await createSidecarWorkspaceTrustDomain(cwd),
    diagnostics: await createSidecarDiagnosticsDomain(appStateStore),
    extensions: createSidecarExtensionsDomain(extensionsSnapshot),
    remoteSettings: createSidecarRemoteSettingsDomain({ appStateStore, cwd, commands }),
    agentMode: createSidecarAgentModeDomain(appStateStore),
    taskControl: createSidecarTaskControlDomain(appStateStore),
    runControls,
    sessionActions: createSidecarSessionActionsDomain({ tools }),
    slashCatalog,
  }
}
