/**
 * RemoteSettings domain capability — the sidecar-side read-seam + verb executor
 * for the P4-13 cut-scope surface (D3, `decisions/PAIRED-DEVICES.md` §4): bridge
 * toggle/status + read-only command-filter truth + a direct-connect form. NO
 * paired-device identity/authz model.
 *
 * Conforms to the P4-5 recipe (`accountsDomain.ts`): a throw-free `getSnapshot()`
 * over the engine's OWN live state, and a `runVerb()` that re-validates against
 * that live state before dispatching to an injected executor (real ops in
 * production, fakes in tests so a headless round-trip never makes a real network
 * call). ZERO transport knowledge — frames, wire validation, and limits stay in
 * `sidecarServer.ts`.
 *
 * Bridge status is a DIRECT read of this session's own `AppStateStore` — the
 * SAME store `permissionDomain.ts`/`goalDomain.ts` read (`replBridgeEnabled` /
 * `replBridgeError`, `src/state/AppStateStore.ts:138,157`), not a re-derivation.
 * The command-filter truth is derived from THIS session's real command catalog
 * (the same array `createNormalSidecarQueryEngineConfig` loads via
 * `getCommands(cwd)` and hands to the engine for slash-command parsing) filtered
 * through the engine's own `isBridgeSafeCommand` (`src/commands.ts:697`) — never
 * a copied array.
 *
 * §0 — the bridge toggle does NOT establish a live WS/poll connection. That
 * effect loop (`initReplBridge`) is driven only by `useReplBridge`'s `useEffect`,
 * mounted in the Ink REPL (`src/screens/REPL.tsx:4208`) — never in this Electron
 * sidecar. Enabling here runs the SAME prerequisite gate `/remote-control` runs
 * (`src/commands/bridge/bridge.tsx:467-502`, reimplemented against the same
 * underlying primitives rather than importing that Ink command module) and then
 * flips the real `replBridgeEnabled` flag with the same shape the CLI writes
 * (`bridge.tsx:90-96` on enable, `src/components/BridgeDialog.tsx:347-355` on
 * disable) — an honest, real state change, just not (yet) a live connection.
 * Matches the `account.login` precedent: a real, partial verb, flagged not faked.
 * The KAIROS/assistant-mode perpetual-bridge branch (`bridge.tsx:483-491`) is
 * intentionally NOT replicated — the desktop app has no assistant-mode session.
 */

import { isBridgeSafeCommand, type Command } from '../../src/commands.js'
import { getBridgeAccessToken } from '../../src/bridge/bridgeConfig.js'
import {
  checkBridgeMinVersion,
  getBridgeDisabledReason,
  isEnvLessBridgeEnabled,
} from '../../src/bridge/bridgeEnabled.js'
import { checkEnvLessBridgeMinVersion } from '../../src/bridge/envLessBridgeConfig.js'
import { BRIDGE_LOGIN_INSTRUCTION } from '../../src/bridge/types.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from '../../src/services/policyLimits/index.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from '../../src/server/createDirectConnectSession.js'
import type { AppStateStore } from '../../src/state/AppStateStore.js'
import type {
  RemoteBridgeToggleMessage,
  RemoteDirectConnectMessage,
  RemoteSettingsSnapshot,
  RemoteVerbMessage,
  RemoteVerbType,
} from '../shared/protocol.js'

/** Pure — the redacted outcome payload a verb produces (no transport). */
export type RemoteVerbResult = {
  ok: boolean
  message: string
  directConnect?: { sessionId: string; wsUrl: string }
}

/**
 * The engine bridge/direct-connect ops, behind a seam. The real implementation
 * wires the actual prerequisite gate + `createDirectConnectSession`; tests inject
 * a fake so a headless round-trip proves the wiring without a live network call.
 */
export type RemoteSettingsCommandExecutor = {
  /** The real `/remote-control` preflight (policy / disabled-reason / version / OAuth). Null = pass. */
  checkBridgePrerequisites(): Promise<string | null>
  /** Create a session on `serverUrl` for `cwd`. Throws on failure (network/HTTP/parse). */
  directConnect(
    serverUrl: string,
    cwd: string,
  ): Promise<{ sessionId: string; wsUrl: string }>
}

export type SidecarRemoteSettingsDomain = {
  /** Pure, throw-free read of the live bridge flag + this session's real command catalog. */
  getSnapshot(): RemoteSettingsSnapshot | null
  /**
   * Run one already-STRUCTURALLY-validated RemoteSettings verb: dispatch to the
   * executor and report whether the bridge flag changed (so the sidecar knows to
   * re-broadcast the snapshot).
   */
  runVerb(
    verb: RemoteVerbMessage,
  ): Promise<{ verb: RemoteVerbType; result: RemoteVerbResult; flagChanged: boolean }>
}

/* ------------------------------------------------------------------------- *
 * Pure projection — the command-filter bucketing, unit-tested
 * ------------------------------------------------------------------------- */

/**
 * Bucket THIS session's real command catalog into the filter's three buckets.
 * `skillSafe` = `type === 'prompt'` (safe by type, `isBridgeSafeCommand`
 * returns true unconditionally); `optIn` = `type === 'local'` AND
 * `isBridgeSafeCommand` (i.e. a `BRIDGE_SAFE_COMMANDS` member); `blocked` =
 * `type === 'local-jsx'` (always blocked). Pure; no engine reads.
 */
export function buildCommandFilterSnapshot(
  commands: readonly Command[],
  commandName: (cmd: Command) => string,
): RemoteSettingsSnapshot['commandFilter'] {
  const skillSafe: string[] = []
  const optIn: string[] = []
  const blocked: string[] = []
  for (const cmd of commands) {
    if (cmd.type === 'prompt') {
      skillSafe.push(commandName(cmd))
    } else if (cmd.type === 'local-jsx') {
      blocked.push(commandName(cmd))
    } else if (isBridgeSafeCommand(cmd)) {
      optIn.push(commandName(cmd))
    }
  }
  skillSafe.sort()
  optIn.sort()
  blocked.sort()
  return { skillSafe, optIn, blocked }
}

/**
 * The bridge status half of the snapshot — a direct read of the live
 * `AppStateStore`, no derivation beyond the real transport branch.
 */
export function buildBridgeStatusSnapshot(state: {
  replBridgeEnabled: boolean
  replBridgeError: string | undefined
}): RemoteSettingsSnapshot['bridge'] {
  return {
    enabled: state.replBridgeEnabled,
    error: state.replBridgeError ?? null,
    transport: isEnvLessBridgeEnabled() ? 'v2' : 'v1',
  }
}

/* ------------------------------------------------------------------------- *
 * Real executor — wires the engine's own bridge/direct-connect primitives
 * ------------------------------------------------------------------------- */

/**
 * App-side bound on a direct-connect attempt (review fix 2026-07-09). A
 * black-hole host would otherwise leave `createDirectConnectSession`'s bare
 * `fetch` (no signal, `src/server/createDirectConnectSession.ts`) pending
 * forever, stranding the renderer form on "Connecting…". A true AbortSignal
 * that cancels the underlying request would require a `src/` signature change,
 * so this races the promise against a timeout to surface a real error instead
 * of hanging; the fetch itself is abandoned (accepted for this LOW fix).
 */
const DIRECT_CONNECT_TIMEOUT_MS = 15_000

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DirectConnectError(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createRealRemoteSettingsExecutor(): RemoteSettingsCommandExecutor {
  return {
    async checkBridgePrerequisites() {
      // Mirrors `src/commands/bridge/bridge.tsx:467-502` (the real
      // `/remote-control` preflight), reimplemented against the same
      // underlying primitives rather than importing that Ink command module
      // into the sidecar. The KAIROS/assistant-mode perpetual branch is
      // intentionally not replicated (see module header).
      await waitForPolicyLimitsToLoad()
      if (!isPolicyAllowed('allow_remote_control')) {
        return "Remote Control is disabled by your organization's policy."
      }
      const disabledReason = await getBridgeDisabledReason()
      if (disabledReason) {
        return disabledReason
      }
      const useV2 = isEnvLessBridgeEnabled()
      const versionError = useV2
        ? await checkEnvLessBridgeMinVersion()
        : checkBridgeMinVersion()
      if (versionError) {
        return versionError
      }
      if (!getBridgeAccessToken()) {
        return BRIDGE_LOGIN_INSTRUCTION
      }
      return null
    },
    async directConnect(serverUrl, cwd) {
      const { config } = await withTimeout(
        createDirectConnectSession({ serverUrl, cwd }),
        DIRECT_CONNECT_TIMEOUT_MS,
        `Timed out connecting to ${serverUrl} after ${DIRECT_CONNECT_TIMEOUT_MS / 1000}s.`,
      )
      return { sessionId: config.sessionId, wsUrl: config.wsUrl }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Domain
 * ------------------------------------------------------------------------- */

export function createSidecarRemoteSettingsDomain(options: {
  appStateStore: AppStateStore
  cwd: string
  commands: readonly Command[]
  executor?: RemoteSettingsCommandExecutor
}): SidecarRemoteSettingsDomain {
  const { appStateStore, cwd, commands } = options
  const executor = options.executor ?? createRealRemoteSettingsExecutor()

  // One direct connect at a time per session. `withTimeout` above rejects after
  // 15 s but ABANDONS the underlying fetch (it has no signal), so without this
  // latch a renderer looping at the inbound rate cap against a black-holing host
  // accumulates thousands of sockets inside the privileged sidecar, held until
  // the OS TCP timeout. The frame caps bound frames, not in-flight work per verb.
  // Mirrors the `phase === 'persisting'` guard in `accountsDomain.ts`.
  let directConnectInFlight = false

  return {
    getSnapshot() {
      try {
        return {
          bridge: buildBridgeStatusSnapshot(appStateStore.getState()),
          commandFilter: buildCommandFilterSnapshot(commands, cmd =>
            cmd.userFacingName?.() ?? cmd.name,
          ),
        }
      } catch {
        return null
      }
    },

    async runVerb(verb) {
      switch (verb.type) {
        case 'remoteSettings.bridgeToggle': {
          return runBridgeToggle(verb, appStateStore, executor)
        }
        case 'remoteSettings.directConnect': {
          if (directConnectInFlight) {
            return {
              verb: 'remoteSettings.directConnect',
              result: {
                ok: false,
                message: 'Already connecting. Wait for that attempt to finish.',
              },
              flagChanged: false,
            }
          }
          directConnectInFlight = true
          try {
            return await runDirectConnect(verb, cwd, executor)
          } finally {
            directConnectInFlight = false
          }
        }
        default: {
          // Exhaustiveness tripwire — a new verb must extend this switch.
          const never: never = verb
          throw new Error(`unhandled remote settings verb: ${JSON.stringify(never)}`)
        }
      }
    },
  }
}

async function runBridgeToggle(
  verb: RemoteBridgeToggleMessage,
  appStateStore: AppStateStore,
  executor: RemoteSettingsCommandExecutor,
): Promise<{ verb: RemoteVerbType; result: RemoteVerbResult; flagChanged: boolean }> {
  const current = appStateStore.getState().replBridgeEnabled
  if (verb.enable === current) {
    return {
      verb: 'remoteSettings.bridgeToggle',
      result: {
        ok: true,
        message: verb.enable ? 'Remote Control bridge already on.' : 'Remote Control bridge already off.',
      },
      flagChanged: false,
    }
  }

  if (verb.enable) {
    const error = await executor.checkBridgePrerequisites()
    if (error) {
      return {
        verb: 'remoteSettings.bridgeToggle',
        result: { ok: false, message: error },
        flagChanged: false,
      }
    }
    // Shape mirrors `bridge.tsx:90-96` (the real `/remote-control` enable path).
    appStateStore.setState(prev => ({
      ...prev,
      replBridgeEnabled: true,
      replBridgeExplicit: true,
      replBridgeOutboundOnly: false,
    }))
    return {
      verb: 'remoteSettings.bridgeToggle',
      // Honesty (review fix 2026-07-09): only the flag is set — no worker
      // serves the session in the desktop path (see the §0 module header).
      result: { ok: true, message: 'Remote Control enabled (flag set; not yet serving clients).' },
      flagChanged: true,
    }
  }

  // Shape mirrors `BridgeDialog.tsx:347-355` (the real disconnect path).
  appStateStore.setState(prev => ({ ...prev, replBridgeEnabled: false }))
  return {
    verb: 'remoteSettings.bridgeToggle',
    result: { ok: true, message: 'Remote Control bridge stopped.' },
    flagChanged: true,
  }
}

async function runDirectConnect(
  verb: RemoteDirectConnectMessage,
  cwd: string,
  executor: RemoteSettingsCommandExecutor,
): Promise<{ verb: RemoteVerbType; result: RemoteVerbResult; flagChanged: boolean }> {
  try {
    const connected = await executor.directConnect(verb.serverUrl, cwd)
    return {
      verb: 'remoteSettings.directConnect',
      result: {
        ok: true,
        message: `Connected to ${verb.serverUrl}.`,
        directConnect: connected,
      },
      flagChanged: false,
    }
  } catch (error) {
    const message =
      error instanceof DirectConnectError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    return {
      verb: 'remoteSettings.directConnect',
      result: { ok: false, message },
      flagChanged: false,
    }
  }
}
