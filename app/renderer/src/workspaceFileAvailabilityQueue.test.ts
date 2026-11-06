import { afterEach, expect, test } from 'bun:test'
import {
  disposeWorkspaceFileAvailability,
  peekWorkspaceFileAvailability,
  recordWorkspaceFileWrite,
  requestWorkspaceFileAvailability,
} from './workspaceFileAvailabilityQueue.js'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const sessions: string[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) disposeWorkspaceFileAvailability(session)
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})
function host(check: (sessionId: string, path: string) => Promise<'available' | 'missing' | 'busy'>): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { catcode: { checkWorkspaceFileAvailability: check } } })
}
async function settle(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('shared consumers deduplicate paths and admit at most four host reads', async () => {
  const session = 'availability-budget'; sessions.push(session)
  const released: Array<() => void> = []
  let running = 0
  let maxRunning = 0
  let calls = 0
  host(async () => {
    calls++; running++; maxRunning = Math.max(running, maxRunning)
    await new Promise<void>(resolve => released.push(resolve))
    running--
    return 'available'
  })
  const requests = Array.from({ length: 8 }, (_, index) => requestWorkspaceFileAvailability(session, `/repo/${index}.md`))
  const duplicate = requestWorkspaceFileAvailability(session, '/repo/0.md')
  await settle()
  expect(calls).toBe(4)
  expect(duplicate).toBe(requests[0]!)
  while (released.length) { released.shift()!(); await settle() }
  expect(await Promise.all(requests)).toEqual(Array(8).fill(true))
  expect(await duplicate).toBe(true)
  expect(maxRunning).toBe(4)
  expect(calls).toBe(8)
})

test('busy and failures never become a negative cache, while writes invalidate missing and stale reads', async () => {
  const session = 'availability-invalidation'; sessions.push(session)
  let answer: 'busy' | 'missing' | 'available' = 'busy'
  let calls = 0
  host(async () => { calls++; return answer })
  expect(await requestWorkspaceFileAvailability(session, '/repo/new.ts')).toBeNull()
  expect(peekWorkspaceFileAvailability(session, '/repo/new.ts')).toBeUndefined()
  answer = 'missing'
  expect(await requestWorkspaceFileAvailability(session, '/repo/new.ts')).toBe(false)
  expect(await requestWorkspaceFileAvailability(session, '/repo/new.ts')).toBe(false)
  expect(calls).toBe(2)
  recordWorkspaceFileWrite(session, '/repo/new.ts', 'write-1:success')
  answer = 'available'
  expect(await requestWorkspaceFileAvailability(session, '/repo/new.ts')).toBe(true)
  expect(calls).toBe(3)

  let complete!: () => void
  host(async () => { await new Promise<void>(resolve => { complete = resolve }); return 'missing' })
  const pending = requestWorkspaceFileAvailability(session, '/repo/race.ts')
  await settle()
  recordWorkspaceFileWrite(session, '/repo/race.ts', 'write-2:success')
  complete()
  expect(await pending).toBeNull()
  expect(peekWorkspaceFileAvailability(session, '/repo/race.ts')).toBeUndefined()
  host(async () => { throw new Error('Disconnected') })
  expect(await requestWorkspaceFileAvailability(session, '/repo/race.ts')).toBeNull()
  expect(peekWorkspaceFileAvailability(session, '/repo/race.ts')).toBeUndefined()
})
