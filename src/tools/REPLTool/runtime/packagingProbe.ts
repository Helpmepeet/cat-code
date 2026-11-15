// Included as a second entrypoint by the isolated compiled-runtime qualification test.
import { createRuntime } from './index'
const runtime = createRuntime()
try {
  const outcome = await runtime.run({
    cellId: 'offline', source: 'const x = await Promise.resolve(42); output(x);',
    signal: new AbortController().signal,
    dispatch: async () => null,
    onOutput: output => { if (output.value !== 42) throw new Error('Bad guest result') },
  })
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome))
  console.log('offline-runtime-ok')
} finally { runtime.dispose() }
