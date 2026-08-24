import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from './cwd.js'

const execResults = new Map<string, { code: number; stdout: string }>()
const realExec = await import('./execFileNoThrow.js')
// Captured BEFORE mock.module, which swaps the namespace property in place:
// calling through `realExec.execFileNoThrow` afterwards re-enters the mock.
const realExecFileNoThrow = realExec.execFileNoThrow

mock.module('./execFileNoThrow.js', () => ({
  ...realExec,
  execFileNoThrow: async (
    file: string,
    args: string[],
    options?: unknown,
  ): Promise<unknown> => {
    const override = execResults.get(args.join(' '))
    if (override) return { ...override, stderr: '' }
    return realExecFileNoThrow(file, args, options as never)
  },
}))

const {
  getThreadGoalWorkspaceFingerprint,
  UNKNOWN_WORKSPACE_FINGERPRINT,
} = await import('./threadGoalWorkspace.js')

const tempDirs: string[] = []

afterEach(() => {
  execResults.clear()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-workspace-'))
  tempDirs.push(dir)
  return dir
}

describe('the workspace fingerprint', () => {
  test('a real repository fingerprints to a stable value', async () => {
    const first = await getThreadGoalWorkspaceFingerprint()
    const second = await getThreadGoalWorkspaceFingerprint()

    expect(first).not.toBe(UNKNOWN_WORKSPACE_FINGERPRINT)
    expect(first).toBe(second)
  })

  test('a directory git cannot answer for reports that, rather than guessing', async () => {
    const fingerprint = await runWithCwdOverride(tempDir(), () =>
      getThreadGoalWorkspaceFingerprint(),
    )
    expect(fingerprint).toBe(UNKNOWN_WORKSPACE_FINGERPRINT)
  })

  test('a failed diff degrades honestly instead of hashing as a clean tree', async () => {
    // The regression: a `git diff HEAD` that timed out was hashed as '', which
    // is byte-identical to a clean tree. A workspace that HAD moved kept
    // matching the fingerprint recorded before it moved, so a red gate could
    // be skipped as "nothing changed". Degraded must not equal passing.
    execResults.set('diff HEAD', { code: 124, stdout: '' })

    expect(await getThreadGoalWorkspaceFingerprint()).toBe(
      UNKNOWN_WORKSPACE_FINGERPRINT,
    )
  })

  test('a failed diff is distinguishable from a genuinely clean tree', async () => {
    execResults.set('diff HEAD', { code: 0, stdout: '' })
    const cleanTree = await getThreadGoalWorkspaceFingerprint()

    execResults.set('diff HEAD', { code: 124, stdout: '' })
    const failedDiff = await getThreadGoalWorkspaceFingerprint()

    expect(failedDiff).not.toBe(cleanTree)
  })

  test('a moved diff moves the fingerprint', async () => {
    execResults.set('diff HEAD', { code: 0, stdout: '' })
    const before = await getThreadGoalWorkspaceFingerprint()

    execResults.set('diff HEAD', { code: 0, stdout: '+ a change' })
    const after = await getThreadGoalWorkspaceFingerprint()

    expect(after).not.toBe(before)
  })
})
