import { execFileNoThrow } from './execFileNoThrow.js'
import { getCwd } from './cwd.js'
import { hashContent } from './hash.js'

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
 * Deliberately a constant rather than a random value: a random one would make
 * every piece of evidence instantly stale and no gated goal could complete,
 * while a constant makes evidence persist exactly as long as the gate can
 * actually tell. Callers that need real freshness in a non-git workspace must
 * supply their own fingerprint.
 */
export const UNKNOWN_WORKSPACE_FINGERPRINT = 'workspace:unavailable'

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
  if (head.code !== 0 || status.code !== 0) {
    return UNKNOWN_WORKSPACE_FINGERPRINT
  }

  return hashContent(
    JSON.stringify({
      cwd,
      head: head.stdout.trim(),
      status: status.stdout,
      // Hashed, not stored: a diff carries file contents, and the fingerprint
      // is projected to other processes.
      diff: hashContent(diff.code === 0 ? diff.stdout : ''),
    }),
  )
}
