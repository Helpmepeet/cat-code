import { expect, test } from 'bun:test'
import { createWorkspaceObserver } from './workspaceObservation.js'

test('restored provenance survives live checkout observations until conversation continues', async () => {
  let cwd = '/checkout'
  let branch = 'external'
  let reads = 0
  const observer = await createWorkspaceObserver({ lastWorkingBranch: 'recorded' }, {
    cwd: () => cwd,
    branch: async () => { reads++; return branch },
  })
  expect(observer.getSnapshot()).toEqual({ cwd, lastWorkingBranch: 'recorded' })
  cwd = '/entered-worktree'
  branch = 'worktree-branch'
  expect(observer.getSnapshot()).toEqual({ cwd, lastWorkingBranch: 'recorded' })
  expect(reads).toBe(0)
  await observer.conversationContinued()
  expect(observer.getSnapshot()).toEqual({ cwd, lastWorkingBranch: 'worktree-branch' })
  branch = 'external-again'
  expect(observer.getSnapshot().lastWorkingBranch).toBe('worktree-branch')
})

test('unknown restored branch remains unknown, rather than adopting the current checkout', async () => {
  const observer = await createWorkspaceObserver({}, {
    cwd: () => '/checkout',
    branch: async () => 'current',
  })
  expect(observer.getSnapshot()).toEqual({ cwd: '/checkout' })
  await observer.conversationContinued()
  expect(observer.getSnapshot().lastWorkingBranch).toBe('current')
})
