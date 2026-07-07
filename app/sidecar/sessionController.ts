import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createQueryEngineAppSessionConfigFromSetup } from '../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { createRuntimeBackedWebAppSession } from '../../src/app-runtime/createRuntimeBackedWebAppSession.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { getTools } from '../../src/tools.js'
import { getCommands, type Command } from '../../src/commands.js'
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
import { createProbeAdapter } from './probeAdapter.js'
import {
  createSidecarPermissionDomain,
  type SidecarPermissionDomain,
} from './permissionDomain.js'
import {
  createSidecarSettingsDomain,
  type SidecarSettingsDomain,
} from './settingsDomain.js'

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
    // surface (the CLI expresses that as the --dangerously-skip-permissions
    // launch flag; the desktop session has no such surface yet). The loader's
    // settings-derived value reports policy only, which would silently drop
    // the engine-side backstop the boundary's explicit rejection layers on —
    // pin availability off until a trusted desktop grant surface is decided.
    isBypassPermissionsModeAvailable: false,
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

export async function createNormalSidecarQueryEngineConfig(
  cwd: string,
  initialMessages?: readonly Message[],
) {
  const toolPermissionContext = await loadSidecarToolPermissionContext()
  const appStateStore = createStore({
    ...getDefaultAppState(),
    toolPermissionContext,
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

  return {
    appStateStore,
    queryEngineConfig: {
      ...createQueryEngineAppSessionConfigFromSetup({
        cwd,
        tools,
        commands,
        mcpTools: [],
        mcpCommands: [],
        mcpClients: [],
        mcpResources: {},
        agents: [],
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
    }
  }

  // Derive the model-visible tool list from the SAME permission context the
  // runtime enforces (QueryEngine reads getAppState().toolPermissionContext),
  // so what the model sees and what canUseTool allows never diverge. P1-2
  // shipped `tools: []`, which made every live turn text-only — the model
  // could not emit a tool_use at all (found in P1-3).
  const { appStateStore, queryEngineConfig } =
    await createNormalSidecarQueryEngineConfig(cwd, initialMessages)

  return {
    controller: createRuntimeBackedWebAppSession({ queryEngineConfig }),
    permissions: createSidecarPermissionDomain(appStateStore),
    settings: createSidecarSettingsDomain(),
  }
}
