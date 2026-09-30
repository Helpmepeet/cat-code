import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRoutingController, type ProjectRoutingControllerOptions } from './projectRoutingController.js'
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

function setup(path: string, overrides: Partial<ProjectRoutingControllerOptions> = {}) {
  const sent: unknown[] = []
  const store = new FileProjectRoutingStore(path)
  const controller = new ProjectRoutingController({ store,
    eligible: () => true, currentCwd: () => '/chat',
    classify: async () => ({ kind: 'stay' }),
    move: async () => ({ ok: true }),
    forward: (_session, message) => { sent.push(message); return null },
    answerRefused: () => {}, publish: () => {}, log: () => {}, ...overrides,
  })
  return { controller, sent, store }
}

test.each(['checking', 'ask', 'moving'] as const)('restart while %s recovers the full unsent payload without sending it', async phase => isolated(async path => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const state = setup(path, {
    classify: async () => {
      if (phase === 'checking') await held
      return { kind: phase === 'ask' ? 'ask' : 'auto', cwd: '/project', name: 'project', explicit: true }
    },
    move: async () => { await held; return { ok: false, error: { message: 'Interrupted' } } },
  })
  const running = state.controller.submit(session, payload, 'Fix alpha')
  while (state.controller.snapshots()[0]?.phase !== phase) await Bun.sleep(1)
  const recovered = setup(path)
  expect(recovered.controller.snapshots()[0]?.phase).toBe('unsent')
  expect(recovered.sent).toEqual([])
  expect(recovered.store.load()[0]?.message).toEqual(payload)
  await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  expect(recovered.sent).toEqual([payload])
  recovered.controller.onSubmitResult(session, id, true)
  release()
  await running
}))

test('restart across transport handoff is unknown until an explicit resend or dismissal', async () => isolated(async path => {
  const initial = setup(path)
  await initial.controller.submit(session, payload, 'Fix alpha')
  expect(initial.store.load()[0]?.outcome).toBe('unknown')
  const recovered = setup(path)
  expect(recovered.controller.snapshots()[0]?.phase).toBe('uncertain')
  await recovered.controller.submit(session, payload, 'Fix alpha')
  expect(recovered.sent).toEqual([])
  recovered.controller.cancel(session)
  expect(setup(path).controller.hasPending(session)).toBe(false)
}))

test('accepted receipt survives restart and duplicate delivery is suppressed', async () => isolated(async path => {
  const initial = setup(path)
  await initial.controller.submit(session, payload, 'Fix alpha')
  initial.controller.onSubmitResult(session, id, true)
  const recovered = setup(path)
  await recovered.controller.submit(session, payload, 'Fix alpha')
  expect(recovered.sent).toEqual([])
  expect(recovered.controller.hasPending(session)).toBe(false)
  expect(recovered.store.load()[0]?.outcome).toBe('accepted')
}))

test.each(['transport refusal', 'sidecar refusal', 'readiness failure'])('%s preserves a certainly unsent payload', async mode => isolated(async path => {
  const initial = setup(path, {
    ...(mode === 'transport refusal' ? { forward: () => 'session_not_found' as const } : {}),
    ...(mode === 'readiness failure' ? { prepareForward: async () => { throw new Error('Cannot wake') } } : {}),
  })
  await initial.controller.submit(session, payload, 'Fix alpha')
  if (mode === 'sidecar refusal') initial.controller.onSubmitResult(session, id, false)
  expect(initial.store.load()[0]?.outcome).toBe('unsent')
  const recovered = setup(path)
  expect(recovered.controller.snapshots()[0]?.phase).toBe('unsent')
  await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  expect(recovered.sent).toEqual([payload])
}))

test('a lost sidecar after handoff exposes uncertainty and cannot automatically resend', async () => isolated(async path => {
  const state = setup(path)
  await state.controller.submit(session, payload, 'Fix alpha')
  state.controller.interrupted(session)
  expect(state.controller.snapshots()[0]?.phase).toBe('uncertain')
  expect(state.sent).toHaveLength(1)
  await state.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  expect(state.sent).toEqual([payload, payload])
}))

test('double recovery clicks cannot send twice while readiness is pending', async () => isolated(async path => {
  let release!: () => void
  const initial = setup(path)
  await initial.controller.submit(session, payload, 'Fix alpha')
  const recovered = setup(path, { prepareForward: () => new Promise<void>(resolve => { release = resolve }) })
  const first = recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  await recovered.controller.resolve({ appSessionId: session, submitId: id, choice: 'resend' })
  release()
  await first
  expect(recovered.sent).toEqual([payload])
}))

test('an unreadable journal blocks submits without overwriting recoverable bytes', async () => isolated(async path => {
  writeFileSync(path, '{broken')
  const state = setup(path)
  await state.controller.submit(session, payload, 'Fix alpha')
  expect(state.sent).toEqual([])
  expect(() => state.store.load()).toThrow()
}))

test.each(['moving', 'handoff'])('journal failure before %s prevents the side effect and keeps recoverable input', async boundary => isolated(async path => {
  const disk = new FileProjectRoutingStore(path)
  let moves = 0
  const state = setup(path, {
    store: { load: () => disk.load(), save: records => {
      if (records.some(row => boundary === 'moving' ? row.phase === 'moving' : row.outcome === 'unknown')) throw new Error('Disk unavailable')
      disk.save(records)
    } },
    classify: async () => boundary === 'moving'
      ? { kind: 'auto', cwd: '/project', name: 'project', explicit: true }
      : { kind: 'stay' },
    move: async () => { moves++; return { ok: true } },
  })
  await state.controller.submit(session, payload, 'Fix alpha')
  expect(moves).toBe(0)
  expect(state.sent).toEqual([])
  expect(disk.load()[0]?.outcome).toBe('unsent')
  expect(disk.load()[0]?.message).toEqual(payload)
}))
