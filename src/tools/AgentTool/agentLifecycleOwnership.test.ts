import { afterEach, describe, expect, test } from 'bun:test'

import {
  _resetAgentLifecycleOwnershipForTest,
  acquireAgentLifecycleOwnership,
  isAgentLifecycleOwned,
  runWithAgentLifecycleOwnership,
} from './agentLifecycleOwnership.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('agent lifecycle ownership', () => {
  afterEach(() => {
    _resetAgentLifecycleOwnershipForTest()
  })

  test('holds one agent id until detached finalization settles', async () => {
    const entered = deferred<void>()
    const finish = deferred<void>()
    const lifecycle = runWithAgentLifecycleOwnership(
      'agent-finalizing',
      async () => {
        entered.resolve()
        await finish.promise
      },
    )

    await entered.promise
    expect(isAgentLifecycleOwned('agent-finalizing')).toBe(true)
    expect(acquireAgentLifecycleOwnership('agent-finalizing')).toBeUndefined()

    finish.resolve()
    await lifecycle
    expect(isAgentLifecycleOwned('agent-finalizing')).toBe(false)
  })
})
