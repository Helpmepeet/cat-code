/**
 * Diagnostics domain (P4-14) — the read-only Settings → Diagnostics section,
 * adapted from the engine's `/doctor` + `/status` panes (`src/utils/status.tsx`,
 * `src/utils/doctorDiagnostic.ts`) with their Ink-coupled formatting stripped:
 * those modules build `React.ReactNode`/`chalk`-colored values for the terminal
 * UI, so this domain calls their underlying PLAIN-DATA builders directly
 * (`buildInstallationDiagnostics`/`buildInstallationHealthDiagnostics`/
 * `buildMemoryDiagnostics` all already return `string[]`; nothing here
 * re-derives their logic).
 *
 * Deliberately NOT duplicated (§10 — reuse the real seam instead of a second
 * one): setting sources (already on `settings.snapshot`'s `layers`) and the
 * active account (already on `accounts.snapshot`) — the renderer derives both
 * from the snapshots those domains already emit.
 *
 * Read-only, spawn-time-frozen (matches the settings seam's posture): the
 * doctor/install checks run once at spawn, no live re-poll.
 *
 * ZERO transport knowledge: frames, validation, and limits stay in
 * `sidecarServer.ts`.
 */

import type { AppState } from '../../src/state/AppStateStore.js'
import type { Store } from '../../src/state/store.js'
import { getBranch } from '../../src/utils/git.js'
import { getMainLoopModel } from '../../src/utils/model/model.js'
import {
  buildInstallationDiagnostics,
  buildInstallationHealthDiagnostics,
  buildMemoryDiagnostics,
} from '../../src/utils/status.js'
import { SandboxManager } from '../../src/utils/sandbox/sandbox-adapter.js'
import type { DiagnosticsSnapshot } from '../shared/protocol.js'

/**
 * The RESOLVED model this session runs. Prefers the store's own resolved/override
 * fields, then falls back to the engine's own resolver (the SAME `getMainLoopModel`
 * the QueryEngine uses at request time — not a re-derivation). Degrades to null if
 * the resolver throws (settings/provider read), never crashing the snapshot.
 */
function resolveSessionModel(state: AppState): string | null {
  if (state.mainLoopModelForSession) return state.mainLoopModelForSession
  if (state.mainLoopModel) return state.mainLoopModel
  try {
    return getMainLoopModel()
  } catch {
    return null
  }
}

/**
 * This session's branch, from the engine's own `getBranch()` — the same call
 * `sessionStorage.ts:1464` makes when it stamps `gitBranch` onto a message, and
 * a `.git/HEAD` read rather than a shell-out (`git/gitFilesystem.ts`
 * `computeBranch`). The sidecar's process cwd IS the session root
 * (`supervisor.ts:213`), so no path has to be passed or authored.
 *
 * `computeBranch` answers the literal string `'HEAD'` for BOTH "not a repo" and
 * "detached HEAD"; neither is a branch, so both become null and the surface
 * renders its own empty text instead of the word HEAD.
 */
async function readSessionBranch(): Promise<string | null> {
  try {
    const branch = await getBranch()
    return branch && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}

/** `AppState.effortValue` (level string | number | undefined) → display string | null. */
function effortToDisplay(effort: AppState['effortValue']): string | null {
  if (effort == null) return null
  return String(effort)
}

export type SidecarDiagnosticsDomain = {
  /** The spawn-time doctor/status facts for this session. null if the read failed. */
  getSnapshot(): DiagnosticsSnapshot | null
}

/**
 * `appStateStore` is the SAME live store the engine's QueryEngine reads
 * (`mainLoopModel`) — not a re-derivation, matching the permission domain's
 * rule. The doctor/install checks shell out and read disk, so construction is
 * async; `getSnapshot()` is then a pure, throw-free read of the captured value.
 */
export async function createSidecarDiagnosticsDomain(
  appStateStore: Store<AppState>,
): Promise<SidecarDiagnosticsDomain> {
  const snapshot = await readDiagnosticsSnapshotOnce(appStateStore)
  return {
    getSnapshot() {
      return snapshot
    },
  }
}

async function readDiagnosticsSnapshotOnce(
  appStateStore: Store<AppState>,
): Promise<DiagnosticsSnapshot | null> {
  try {
    const [installationWarnings, healthWarnings, memoryWarnings, gitBranch] =
      await Promise.all([
        buildInstallationDiagnostics(),
        buildInstallationHealthDiagnostics(),
        buildMemoryDiagnostics(),
        readSessionBranch(),
      ])
    const state = appStateStore.getState()
    return {
      version: MACRO.VERSION,
      mainLoopModel: state.mainLoopModel,
      mainLoopModelForSession: resolveSessionModel(state),
      reasoningEffort: effortToDisplay(state.effortValue),
      fastMode: state.fastMode ?? false,
      sandboxEnabled: SandboxManager.isSandboxingEnabled(),
      gitBranch,
      // The engine builders are typed `Diagnostic[]` (`ReactNode`); today they
      // yield plain strings, but a future JSX-emitting variant would be silently
      // dropped by `checkJsonSafe` on the outbound frame. Coerce explicitly so
      // the wire stays `string[]` by construction, not by luck.
      installationWarnings: installationWarnings.map(String),
      healthWarnings: healthWarnings.map(String),
      memoryWarnings: memoryWarnings.map(String),
    }
  } catch (error) {
    process.stderr.write(
      `[sidecar] diagnostics snapshot read failed (session runs without a diagnostics snapshot): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}
