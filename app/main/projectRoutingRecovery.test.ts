import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRoutingController, type ProjectRoutingControllerOptions, type PendingRoute } from './projectRoutingController.js'
import { FileProjectRoutingStore } from './projectRoutingStore.js'

const session = '93ad8a93-bc68-4954-8c3e-92115798fcce'
const id = '5b48eb57-5dc5-45ed-af3a-248863d962f2'
const payload = { type: 'app.submit' as const, requestId: 'original-request', options: { submitId: id, isMeta: true, goalSnapshot: { goal: 'test' } }, prompt: [
  { type: 'text' as const, text: 'Fix alpha' },
  { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' } },
] }
async function isolated(run: (path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'catcode-routing-journal-'))
  try { await run(join(root, 'journal.json')) } finally { rmSync(root, { recursive: true, force: true }) }
}
function saved(phase: PendingRoute['phase'] = 'checking', outcome: PendingRoute['outcome'] = 'unsent'): PendingRoute {
  return { sessionId: session, submitId: id, message: payload, routingText: 'Fix alpha', sourceCwd: '/chat', phase,
    decision: { kind: 'auto', cwd: '/project', name: 'project', explicit: true }, messageText: null, outcome }
}
function setup(path: string, overrides: Partial<ProjectRoutingControllerOptions> = {}) {
  const sent: unknown[] = []
  const store = new FileProjectRoutingStore(path)
  const controller = new ProjectRoutingController({ store, currentCwd: () => '/chat',
    forward: (_session, message) => { sent.push(message); return null }, answerRefused: () => {}, publish: () => {}, log: () => {}, ...overrides })
  return { controller, sent, store }
}

test.each(['checking', 'ask', 'moving'] as const)('legacy %s input recovers directly in the current valid context without moving', async phase => isolated(async path => {
  new FileProjectRoutingStore(path).save([saved(phase)])
  for (const cwd of ['/chat', '/project']) {
    const recovered = setup(path, { currentCwd: () => cwd })
    expect(recovered.controller.snapshots()[0]?.phase).toBe('unsent')
    expect(recovered.sent).toEqual([])
    expect(recovered.controller.acceptsNewSubmit(session, id)).toBe(false)
    await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
    expect(recovered.sent).toEqual([payload])
    recovered.controller.onSubmitResult(session, id, false)
  }
}))

test('unknown delivery requires explicit resend and receipt settles only the matching submit', async () => isolated(async path => {
  new FileProjectRoutingStore(path).save([saved('recovery', 'unknown')])
  const recovered = setup(path)
  expect(recovered.controller.snapshots()[0]?.phase).toBe('uncertain')
  expect(recovered.sent).toEqual([])
  await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  recovered.controller.onSubmitResult(session, 'other', true)
  expect(recovered.controller.hasPending(session)).toBe(true)
  recovered.controller.onSubmitResult(session, id, true)
  const restarted = setup(path)
  expect(restarted.controller.hasPending(session)).toBe(false)
  expect(restarted.controller.acceptsNewSubmit(session, id)).toBe(false)
  expect(restarted.controller.acceptsNewSubmit(session, 'new')).toBe(true)
  expect(restarted.store.load()[0]?.outcome).toBe('accepted')
}))

test.each(['transport', 'sidecar', 'readiness', 'journal'])('%s refusal preserves complete certainly-unsent input', async mode => isolated(async path => {
  const store = new FileProjectRoutingStore(path)
  store.save([saved()])
  const state = setup(path, {
    ...(mode === 'transport' ? { forward: () => 'session_not_found' as const } : {}),
    ...(mode === 'readiness' ? { prepareForward: async () => { throw new Error('Cannot wake') } } : {}),
    ...(mode === 'journal' ? { store: { load: () => store.load(), save: records => { if (records.some(row => row.outcome === 'unknown')) throw new Error('Disk unavailable'); store.save(records) } } } : {}),
  })
  await state.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  if (mode === 'sidecar') state.controller.onSubmitResult(session, id, false)
  expect(store.load()[0]?.outcome).toBe('unsent')
  expect(store.load()[0]?.message).toEqual(payload)
  if (mode === 'readiness' || mode === 'journal') expect(state.sent).toEqual([])
}))

test('double recovery clicks cannot send twice while readiness is pending', async () => isolated(async path => {
  new FileProjectRoutingStore(path).save([saved()])
  let release!: () => void
  const recovered = setup(path, { prepareForward: () => new Promise<void>(resolve => { release = resolve }) })
  const first = recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  release(); await first
  expect(recovered.sent).toEqual([payload])
  recovered.controller.onSubmitResult(session, id, true)
}))

test('unreadable legacy journal retains rows and refuses new input without replacing bytes', async () => isolated(async path => {
  writeFileSync(path, '{broken')
  const state = setup(path)
  expect(state.controller.hasPending(session)).toBe(true)
  expect(state.controller.acceptsNewSubmit(session, id)).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe('{broken')
}))
