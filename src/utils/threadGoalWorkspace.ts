import { execFileNoThrow } from './execFileNoThrow.js'
import { getCwd } from './cwd.js'
import { stableHashContent } from './hash.js'

/**
 * A fingerprint of the workspace state a piece of goal evidence describes.
 *
 * Evidence is a claim about the world at a moment ("the suite passed"). It
 * stops being true when the world moves, so the gate compares the fingerprint
 * recorded with the evidence against the current one.
 *
 * This reads git state only. It runs no user-supplied command and takes no
 * argument from the model, so it adds no execution surface: a natural-language
 * goal cannot steer what runs here.
 *
 * Known limits, deliberately not papered over:
 *
 * - `git status --porcelain` alone reports only PATHS and status letters, so
 *   an edit that changes a file's content while preserving its status shape
 *   looks identical. `git diff HEAD` is therefore hashed alongside it, which
 *   closes that hole for tracked files.
 * - Untracked files still contribute their paths but not their contents, so
 *   editing an untracked file in place does not move the fingerprint.
 * - Changes outside the repository are invisible.
 *
 * A fingerprint that fails to move makes stale evidence look fresh, so these
 * limits are the failure mode to remember when reading a green gate.
 */

const GIT_TIMEOUT_MS = 10_000

/**
 * Fingerprint for a workspace where git cannot answer.
 *
 * A constant, not a random value: a random one would make every record stale
 * the instant it was written and no gated goal could ever complete. But a
 * constant alone means evidence here NEVER expires, so the gate additionally
 * time-bounds any record carrying this value
 * (`UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS`). Bounded staleness is the honest
 * answer when freshness is genuinely unknowable; unbounded staleness reads as
 * proof and is not.
 */
export const UNKNOWN_WORKSPACE_FINGERPRINT = 'workspace:unavailable'

/**
 * How long evidence recorded against an unknowable workspace stays fresh.
 *
 * Only applies to `UNKNOWN_WORKSPACE_FINGERPRINT` records. A real git
 * fingerprint is compared exactly and needs no clock.
 */
export const UNKNOWN_WORKSPACE_EVIDENCE_TTL_MS = 15 * 60 * 1000

export async function getThreadGoalWorkspaceFingerprint(): Promise<string> {
  const cwd = getCwd()

  const [head, status, diff] = await Promise.all([
    execFileNoThrow('git', ['rev-parse', 'HEAD'], {
      timeout: GIT_TIMEOUT_MS,
      preserveOutputOnError: false,
      useCwd: true,
    }),
    execFileNoThrow('git', ['status', '--porcelain'], {
      timeout: GIT_TIMEOUT_MS,
      preserveOutputOnError: false,
      useCwd: true,
    }),
    execFileNoThrow('git', ['diff', 'HEAD'], {
      timeout: GIT_TIMEOUT_MS,
      preserveOutputOnError: false,
      useCwd: true,
    }),
  ])

  // Any git failure means "not a repo" or "git unavailable". Both are the same
  // answer: this cannot report freshness.
  //
  // `diff` is in that list too. Hashing '' on failure made a timed-out diff
  // hash IDENTICALLY to a clean tree, so a workspace that had moved kept
  // matching the fingerprint recorded before it moved, and a red gate could be
  // skipped as "nothing changed". A degraded freshness check must not be
  // indistinguishable from a passing one.
  if (head.code !== 0 || status.code !== 0 || diff.code !== 0) {
    return UNKNOWN_WORKSPACE_FINGERPRINT
  }

  return stableHashContent(
    JSON.stringify({
      cwd,
      head: head.stdout.trim(),
      status: status.stdout,
      // Hashed, not stored: a diff carries file contents, and the fingerprint
      // is projected to other processes.
      diff: stableHashContent(diff.stdout),
    }),
  )
}
