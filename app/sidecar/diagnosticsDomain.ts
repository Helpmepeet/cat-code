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
import {
  buildInstallationDiagnostics,
  buildInstallationHealthDiagnostics,
  buildMemoryDiagnostics,
} from '../../src/utils/status.js'
import { SandboxManager } from '../../src/utils/sandbox/sandbox-adapter.js'
import type { DiagnosticsSnapshot } from '../shared/protocol.js'

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
    const [installationWarnings, healthWarnings, memoryWarnings] =
      await Promise.all([
        buildInstallationDiagnostics(),
        buildInstallationHealthDiagnostics(),
        buildMemoryDiagnostics(),
      ])
    return {
      version: MACRO.VERSION,
      mainLoopModel: appStateStore.getState().mainLoopModel,
      sandboxEnabled: SandboxManager.isSandboxingEnabled(),
      installationWarnings,
      healthWarnings,
      memoryWarnings,
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
