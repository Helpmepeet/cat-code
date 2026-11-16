import { test, expect } from 'bun:test'
import { createRuntime, type JsonValue } from './index'

// This is a floor for the pinned guest profile, not an exhaustive future-API
// audit. Newly available callback/async surfaces require explicit fence review.
test('pinned guest lacks untracked native callback and async helper surfaces', async () => {
  const runtime = createRuntime({ limits: { wallTimeMs: 3000 } })
  const outputs: JsonValue[] = []
  try {
    const outcome = await runtime.run({
      cellId: 'continuation-profile',
      source: `output({
        FinalizationRegistry: typeof FinalizationRegistry,
        WeakRef: typeof WeakRef,
        queueMicrotask: typeof queueMicrotask,
        setTimeout: typeof setTimeout,
        Atomics: typeof Atomics,
        AsyncIterator: typeof AsyncIterator,
        arrayFromAsync: typeof Array.fromAsync,
        promiseWithResolvers: typeof Promise.withResolvers,
        SharedArrayBuffer: typeof SharedArrayBuffer
      });`,
      signal: new AbortController().signal,
      dispatch: async () => { throw new Error('No dispatch expected') },
      onOutput: output => outputs.push(output.value),
    })
    expect(outcome.status, outcome.error).toBe('ok')
    expect(outputs).toEqual([{
      FinalizationRegistry: 'undefined',
      WeakRef: 'undefined',
      queueMicrotask: 'undefined',
      setTimeout: 'undefined',
      Atomics: 'undefined',
      AsyncIterator: 'undefined',
      arrayFromAsync: 'undefined',
      promiseWithResolvers: 'undefined',
      SharedArrayBuffer: 'function',
    }])
  } finally { runtime.dispose() }
})

for (const constructor of ['ArrayBuffer', 'SharedArrayBuffer']) {
  test(`bounded native ${constructor} allocation respects guest memory limit`, async () => {
    const runtime = createRuntime({ limits: { memoryBytes: 4 * 1024 * 1024, wallTimeMs: 3000 } })
    try {
      const outcome = await runtime.run({
        cellId: 'native-allocation',
        source: `new ${constructor}(8 * 1024 * 1024);`,
        signal: new AbortController().signal,
        dispatch: async () => { throw new Error('No dispatch expected') },
      })
      expect(outcome.status).toBe('error')
      expect(outcome.error).toContain('out of memory')
    } finally { runtime.dispose() }
  })
}
