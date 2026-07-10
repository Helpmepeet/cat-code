/**
 * Workspace-trust domain (P4-14) — the read-only VIEW half of the Settings →
 * Workspace section. Real backing:
 *
 *  - `trusted`: `isPathTrusted(cwd)` (`src/utils/config.ts:790`) — walks the
 *    SAME `config.projects[...].hasTrustDialogAccepted` store the CLI's trust
 *    dialog persists to, for THIS session's cwd. It does not consult session-
 *    only trust (`checkHasTrustDialogAccepted`'s `getSessionTrustAccepted()`
 *    branch, config.ts:743) — a desktop session's trust is either persisted or
 *    it isn't; there is no in-memory-only trust path here.
 *  - `detectedRepo`: `getGithubRepo()` (`src/utils/git.ts:504`) — the git
 *    remote origin, parsed to `owner/repo`, resolved against the sidecar's own
 *    process cwd (the sidecar is spawned in the session's cwd, P3-1).
 *
 * The "Additional trusted directories" list is DELIBERATELY not part of this
 * domain — it already crosses the wire on the C3 `permission.context` frame's
 * `additionalWorkingDirectories` (the same engine `ToolPermissionContext` the
 * runtime enforces); the renderer selects it from there (§10 — reuse the real
 * entry point, don't re-plumb the same data through a second seam).
 *
 * The read half is spawn-time-frozen (like the settings seam): repo does not
 * change within a session's lifetime — a workspace switch spawns a NEW sidecar
 * at the new cwd. The one MUTATION is P4-15's session-create trust gate:
 * `acceptTrust()` persists trust for THIS session's cwd through the engine's own
 * `saveCurrentProjectConfig` (the SAME write the CLI `TrustDialog` performs,
 * `src/components/TrustDialog/TrustDialog.tsx:177,272`), then re-reads
 * `isPathTrusted(cwd)` and updates the stored snapshot so the sidecar can
 * re-broadcast `trusted:true`. HC1: the sidecar trusts only its OWN spawn cwd —
 * no renderer-supplied path.
 *
 * ZERO transport knowledge: frames, validation, and limits stay in
 * `sidecarServer.ts`.
 */

import { isPathTrusted } from '../../src/utils/config.js'
import { saveCurrentProjectConfig } from '../../src/utils/config.js'
import { getGithubRepo } from '../../src/utils/git.js'
import type { WorkspaceTrustSnapshot } from '../shared/protocol.js'

/** The redacted outcome of an accept-trust write (no transport, no secret). */
export type WorkspaceTrustAcceptResult = {
  ok: boolean
  message: string
  /** Whether the write actually changed the store (drives snapshot re-broadcast). */
  changed: boolean
}

/**
 * The engine trust ops, behind a seam. The real implementation
 * (`createRealWorkspaceTrustExecutor`) wires the engine's own
 * `isPathTrusted` / `saveCurrentProjectConfig`; tests inject a fake so a headless
 * round-trip proves the wiring without writing the real global config (§10 —
 * mirrors accountsDomain's executor seam).
 */
export type WorkspaceTrustExecutor = {
  /** Is THIS cwd trusted right now? (real: `isPathTrusted(cwd)`, config.ts:790) */
  isTrusted(): boolean
  /** Persist trust for THIS cwd (real: `saveCurrentProjectConfig`, config.ts:1663). */
  persistTrust(): void
}

export function createRealWorkspaceTrustExecutor(
  cwd: string,
): WorkspaceTrustExecutor {
  return {
    isTrusted() {
      return isPathTrusted(cwd)
    },
    persistTrust() {
      // The engine's OWN persistence — the identical updater the CLI TrustDialog
      // applies on accept (`TrustDialog.tsx:177` → `_temp5`, :272). It writes at
      // `getProjectPathForConfig()` (git root or cwd); `isPathTrusted(cwd)` walks
      // up from cwd and finds it, so the re-read reflects the write.
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }))
    },
  }
}

export type SidecarWorkspaceTrustDomain = {
  /** The trust/repo facts for this session's cwd. null if the read failed. */
  getSnapshot(): WorkspaceTrustSnapshot | null
  /**
   * Accept trust for this session's cwd: persist through the engine, re-read
   * `isTrusted`, update the stored snapshot. Idempotent (already-trusted →
   * ok, unchanged). Throw-free.
   */
  acceptTrust(): WorkspaceTrustAcceptResult
}

/**
 * Build the domain for `cwd` (the session's root, matching the sidecar's own
 * process cwd — P3-1). `getGithubRepo()` shells out to git, so construction is
 * async; the reads are then pure + throw-free like every other domain's
 * `getSnapshot()` (read-at-spawn discipline, settingsDomain.ts's rule 3).
 */
export async function createSidecarWorkspaceTrustDomain(
  cwd: string,
  options: { executor?: WorkspaceTrustExecutor } = {},
): Promise<SidecarWorkspaceTrustDomain> {
  const executor = options.executor ?? createRealWorkspaceTrustExecutor(cwd)
  let snapshot = await readWorkspaceTrustSnapshotOnce(cwd)
  return {
    getSnapshot() {
      return snapshot
    },
    acceptTrust() {
      try {
        if (executor.isTrusted()) {
          snapshot = { trusted: true, detectedRepo: snapshot?.detectedRepo ?? null }
          return { ok: true, message: 'Workspace already trusted.', changed: false }
        }
        executor.persistTrust()
        const trusted = executor.isTrusted()
        snapshot = { trusted, detectedRepo: snapshot?.detectedRepo ?? null }
        return trusted
          ? { ok: true, message: 'Workspace trusted.', changed: true }
          : {
              ok: false,
              message: 'Trust write did not persist; the workspace is still untrusted.',
              changed: false,
            }
      } catch (error) {
        return {
          ok: false,
          message: `Could not trust the workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
          changed: false,
        }
      }
    },
  }
}

async function readWorkspaceTrustSnapshotOnce(
  cwd: string,
): Promise<WorkspaceTrustSnapshot | null> {
  try {
    const trusted = isPathTrusted(cwd)
    const detectedRepo = await getGithubRepo()
    return { trusted, detectedRepo }
  } catch (error) {
    process.stderr.write(
      `[sidecar] workspace-trust snapshot read failed (session runs without a workspace-trust snapshot): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return null
  }
}
