import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { restoreTrustedDeferredContinuationContext } from './sessionRestore.js'
import { setCwd } from './Shell.js'

const cleanup: string[] = []
const originalCwd = process.cwd()

afterEach(async () => {
  process.chdir(originalCwd)
  setCwd(originalCwd)
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('trusted deferred continuation context restoration', () => {
  test('restores a canonical cwd only when it is contained by transcript project identity', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-context-')
    cleanup.push(root)
    const project = join(root, 'project')
    const child = join(project, 'nested')
    await mkdir(child, { recursive: true })
    await restoreTrustedDeferredContinuationContext(
      { cwd: child },
      { projectPath: project, worktreeSession: null },
    )
    expect(process.cwd()).toBe(await realpath(child))
  })

  test('rejects cwd containment escapes and worktree identity mismatches', async () => {
    const root = await mkdtemp('/tmp/cat-code-deferred-context-reject-')
    cleanup.push(root)
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    await mkdir(project)
    await mkdir(outside)
    await expect(
      restoreTrustedDeferredContinuationContext(
        { cwd: outside },
        { projectPath: project, worktreeSession: null },
      ),
    ).rejects.toThrow('outside trusted project context')
    await expect(
      restoreTrustedDeferredContinuationContext(
        { cwd: project, worktreeRoot: project },
        { projectPath: project, worktreeSession: null },
      ),
    ).rejects.toThrow('worktree identity mismatch')
  })
})
