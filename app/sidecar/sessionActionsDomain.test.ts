/**
 * P4-6b — session-actions domain unit tests. Exercises the domain's fail-closed
 * wrapping + result shaping over an INJECTED fake executor (no real transcript on
 * disk). The engine-op round-trip (saveCustomTitle / renderMessagesToPlainText /
 * createFork) is not re-proven here — the seam is the boundary these tests hold.
 */

import { describe, expect, test } from 'bun:test'
import {
  createSidecarSessionActionsDomain,
  type SessionActionsExecutor,
} from './sessionActionsDomain.js'

function fakeExecutor(
  overrides: Partial<SessionActionsExecutor> = {},
): { executor: SessionActionsExecutor; calls: string[] } {
  const calls: string[] = []
  const executor: SessionActionsExecutor = {
    async rename(title) {
      calls.push(`rename:${title}`)
    },
    async export() {
      calls.push('export')
      return 'RENDERED TRANSCRIPT'
    },
    async branch() {
      calls.push('branch')
      return {
        engineSessionId: 'fork-engine-id',
        title: 'First prompt (Branch)',
        forkPath: '/tmp/fork.jsonl',
      }
    },
    ...overrides,
  }
  return { executor, calls }
}

describe('sessionActionsDomain — rename', () => {
  test('a non-empty title is trimmed, forwarded to the executor, and acked ok', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('  My Session  ')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('My Session')
    // The executor sees the TRIMMED title.
    expect(calls).toEqual(['rename:My Session'])
  })

  test('an empty / whitespace-only title fails closed BEFORE the executor runs', async () => {
    const { executor, calls } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('   ')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Title cannot be empty.')
    expect(calls).toEqual([])
  })

  test('an executor throw degrades to ok:false, never a rejection', async () => {
    const { executor } = fakeExecutor({
      rename: async () => {
        throw new Error('disk full')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.rename('x')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('disk full')
  })
})

describe('sessionActionsDomain — export', () => {
  test('carries the engine-rendered text on a successful result', async () => {
    const { executor } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(true)
    expect(result.exportText).toBe('RENDERED TRANSCRIPT')
  })

  test('an executor throw degrades to ok:false with no exportText', async () => {
    const { executor } = fakeExecutor({
      export: async () => {
        throw new Error('no conversation')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.export()

    expect(result.ok).toBe(false)
    expect(result.exportText).toBeUndefined()
    expect(result.message).toContain('no conversation')
  })
})

describe('sessionActionsDomain — branch', () => {
  test('carries the new fork engine session id on a successful result', async () => {
    const { executor } = fakeExecutor()
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.branch()

    expect(result.ok).toBe(true)
    expect(result.branchEngineSessionId).toBe('fork-engine-id')
    expect(result.message).toContain('Branch')
  })

  test('an executor throw degrades to ok:false with no branch id', async () => {
    const { executor } = fakeExecutor({
      branch: async () => {
        throw new Error('No conversation to branch')
      },
    })
    const domain = createSidecarSessionActionsDomain({ executor })

    const result = await domain.branch()

    expect(result.ok).toBe(false)
    expect(result.branchEngineSessionId).toBeUndefined()
    expect(result.message).toContain('No conversation to branch')
  })
})
