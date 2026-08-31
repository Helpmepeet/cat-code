import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createQueryEngineAppSessionConfigFromSetup } from '../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { createRuntimeBackedAppSession } from '../../src/app-runtime/createRuntimeBackedAppSession.js'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { getInitialEffortSetting } from '../../src/utils/effort.js'
import {
  getModelEnvOverride,
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
  type ModelSetting,
} from '../../src/utils/model/model.js'
import {
  getEnvAPIProvider,
  hasProviderBoundHistory,
  resolveStartupProvider,
} from '../../src/utils/model/providers.js'
import {
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setProviderSwitchLocked,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { getTools } from '../../src/tools.js'
import { getMainLoopModel } from '../../src/utils/model/model.js'
import {
  createRealContextBreakdownExecutor,
  createSidecarContextBreakdownDomain,
  type SidecarContextBreakdownDomain,
} from './contextBreakdownDomain.js'
import { getCommands, isHeadlessSafeCommand, type Command } from '../../src/commands.js'
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
import { DESKTOP_SYSTEM_PROMPT_ADDENDUM } from './desktopSystemPrompt.js'
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
  createSidecarLeaseDomain,
  type SidecarLeaseDomain,
} from './leaseDomain.js'
import {
  createSidecarPanelTaskReaper,
  type SidecarPanelTaskReaper,
} from './panelTaskReaper.js'
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
  // Bypass is an ordinary session mode in the desktop app (operator ruling
  // 2026-08-11, PERMISSION-BOUNDARY.md §3, replacing the CATCODE_ALLOW_BYPASS
  // launch grant), so there is no desktop-local gate to apply here and no
  // override of the field either. What flows through from
  // `initializeToolPermissionContext` is the ENGINE's own policy answer
  // (`permissionSetup.ts:963`): false when the `tengu_disable_bypass_permissions_mode`
  // Statsig gate is on or settings carry `permissions.disableBypassPermissionsMode`,
  // and false again when auto-mode dangerous-rule stripping ran above. Managed
  // policy therefore still disables bypass on the desktop; what was removed is
  // the launch-flag ceremony, not the policy. Distinct from the engine's OTHER
  // bypass killswitch (`isBypassPermissionsModeDisabled()` /
  // `bypassPermissionsKillswitch`), which has zero call sites in `app/` and is
  // NOT a control here.
  return toolPermissionContext
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
export async function loadAgentDefinitionsForRuntime(
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
  // Avoid resolving the Anthropic default here: credential-less desktop startup
  // must still reach the first-run sign-in surface (and the test guard
  // intentionally throws).
  const resolvedModel =
    specifiedModel === undefined || specifiedModel === null
      ? null
      : parseUserSpecifiedModel(specifiedModel)
  // A model chosen for THIS session — the resumed transcript's own model, or
  // CAT_CODE_MODEL/ANTHROPIC_MODEL — is a provider-selection event. A model
  // that only sits in a settings FILE is not: CLAUDE_CODE_USE_* outranks saved
  // settings, so `{"model":"sonnet"}` must not silently pull a
  // CLAUDE_CODE_USE_OPENAI=1 desktop session onto Anthropic. Desktop half of
  // the CLI rule at `src/main.tsx:2147`. Narrowing the flag alone would have
  // cost a settings-file `gpt-*` model its provider; it does not, because
  // `resolveStartupProvider` checks the model implication ahead of this flag
  // (`src/utils/model/providers.ts:175`) — required, since request routing
  // sends every `gpt-*` id to OpenAI regardless of the session provider and the
  // provider-shaped tool set is chosen from this result.
  const hasExplicitStartupModel =
    resumedModel !== undefined || getModelEnvOverride() !== undefined

  setInitialMainLoopModel(selectedModel)
  setMainLoopModelOverride(selectedModel)
  setSessionProvider(
    resolveStartupProvider(
      resolvedModel,
      hasExplicitStartupModel,
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

export async function createNormalSidecarQueryEngineConfig(
  cwd: string,
  initialMessages?: readonly Message[],
  {
    agentDefinitions: suppliedAgentDefinitions,
    resumedInitialState,
  }: {
    /** One startup snapshot shared with resume, never a second disk read. */
    agentDefinitions?: AgentDefinitionsResult
    /** Durable state returned by processResumedConversation. */
    resumedInitialState?: AppState
  } = {},
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
    // processResumedConversation owns durable resume state (goal, selected
    // agent, attribution, and the mode-adjusted agent catalog). Apply it
    // before fresh runtime-only values below so today's trusted permission and
    // provider settings remain authoritative.
    ...resumedInitialState,
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
  const agentDefinitions =
    suppliedAgentDefinitions ?? await loadAgentDefinitionsForRuntime(cwd)
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
    // A sidecar session is non-interactive, so `local-jsx` commands resolve to
    // nothing at all (`processSlashCommand.tsx` bails on
    // `isNonInteractiveSession`) — they render an Ink component and there is no
    // terminal here to draw it into. Advertising them made the picker offer ~64
    // commands that silently did nothing. Filtered through the SAME predicate
    // the engine's own headless path uses (`src/main.tsx` `commandsHeadless`),
    // not a re-derivation, so the two cannot drift.
    .filter(isHeadlessSafeCommand)
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
        appendSystemPrompt: DESKTOP_SYSTEM_PROMPT_ADDENDUM,
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
   * Codex lease read-seam (P4-32b, L1) — which account each agent in THIS
   * session's swarm is leasing, projected from the engine's own lease manager.
   * Read-only (there is no lease verb); null in probe mode (no app-state store).
   */
  leases: SidecarLeaseDomain | null
  /**
   * Task-control write-seam (P4-8b) — the deferred worker Stop/kill verb over the
   * engine's own `stopTask`, against the SAME app-state store the runtime mutates.
   * Read-only capability (no snapshot); null in probe mode (no engine app-state).
   */
  taskControl: SidecarTaskControlDomain | null
  /**
   * Terminal-worker eviction deadline owner — honours the engine's `evictAfter`
   * stamp so a finished worker leaves `AppState.tasks` (and with it the docked
   * roster) the way it does under the terminal REPL's panel tick. Null in probe
   * mode (no engine app-state store).
   */
  panelTaskReaper: SidecarPanelTaskReaper | null
  /**
   * Composer run-controls domain (P4-24c) — the live Model/effort/fast read seam +
   * the per-session `/model`, `/effort`, `/fast` write verbs over the engine's own
   * setters. Over the SAME app-state store the runtime enforces. Null in probe mode.
   */
  runControls: SidecarRunControlsDomain | null
  /**
   * Session-action write domain over the engine's own persistence and this
   * session's live controller. Null in probe mode.
   */
  sessionActions: SidecarSessionActionsDomain | null
  /**
   * Context-breakdown read-seam — the per-category occupancy `/context`
   * visualizes, for the composer donut's popover. Read-only; null in probe mode
   * (no engine tools/agents to analyse against).
   */
  contextBreakdown: SidecarContextBreakdownDomain | null
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
  agentDefinitions: suppliedAgentDefinitions,
  resumedInitialState,
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
  /** Shared startup catalog, including the definitions used to restore a session. */
  agentDefinitions?: AgentDefinitionsResult
  /** Durable engine state returned during resume, omitted for a fresh session. */
  resumedInitialState?: AppState
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
      leases: null,
      taskControl: null,
      panelTaskReaper: null,
      runControls: null,
      sessionActions: null,
      contextBreakdown: null,
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
  } = await createNormalSidecarQueryEngineConfig(cwd, initialMessages, {
    agentDefinitions: suppliedAgentDefinitions,
    resumedInitialState,
  })
  const providerBoundHistory = initialMessages
    ? hasProviderBoundHistory(initialMessages)
    : false
  setProviderSwitchLocked(providerBoundHistory)
  const runControls = createSidecarRunControlsDomain(appStateStore, {
    providerSwitchLocked: providerBoundHistory,
  })

  const controller = createRuntimeBackedAppSession({ queryEngineConfig })
  return {
    controller,
    permissions: createSidecarPermissionDomain(appStateStore),
    settings: createSidecarSettingsDomain(await loadAvailableSettingOptions(cwd), {
      reloadAvailableOptions: () => loadAvailableSettingOptions(cwd),
    }),
    agentConfig: createSidecarAgentConfigDomain({
      agentDefinitions,
      availableMcpServers,
    }),
    goals: createSidecarGoalDomain(appStateStore),
    // P4-34 — the SAME active-agent list the query engine receives above
    // (`agents: agentDefinitions.activeAgents`), so the memory page reports the
    // agents this session actually runs, never a re-derived catalog.
    memory: createSidecarMemoryDomain(agentDefinitions.activeAgents),
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
    // P4-32b — the session-scoped Codex lease read seam (L1). Same store as
    // agent-mode: a worker spawn/finish is exactly when leases move.
    leases: createSidecarLeaseDomain(appStateStore),
    taskControl: createSidecarTaskControlDomain(appStateStore),
    panelTaskReaper: createSidecarPanelTaskReaper(appStateStore),
    runControls,
    sessionActions: createSidecarSessionActionsDomain({ tools, controller }),
    // The composer donut's popover breakdown. Fed the SAME tools / agent
    // definitions / permission context the query engine above runs with, and the
    // SAME `getMainLoopModel()` resolver run-controls reads, so `/context` and
    // the popover describe one session rather than two.
    contextBreakdown: createSidecarContextBreakdownDomain({
      executor: createRealContextBreakdownExecutor({
        tools,
        agentDefinitions,
        getToolPermissionContext: () =>
          appStateStore.getState().toolPermissionContext,
        getMainLoopModel,
      }),
      onError: error => {
        console.error('[sidecar] context breakdown failed', error)
      },
    }),
    slashCatalog,
  }
}
