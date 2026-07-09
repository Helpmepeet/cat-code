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
 * Read-only, spawn-time-frozen (like the settings seam): trust/repo do not
 * change within a session's lifetime — a workspace switch spawns a NEW
 * sidecar at the new cwd, not a mutation of this one. The Untrust/Trust
 * mutate ACTION is P4-15's session-create trust gate, not this domain.
 *
 * ZERO transport knowledge: frames, validation, and limits stay in
 * `sidecarServer.ts`.
 */

import { isPathTrusted } from '../../src/utils/config.js'
import { getGithubRepo } from '../../src/utils/git.js'
import type { WorkspaceTrustSnapshot } from '../shared/protocol.js'

export type SidecarWorkspaceTrustDomain = {
  /** The spawn-time trust/repo facts for this session's cwd. null if the read failed. */
  getSnapshot(): WorkspaceTrustSnapshot | null
}

/**
 * Build the domain for `cwd` (the session's root, matching the sidecar's own
 * process cwd — P3-1). `getGithubRepo()` shells out to git, so construction is
 * async; the result is then a pure, throw-free read like every other domain's
 * `getSnapshot()` (read-at-spawn discipline, settingsDomain.ts's rule 3).
 */
export async function createSidecarWorkspaceTrustDomain(
  cwd: string,
): Promise<SidecarWorkspaceTrustDomain> {
  const snapshot = await readWorkspaceTrustSnapshotOnce(cwd)
  return {
    getSnapshot() {
      return snapshot
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
