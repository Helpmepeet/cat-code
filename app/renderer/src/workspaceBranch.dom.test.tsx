import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import { useWorkspaceBranch } from './useWorkspaceBranch.js'
import { LidClosedContext } from './lidClosedState.js'
import type { HostResult, WorkspaceBranches } from '../../shared/hostApi.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function BranchRail({ list, enabled = true, recorded = 'main' }: { list: () => Promise<HostResult<WorkspaceBranches>>; enabled?: boolean; recorded?: string }) {
  const branch = useWorkspaceBranch(enabled, list, recorded)
  const view = { phase: 'off' as const, activeSessions: 0, activeSubagents: 0, waitingForApproval: false, installed: false, sleepRequested: false }
  return <LidClosedContext.Provider value={{ view, command() {}, inspect() {} }}>
    <ComposerActionsBar workspaceBranch={branch} attachDisabled={false} onAttach={() => {}} model={null} reasoningEffort={null} fastMode={null} permissionContext={null} onSetMode={() => {}} account={null} contextUsage={null} />
  </LidClosedContext.Provider>
}

test('readout sits immediately left of the cup and updates external switches without moving the conversation baseline', async () => {
  let snapshot: WorkspaceBranches = { current: 'main', branches: ['main', 'fix/typo'], dirty: false, recordedBranch: 'main' }
  const list = async (): Promise<HostResult<WorkspaceBranches>> => ({ ok: true, value: snapshot })
  const tree = await harness.mount(<BranchRail list={list} />)
  const readout = () => tree.container.querySelector<HTMLElement>('[data-composer-face="git-branch"]')!
  expect(readout().textContent).toBe('main')
  expect(readout().nextElementSibling?.querySelector('[data-composer-face]')?.getAttribute('data-composer-face')).toBe('lid-closed')
  expect(readout().getAttribute('aria-haspopup')).toBeNull()
  snapshot = { ...snapshot, current: 'fix/typo' }
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(readout().classList.contains('workspace-branch-changed')).toBe(true)
  expect(readout().getAttribute('aria-label')).toBe('Checkout is on fix/typo. This chat was on main.')
  expect(tree.container.querySelector('.workspace-branch-label')?.textContent).toBe('Checkout is on fix/typo. This chat was on main.')
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(readout().classList.contains('workspace-branch-changed')).toBe(true)
  // Only engine-recorded conversation activity advances the baseline.
  snapshot = { ...snapshot, recordedBranch: 'fix/typo' }
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(readout().textContent).toBe('fix/typo')
  expect(readout().classList.contains('workspace-branch-changed')).toBe(false)
  expect(tree.container.querySelector('.workspace-branch-label')).toBeNull()
})

test('reopened history compares recorded branch, and detached checkout is not shown as none', async () => {
  const tree = await harness.mount(<BranchRail list={async () => ({ ok: true, value: { current: 'fix/typo', branches: [], dirty: false, recordedBranch: 'main' } })} />)
  expect(tree.container.querySelector('.workspace-branch-changed')?.textContent).toContain('fix/typo')
  const detached = await harness.mount(<BranchRail list={async () => ({ ok: true, value: { current: null, detached: 'abc1234', branches: [], dirty: false, recordedBranch: 'main' } })} />)
  expect(detached.container.querySelector('.workspace-branch-name')?.textContent).toBe('abc1234')
})

test('projectless and non-Git chats hide readout; a temporary read failure retains a known branch', async () => {
  let calls = 0
  const managed = await harness.mount(<BranchRail enabled={false} list={async () => { calls++; return { ok: true, value: { current: 'main', branches: [], dirty: false } } }} />)
  expect(calls).toBe(0)
  expect(managed.container.querySelector('.workspace-branch')).toBeNull()
  const nonGit = await harness.mount(<BranchRail list={async () => ({ ok: false, error: { code: 'branch_unavailable', message: 'This project is not a Git repository.' } })} />)
  expect(nonGit.container.querySelector('.workspace-branch')).toBeNull()
  let failed = false
  const tree = await harness.mount(<BranchRail list={async () => failed ? { ok: false, error: { code: 'branch_unavailable', message: 'Could not read branches for this project.' } } : { ok: true, value: { current: 'main', branches: [], dirty: false } }} />)
  failed = true
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(tree.container.querySelector('.workspace-branch-name')?.textContent).toBe('main')
  const readout = tree.container.querySelector<HTMLElement>('.workspace-branch')!
  await act(async () => readout.focus())
  expect(readout.tabIndex).toBe(0)
  expect(document.activeElement).toBe(readout)
})

test('an open chat polls the checkout without waiting for focus and stops reading after unmount', async () => {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let tick: (() => void) | undefined
  let cleared = false
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    if (delay === 2_000) { tick = callback; return 98765 }
    return originalSetInterval(callback, delay)
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    if (Number(timer) === 98765) cleared = true
    else originalClearInterval(timer)
  }) as typeof clearInterval
  try {
    let current = 'main'
    let calls = 0
    const tree = await harness.mount(<BranchRail list={async () => { calls++; return { ok: true, value: { current, branches: [], dirty: false, recordedBranch: 'main' } } }} />)
    current = 'feature/login'
    await act(async () => tick?.())
    expect(tree.container.querySelector('.workspace-branch-name')?.textContent).toBe('feature/login')
    const before = calls
    await tree.unmount()
    expect(cleared).toBe(true)
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(calls).toBe(before)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})
