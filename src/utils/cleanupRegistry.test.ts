import { expect, test } from 'bun:test'

import {
  registerCleanup,
  runCleanupFunctionsSettled,
} from './cleanupRegistry.js'

test('all-settled cleanup runs peers after a registered cleanup rejects', async () => {
  const calls: string[] = []
  const unregisterRejecting = registerCleanup(async () => {
    calls.push('rejecting')
    throw new Error('fixture rejection')
  })
  const unregisterPeer = registerCleanup(async () => {
    calls.push('peer')
  })

  try {
    await expect(runCleanupFunctionsSettled()).resolves.toEqual({ rejected: 1 })
    expect(calls).toEqual(['rejecting', 'peer'])
  } finally {
    unregisterRejecting()
    unregisterPeer()
  }
})
