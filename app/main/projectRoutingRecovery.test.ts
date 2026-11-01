import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRoutingController, type ProjectRoutingControllerOptions } from './projectRoutingController.js'
import { FileProjectRoutingStore, type RouteRecord } from './projectRoutingStore.js'

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
function saved(phase: RouteRecord['phase'] = 'checking', outcome: RouteRecord['outcome'] = 'unsent'): RouteRecord {
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

test('global initial health is blocked even with zero snapshots; repeated failed checks preserve bytes', async () => isolated(async path => {
  const bytes = '{broken\n exact bytes'
  writeFileSync(path, bytes)
  const health: unknown[] = []
  let recovered = 0
  const state = setup(path, { publishStorageHealth: value => health.push(value), onStorageRecovered: () => { recovered++ } })
  expect(state.controller.snapshots()).toEqual([])
  expect(health).toEqual([{ status: 'blocked', code: 'routing_storage_unreadable' }])
  for (let i = 0; i < 2; i++) {
    expect(state.controller.revalidateStorage().status).toBe('blocked')
    expect(state.controller.acceptsNewSubmit('unrelated', 'new')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  }
  expect(recovered).toBe(0)
  expect(state.sent).toEqual([])
}))

test('explicit repair restores unknown receipts and accepted dedupe without writing or replaying', async () => isolated(async path => {
  writeFileSync(path, '{broken')
  const health: unknown[] = []
  const snapshots: unknown[] = []
  let retained = true
  const state = setup(path, {
    onStorageRecovered: () => { retained = false },
    publishStorageHealth: value => { if (value.status === 'healthy') expect(retained).toBe(false); health.push(value) },
    publish: (_id, snapshot) => snapshots.push(snapshot),
  })
  const acceptedSession = 'another-session'
  state.store.save([saved('recovery', 'unknown'), { ...saved('unsent', 'accepted'), sessionId: acceptedSession }])
  const repairedBytes = readFileSync(path, 'utf8')
  expect(state.controller.storageHealth().status).toBe('blocked')
  expect(state.controller.revalidateStorage()).toEqual({ status: 'healthy', code: null })
  expect(state.controller.snapshots()[0]?.phase).toBe('uncertain')
  expect(snapshots).toHaveLength(1)
  expect(state.controller.acceptsNewSubmit(session, 'new')).toBe(false)
  expect(state.controller.acceptsNewSubmit(acceptedSession, id)).toBe(false)
  expect(state.controller.acceptsNewSubmit('unrelated', 'new')).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe(repairedBytes)
  expect(state.sent).toEqual([])
  state.controller.revalidateStorage()
  expect(readFileSync(path, 'utf8')).toBe(repairedBytes)
  expect(health).toHaveLength(2)
}))

test('permission refusal and failed main reconciliation remain globally blocked', async () => isolated(async path => {
  let denied = true
  let mainFailure = true
  const file = new FileProjectRoutingStore(path)
  file.save([saved()])
  const state = setup(path, {
    store: { load() { if (denied) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }); return file.load() }, save() { throw new Error('Must not write') } },
    onStorageRecovered() { if (mainFailure) throw new Error('Retention not reconciled') },
  })
  expect(state.controller.storageHealth().status).toBe('blocked')
  expect(state.controller.revalidateStorage().status).toBe('blocked')
  denied = false
  expect(state.controller.revalidateStorage().status).toBe('blocked')
  expect(state.controller.snapshots()).toEqual([])
  mainFailure = false
  expect(state.controller.revalidateStorage().status).toBe('healthy')
  expect(state.controller.snapshots()[0]?.phase).toBe('unsent')
  expect(state.sent).toEqual([])
}))

test.skipIf(process.getuid?.() === 0)('permission-denied file remains blocked until explicit revalidation after permissions are repaired', async () => isolated(async path => {
  const store = new FileProjectRoutingStore(path)
  store.save([saved('recovery', 'unknown')])
  const bytes = readFileSync(path, 'utf8')
  chmodSync(path, 0o000)
  try {
    const state = setup(path)
    expect(state.controller.storageHealth().status).toBe('blocked')
    expect(state.controller.revalidateStorage().status).toBe('blocked')
    expect(state.controller.acceptsNewSubmit('unrelated', 'new')).toBe(false)
    chmodSync(path, 0o600)
    expect(state.controller.storageHealth().status).toBe('blocked')
    expect(state.controller.revalidateStorage().status).toBe('healthy')
    expect(state.controller.snapshots()[0]?.phase).toBe('uncertain')
    expect(state.sent).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  } finally { chmodSync(path, 0o600) }
}))

test('removing an unreadable journal is not a validated repair', async () => isolated(async path => {
  writeFileSync(path, '{broken')
  const state = setup(path)
  rmSync(path)
  expect(state.controller.revalidateStorage().status).toBe('blocked')
  expect(state.controller.acceptsNewSubmit(session, id)).toBe(false)
}))

test('main startup retention is visible even if the file becomes readable before controller construction', async () => isolated(async path => {
  const store = new FileProjectRoutingStore(path)
  store.save([])
  let retained = true
  const state = setup(path, {
    initialStorageFailure: retained,
    onStorageRecovered: () => { retained = false },
  })
  expect(state.controller.storageHealth().status).toBe('blocked')
  expect(state.controller.acceptsNewSubmit(session, id)).toBe(false)
  expect(state.controller.revalidateStorage().status).toBe('healthy')
  expect(retained).toBe(false)
  expect(state.controller.acceptsNewSubmit(session, id)).toBe(true)
}))

test.each([null, { version: 1, records: [{ ...saved(), decision: {} }] }, { version: 1, records: [saved(), saved()] }])(
  'invalid recovery documents remain preserved and blocked: %j', async document => isolated(async path => {
    const bytes = JSON.stringify(document)
    writeFileSync(path, bytes)
    const state = setup(path)
    expect(state.controller.revalidateStorage().status).toBe('blocked')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  }),
)


test('recovery preserves input and refuses changed context until the original or saved target folder is restored', async () => isolated(async path => {
  new FileProjectRoutingStore(path).save([saved()])
  let cwd = '/other-project'
  const state = setup(path, { currentCwd: () => cwd })
  await state.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  expect(state.sent).toEqual([])
  expect(state.controller.snapshots()[0]).toMatchObject({ phase: 'failed', message: 'Project folder changed before sending.' })
  expect(state.store.load()[0]?.message).toEqual(payload)
  cwd = '/project'
  await state.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  expect(state.sent).toEqual([payload])
  state.controller.onSubmitResult(session, id, true)
}))
