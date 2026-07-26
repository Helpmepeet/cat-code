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
 *  - `trustRoot`: `getProjectPathForConfig()` (`src/utils/config.ts:1626`) — the
 *    path an accept ACTUALLY writes at. Read through the write's own function
 *    (`saveCurrentProjectConfig` calls it at `config.ts:1675`) rather than
 *    re-derived here, so the scope the gate displays cannot drift from the scope
 *    that gets stored. It is the canonical git ROOT, not the session cwd — see
 *    the `trustRoot` doc-comment in `protocol.ts` for why that mismatch is the
 *    honesty gap this field closes.
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
import {
  getProjectPathForConfig,
  saveCurrentProjectConfig,
} from '../../src/utils/config.js'
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
  /**
   * Where `persistTrust()` will actually write — the SAME
   * `getProjectPathForConfig()` that keys the write (`config.ts:1675`), never a
   * re-derivation. Reading it through the write's own function is what makes the
   * gate's displayed scope unable to drift from the stored scope (§8 rule 1:
   * construct from the source the engine runtime uses).
   */
  getTrustRoot(): string | null
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
    getTrustRoot() {
      // The write key itself (config.ts:1675 reads the same call). Git root of
      // the session's cwd, or the cwd when it is not in a repo.
      return getProjectPathForConfig()
    },
  }
}

export type SidecarWorkspaceTrustDomain = {
  /**
   * The trust/repo facts for this session's cwd. The real domain never returns
   * null (a failed read fails CLOSED to `trusted:false` — P4-25); the `| null` in
   * the type is retained for the injected test fake and defensive consumers.
   */
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
  // Trust is read through the executor (real: `isPathTrusted(cwd)`) so the spawn
  // snapshot and `acceptTrust` share ONE truth source — otherwise a fake in
  // tests, or an out-of-band concurrent trust write, could disagree.
  let snapshot = await readWorkspaceTrustSnapshotOnce(executor)
  return {
    getSnapshot() {
      return snapshot
    },
    acceptTrust() {
      // `changed` = whether the RENDERER-VISIBLE snapshot flips false→true, so a
      // re-broadcast still clears a stale-false gate when trust was persisted
      // out-of-band after this session's spawn read (N-process, same cwd).
      const wasTrusted = snapshot?.trusted === true
      const detectedRepo = snapshot?.detectedRepo ?? null
      // Carried, not re-read: the accept writes at the SAME root the gate just
      // showed, so the re-broadcast must not silently report a different scope.
      const trustRoot = snapshot?.trustRoot ?? null
      try {
        if (!executor.isTrusted()) {
          executor.persistTrust()
        }
        const trusted = executor.isTrusted()
        snapshot = { trusted, detectedRepo, trustRoot }
        if (!trusted) {
          return {
            ok: false,
            message: 'Trust write did not persist; the workspace is still untrusted.',
            changed: false,
          }
        }
        return {
          ok: true,
          message: wasTrusted ? 'Workspace already trusted.' : 'Workspace trusted.',
          changed: !wasTrusted,
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
  executor: WorkspaceTrustExecutor,
): Promise<WorkspaceTrustSnapshot> {
  // SECURITY (P4-25, review B1): fail CLOSED. This snapshot backs the sidecar
  // submit gate (`sidecarServer.ts` handleSubmit). A `null` snapshot must NEVER
  // be read as "permit", so a failed read defaults to UNTRUSTED (never null), and
  // `trusted` is computed INDEPENDENTLY of the cosmetic repo read — a git-spawn
  // failure must not discard a known trust fact into an open gate.
  let trusted = false
  try {
    trusted = executor.isTrusted()
  } catch (error) {
    process.stderr.write(
      `[sidecar] workspace-trust read failed; defaulting to UNTRUSTED (fail-closed): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    trusted = false
  }
  // `detectedRepo` is Settings-display only — a failure here must not touch trust.
  let detectedRepo: string | null = null
  try {
    detectedRepo = await getGithubRepo()
  } catch (error) {
    process.stderr.write(
      `[sidecar] workspace-trust repo detection failed (display only): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    detectedRepo = null
  }
  // The scope an accept would write at. Read INDEPENDENTLY of `trusted` for the
  // same P4-25 reason as `detectedRepo`: a failure here degrades the gate's copy
  // to "scope unresolved", it must never discard a known trust fact — and it can
  // never turn an untrusted workspace into an open gate.
  let trustRoot: string | null = null
  try {
    trustRoot = executor.getTrustRoot()
  } catch (error) {
    process.stderr.write(
      `[sidecar] workspace-trust root resolution failed (gate shows scope as unresolved): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    trustRoot = null
  }
  return { trusted, detectedRepo, trustRoot }
}
