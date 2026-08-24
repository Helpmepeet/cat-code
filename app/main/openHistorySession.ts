/**
 * Open-from-history resolution (SESSIONS-UNIFICATION — operator ruling 2026-07-20).
 *
 * The unified-sessions ruling ("the session created in the app should be the
 * same session created on the cat-code terminal") requires a host path that
 * takes a terminal-created transcript's ENGINE session id and opens it as a real
 * desktop session. The renderer passes ONLY that id (HC1 — it never authors a
 * cwd or path); this module is the pure decision main runs before spawning.
 *
 * Security shape (SECURITY-MINIMUM Addendum, HC1/HC2/T8):
 *  - The engine session id is validated to a strict UUID shape here — engine
 *    session ids are `randomUUID()` (`src/bootstrap/state.ts:337,453`) and land
 *    on disk as `<uuid>.jsonl`. Anything else is rejected, never looked up.
 *  - The cwd is resolved OUTSIDE the renderer, from the sidecar-written baseline
 *    catalog cache (`app/sidecar/sessionsCatalogCache.ts` → engine-derived data,
 *    NOT renderer-authored). An id absent from the cache, or one whose recorded
 *    cwd is empty (the MAJOR-1 unreconcilable-workspace rows), FAILS CLOSED with
 *    a typed error the renderer renders honestly ("open it from the terminal").
 *    Main never guesses a cwd and never trusts a renderer-supplied path hint.
 *  - Dedup: if the id is ALREADY bound to a desktop registry row whose
 *    `engineSessionId` matches (i.e. that row has received its ready frame — the
 *    two-id bridge fills `engineSessionId` only then, `host.ts` onSupervisorEvent),
 *    we return that row so the renderer switches/restores it instead of spawning a
 *    second sidecar. `createSession` itself does NOT dedup by engine id
 *    (`app/host/host.ts:213` mints a fresh appSessionId every call — recon
 *    2026-07-20). This resolver dedup does NOT catch a row still in its pre-ready
 *    SPAWN window (engineSessionId still null); the main handler closes THAT window
 *    with an in-flight-promise coalesce keyed by engine id (`main.ts`
 *    `openHistoryInFlight`). Together they stop the app double-opening its own
 *    session; a much narrower residual collapses to the concurrency note below.
 *
 * NOT guarded (engine precedent, on record): a transcript that is LIVE in a
 * terminal process right now. The engine's own `--resume`/`/resume <id>` path
 * does no liveness check (`src/utils/conversationRecovery.ts:536-538`) and the
 * transcript write is a plain `fs.appendFileSync` with no lockfile
 * (`src/utils/sessionStorage.ts:2971`); concurrent non-fork resume silently
 * opens a second writer. The ruling says match the engine exactly — so this path
 * adds no cross-process guard the TUI lacks (flagged in SESSIONS-UNIFICATION.md).
 * The workspace-trust gate still fail-closes first-turn execution at the resolved
 * cwd regardless of how the session was spawned (`app/sidecar/sidecarServer.ts:987`).
 */

import type { HostError, SessionDescriptor } from '../shared/hostApi.js'
import type { SessionsCatalogSnapshot } from '../shared/protocol.js'

/**
 * UUID v1–v5 shape — the same pre-lookup reject the host uses for appSessionIds
 * (`app/host/host.ts:88`). Engine session ids are UUIDs, so a non-UUID id is
 * garbage the renderer must not be able to turn into a cache lookup.
 */
const ENGINE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type OpenHistoryResolution =
  /** Reject at the boundary — the renderer renders the message honestly. */
  | { kind: 'reject'; error: HostError }
  /** Already an app row — return it; the renderer switches instead of spawning. */
  | { kind: 'existing'; descriptor: SessionDescriptor }
  /**
   * Spawn a resume of `resumeEngineSessionId` at the cache-resolved `cwd`. `title`
   * is the transcript's already-persisted display title from the catalog cache
   * (engine-derived, NOT renderer-authored — same HC1-safe source as `cwd`), so
   * the resumed session's tab/sidebar label matches the history row the operator
   * clicked instead of falling back to the cwd basename. Absent when the
   * transcript never earned a title.
   */
  | {
      kind: 'spawn'
      cwd: string
      resumeEngineSessionId: string
      title?: string
      /** Present only for a main-trusted just-created desktop fork. */
      forked?: true
    }

export type TrustedOpenHistorySeed = {
  engineSessionId: string
  cwd: string
  title?: string
  /** Main-captured provenance for a just-created desktop fork. */
  forked: true
}

/**
 * Decide what opening a history row's engine session id should do, purely from
 * the id, the current live∪restorable descriptors (dedup source), and the
 * baseline catalog cache (cwd-resolution source). No IO, no Electron — main
 * reads the cache and calls the host; this is the boundary logic in between,
 * unit-tested against fake catalogs.
 */
export function resolveOpenHistorySession(
  engineSessionId: unknown,
  descriptors: readonly SessionDescriptor[],
  catalog: SessionsCatalogSnapshot | null,
  trustedSeed?: TrustedOpenHistorySeed,
): OpenHistoryResolution {
  if (
    typeof engineSessionId !== 'string' ||
    !ENGINE_SESSION_ID_RE.test(engineSessionId)
  ) {
    return reject('session_not_found', 'malformed engine session id')
  }

  // Dedup — the id is already a live/restorable desktop row: hand it back so the
  // renderer switches (live) or restores (restorable) rather than spawning a
  // second sidecar onto the same transcript.
  const existing = descriptors.find(
    descriptor => descriptor.engineSessionId === engineSessionId,
  )
  if (existing) return { kind: 'existing', descriptor: existing }

  // cwd resolution from the engine-written cache only (HC1). No cache entry →
  // fail closed; the renderer tells the user to open it from the terminal.
  const entry = catalog?.entries.find(e => e.sessionId === engineSessionId)
  if (entry) {
    if (typeof entry.cwd !== 'string' || entry.cwd.trim().length === 0) {
      // MAJOR-1: a transcript whose workspace could not be reconciled. Never guess.
      return reject(
        'invalid_cwd',
        'that session has no recorded workspace. Open it from the terminal.',
      )
    }
    return {
      kind: 'spawn',
      cwd: entry.cwd,
      resumeEngineSessionId: engineSessionId,
      ...(entry.title && entry.title.trim().length > 0
        ? { title: entry.title }
        : {}),
      ...(entry.forked === true ||
      (trustedSeed?.engineSessionId === engineSessionId &&
        trustedSeed.forked === true)
        ? { forked: true as const }
        : {}),
    }
  }

  if (
    trustedSeed?.engineSessionId === engineSessionId &&
    ENGINE_SESSION_ID_RE.test(trustedSeed.engineSessionId) &&
    typeof trustedSeed.cwd === 'string' &&
    trustedSeed.cwd.trim().length > 0
  ) {
    return {
      kind: 'spawn',
      cwd: trustedSeed.cwd,
      resumeEngineSessionId: engineSessionId,
      ...(typeof trustedSeed.title === 'string' &&
      trustedSeed.title.trim().length > 0
        ? { title: trustedSeed.title }
        : {}),
      forked: true,
    }
  }

  return reject(
    'session_not_found',
    'no recorded session for that id. Open it from the terminal.',
  )
}

function reject(
  code: HostError['code'],
  message: string,
): { kind: 'reject'; error: HostError } {
  return { kind: 'reject', error: { code, message } }
}
