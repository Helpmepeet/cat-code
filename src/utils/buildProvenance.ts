import { spawnSync } from 'node:child_process'

const COMMIT_ID = /^[0-9a-f]{7,40}$/i

/**
 * Build an unambiguous, compact source identity for transcript provenance.
 * Unknown commits are never labelled dirty because there is no source identity
 * to attach that state to.
 */
export function formatBuildId(commitId: string | null, dirty: boolean): string {
  const normalized = commitId?.trim() ?? ''
  if (!COMMIT_ID.test(normalized)) return 'unknown'
  const short = normalized.slice(0, 8).toLowerCase()
  return dirty ? `${short}-dirty` : short
}

function captureGit(repoRoot: string, args: string[]): string | null {
  const result = spawnSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
    },
  )
  if (result.status !== 0) return null
  return result.stdout.trim()
}

export function buildIdFromGitOutputs(
  commitId: string | null,
  status: string | null,
): string {
  if (commitId === null || status === null) return 'unknown'
  return formatBuildId(commitId, status !== '')
}

/**
 * Resolve provenance from an explicitly trusted Cat Code checkout. Callers
 * cache the result at startup/build time; transcript hot paths never run git.
 */
export function readSourceBuildId(repoRoot: string): string {
  const commitId = captureGit(repoRoot, ['rev-parse', 'HEAD'])
  if (commitId === null) return 'unknown'
  const status = captureGit(repoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ])
  return buildIdFromGitOutputs(commitId, status)
}
