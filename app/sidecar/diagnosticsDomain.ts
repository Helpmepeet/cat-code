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
 * Required instructions and cheap facts are prepared at construction. Optional
 * installation checks run once, only when the session lifecycle permits them.
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
import { getMemoryFiles } from '../../src/utils/claudemd.js'
import { createOwnedCommandBudget } from '../../src/utils/ownedCommandBudget.js'

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
  start(): void
  subscribe(listener: () => void): () => void
  dispose(): void
  /** Null until the whole aggregate is available, including any failure warnings. */
  getSnapshot(): DiagnosticsSnapshot | null
}

// Provisional, not a measured npm tail percentile: retained healthy checks took
// 72–78ms and the controlled delay was 200ms. Five seconds allows substantial
// headroom while bounding stuck work; no long-healthy npm distribution exists.
export const OPTIONAL_INSTALLATION_BUDGET_MS = 5_000

export async function createSidecarDiagnosticsDomain(
  appStateStore: Store<AppState>,
): Promise<SidecarDiagnosticsDomain> {
  // This is the existing eager instruction-loading point. Do not defer it or
  // discover twice: getMemoryFiles owns the shared cache and instruction hooks.
  let facts: Omit<DiagnosticsSnapshot, 'installationWarnings' | 'healthWarnings'> | null = null
  try {
    const files = await getMemoryFiles()
    const [memoryWarnings, gitBranch] = await Promise.all([
      buildMemoryDiagnostics(files),
      readSessionBranch(),
    ])
    const state = appStateStore.getState()
    facts = {
      version: MACRO.VERSION,
      mainLoopModel: state.mainLoopModel,
      mainLoopModelForSession: resolveSessionModel(state),
      reasoningEffort: effortToDisplay(state.effortValue),
      fastMode: state.fastMode ?? false,
      sandboxEnabled: SandboxManager.isSandboxingEnabled(),
      gitBranch,
      memoryWarnings: memoryWarnings.map(String),
    }
  } catch (error) {
    process.stderr.write(`[sidecar] diagnostics preparation failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  let snapshot: DiagnosticsSnapshot | null = null
  let started = false
  let disposed = false
  let budget: ReturnType<typeof createOwnedCommandBudget> | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!disposed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start() {
      const prepared = facts
      if (started || disposed || !prepared) return
      started = true
      const owned = budget = createOwnedCommandBudget(OPTIONAL_INSTALLATION_BUDGET_MS)
      // The abort listener settles the aggregate even if a non-subprocess probe
      // never resolves. Both probe promises retain rejection handlers; owned
      // subprocesses receive the same signal and deadline, not an abandoned race.
      const probe = (label: string, read: () => Promise<unknown[]>) => new Promise<string[]>(resolve => {
        const aborted = () => resolve(['Installation checks cancelled or timed out.'])
        owned.signal.addEventListener('abort', aborted, { once: true })
        Promise.resolve().then(() => {
          owned.throwIfExpired()
          return read()
        }).then(warnings => warnings.map(String)).then(
          resolve,
          error => {
            process.stderr.write(`[sidecar] ${label} diagnostics failed: ${error instanceof Error ? error.message : String(error)}\n`)
            resolve(['Installation checks could not be completed.'])
          },
        ).finally(() => owned.signal.removeEventListener('abort', aborted))
      })
      void Promise.all([
        probe('installation', () => buildInstallationDiagnostics(owned)),
        probe('health', () => buildInstallationHealthDiagnostics(owned)),
      ]).then(([installationWarnings, healthWarnings]) => {
        if (disposed) return
        snapshot = { ...prepared, installationWarnings, healthWarnings }
        for (const listener of listeners) {
          try { listener() } catch {
            process.stderr.write('[sidecar] diagnostics subscriber failed\n')
          }
        }
      }).finally(() => owned.dispose())
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      budget?.dispose()
    },
  }
}
