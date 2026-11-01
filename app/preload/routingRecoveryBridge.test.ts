import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { TurnRetryResult } from '../shared/notificationNavigation.js'

const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')
function sender(name: string, channel: string, guard: () => void, invoke: (...args: unknown[]) => unknown) {
  const start = source.indexOf(`  ${name}(`)
  const end = source.indexOf('\n  },', start)
  if (start < 0 || end < 0) throw new Error(`Missing sender ${name}`)
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const method = {${source.slice(start, end + 4)}};`)
  return new Function('sendGuard', 'ipcRenderer', channel, `${code}; return method.${name}`)(
    { assertAllowed: guard }, { invoke }, channel,
  ) as (...args: unknown[]) => Promise<unknown>
}

test('retry guard refusal never invokes IPC and returns a definite local refusal', async () => {
  let invoked = false
  const retry = sender('retryTurn', 'CH_RETRY_TURN', () => { throw new Error('Rate limited') }, () => { invoked = true })
  expect(await retry('session', 'result')).toEqual({ status: 'refused', reason: 'local_refusal' })
  expect(invoked).toBe(false)
})

test('retry IPC rejection and synchronous invocation failure remain outcome unknown', async () => {
  for (const invoke of [() => Promise.reject(new Error('private path')), () => { throw new Error('private path') }]) {
    const retry = sender('retryTurn', 'CH_RETRY_TURN', () => {}, invoke)
    expect(await retry('session', 'result')).toEqual({ status: 'unknown' })
  }
})

test('retry forwards stable identity and preserves typed main admission/refusal/unknown', async () => {
  const results: TurnRetryResult[] = [{ status: 'admitted' }, { status: 'refused', reason: 'stale' }, { status: 'unknown' }]
  for (const result of results) {
    const retry = sender('retryTurn', 'CH_RETRY_TURN', () => {}, async (...args) => {
      expect(args).toEqual(['CH_RETRY_TURN', { sessionId: 'session', resultId: 'result' }])
      return result
    })
    expect(await retry('session', 'result')).toEqual(result)
  }
})

test.each([
  ['readRoutingStorageHealth', 'CH_HOST_ROUTING_STORAGE_HEALTH'],
  ['inspectRoutingStorage', 'CH_HOST_INSPECT_ROUTING_STORAGE'],
  ['revalidateRoutingStorage', 'CH_HOST_REVALIDATE_ROUTING_STORAGE'],
])('%s is guarded and invokes only its fixed no-payload channel', async (name, channel) => {
  let guarded = false
  const call = sender(name!, channel!, () => { guarded = true }, async (...args) => {
    expect(guarded).toBe(true)
    expect(args).toEqual([channel])
    return { status: 'blocked', code: 'routing_storage_unreadable' }
  })
  expect(await call()).toEqual({ status: 'blocked', code: 'routing_storage_unreadable' })
})
