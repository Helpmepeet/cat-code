import { afterEach, expect, test } from 'bun:test'
import { getCwdState } from '../../src/bootstrap/state.js'
import { setWorkspaceTransitionCoordinator, withWorkspaceTransition } from '../../src/utils/workspaceTransition.js'
import { createWorkspaceTransitionCoordinator } from './workspaceTransition.js'
import type { PeerHostRequester } from './peerHostRequester.js'

afterEach(() => setWorkspaceTransitionCoordinator(null))

test('the lease encloses asynchronous mutation and acknowledges the settled observation', async () => {
  const calls: Array<{ verb: string; args: unknown }> = []
  let release!: () => void
  let entered!: () => void
  const changed = new Promise<void>(resolve => { release = resolve })
  const inside = new Promise<void>(resolve => { entered = resolve })
  setWorkspaceTransitionCoordinator(createWorkspaceTransitionCoordinator((async (verb, args) => {
    calls.push({ verb, args })
    return { ok: true, value: { operationId: (args as { operationId: string }).operationId } }
  }) as PeerHostRequester))
  const pending = withWorkspaceTransition(async () => { entered(); await changed; return 'changed' })
  await inside
  expect(calls.map(call => call.verb)).toEqual(['workspace.transition.begin'])
  release()
  expect(await pending).toBe('changed')
  expect(calls.map(call => call.verb)).toEqual(['workspace.transition.begin', 'workspace.transition.finish'])
  expect(calls[1]!.args).toEqual({ ...(calls[0]!.args as object), cwd: getCwdState() })
})

test('an uncertain or mismatched admission never runs the cwd mutation', async () => {
  for (const outcome of [
    { ok: false, error: { code: 'timeout', message: 'late' } },
    { ok: true, value: { operationId: 'wrong-operation' } },
  ]) {
    let changes = 0
    setWorkspaceTransitionCoordinator(createWorkspaceTransitionCoordinator((async () => outcome) as PeerHostRequester))
    await expect(withWorkspaceTransition(() => { changes++ })).rejects.toThrow('Could not change the working folder')
    expect(changes).toBe(0)
  }
})

test('a failed mutation still publishes its actual cwd, while an uncertain finish is surfaced', async () => {
  let finishes = 0
  setWorkspaceTransitionCoordinator({ begin: async () => {}, finish: async () => { finishes++ } })
  await expect(withWorkspaceTransition(() => { throw new Error('mutation failed') })).rejects.toThrow('mutation failed')
  expect(finishes).toBe(1)
  setWorkspaceTransitionCoordinator(createWorkspaceTransitionCoordinator((async (verb, args) => verb === 'workspace.transition.begin'
    ? { ok: true, value: { operationId: (args as { operationId: string }).operationId } }
    : { ok: false, error: { code: 'timeout', message: 'late' } }) as PeerHostRequester))
  await expect(withWorkspaceTransition(() => 'changed')).rejects.toThrow('app could not confirm the working folder')
})

test('terminal engines without a desktop coordinator retain ordinary transitions', async () => {
  expect(await withWorkspaceTransition(() => 42)).toBe(42)
})
