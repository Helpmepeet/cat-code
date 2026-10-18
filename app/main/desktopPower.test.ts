import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { SleepAssertionOwner } from '../shared/sleepAssertion.js'
import { DesktopPower } from './desktopPower.js'
import { unknownPowerObservation } from './powerObservation.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import { buildDiagnosticsBundle } from './diagnosticsBundle.js'

function harness() {
  const children: Array<EventEmitter & { kills: number }> = []
  const assertion = new SleepAssertionOwner({ enabled: true, setTimeout, clearTimeout, log() {},
    spawn() {
      const child = Object.assign(new EventEmitter(), { kills: 0, unref() {}, kill() { this.kills++; return true } })
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child as unknown as ChildProcess
    } })
  const observations: boolean[] = []
  const power = new DesktopPower(assertion, { setActive: active => { observations.push(active) },
    read: () => ({ status: 'inactive', observation: unknownPowerObservation(), observedAt: null, failures: 0 }) })
  const receive = (id: string, value: object) => power.receive(id, { protocolVersion: PROTOCOL_VERSION, sessionId: id, ...value } as ServerFrame)
  const activity = (id: string, presence: string) => receive(id, { kind: 'activity', presence })
  return { power, children, observations, receive, activity }
}

test('desktop shares one idle assertion and observer across foreground and background work', async () => {
  const h = harness()
  try {
    h.activity('a', 'running'); h.activity('b', 'running')
    await Promise.resolve()
    expect(h.children).toHaveLength(1)
    expect(h.power.read().assertion).toMatchObject({ references: 1, active: 1 })
    h.activity('a', 'idle')
    h.receive('b', { kind: 'tasks.snapshot', tasks: { items: [{ id: 'child', type: 'local_agent', status: 'running' }] } })
    h.activity('b', 'idle')
    expect(h.power.read().sessions).toBe(1)
    expect(h.children[0]!.kills).toBe(0)
    h.receive('b', { kind: 'tasks.snapshot', tasks: { items: [] } })
    expect(h.children[0]!.kills).toBe(1)
    expect(h.observations).toEqual([true, false])
  } finally { h.power.dispose(); for (const child of h.children) child.emit('exit') }
})

test('transport loss retains protection, while real exits and host closes release it', async () => {
  const h = harness()
  try {
    h.activity('a', 'running'); await Promise.resolve()
    h.receive('a', { kind: 'lifecycle', status: 'disconnected' })
    expect(h.power.read().assertion.desired).toBe(true)
    h.receive('a', { kind: 'ready', payload: { activeTurn: true, pendingPermissionRequests: [] } })
    expect(h.children).toHaveLength(1)
    h.receive('a', { kind: 'lifecycle', status: 'exited' })
    expect(h.power.read().assertion.desired).toBe(false)
    h.children[0]!.emit('exit')
    h.activity('b', 'running'); await Promise.resolve()
    h.power.receiveHostEvent({ type: 'session-removed', appSessionId: 'b' })
    expect(h.power.read().assertion.desired).toBe(false)
  } finally { h.power.dispose(); for (const child of h.children) child.emit('exit') }
})

test('replayed turn events and noncomputing retained tasks do not keep awake', () => {
  const h = harness()
  try {
    h.receive('a', { kind: 'event', replay: true, event: { type: 'turn.status', activeTurn: true } })
    h.receive('a', { kind: 'tasks.snapshot', tasks: { items: [
      { status: 'running', isIdle: true }, { status: 'running', handoffStatus: 'blocked' },
      { status: 'running', awaitingPlanApproval: true }, { status: 'completed' }, { status: 'running', kind: 'monitor' },
      { status: 'running', type: 'monitor_mcp' },
    ] } })
    h.activity('a', 'needs_user')
    expect(h.children).toHaveLength(0)
    h.receive('a', { kind: 'tasks.snapshot', tasks: { hasForegroundTask: true, items: [] } })
    expect(h.children).toHaveLength(0)
    h.receive('a', { kind: 'tasks.snapshot', tasks: { hasOperationalWork: true, items: [] } })
    expect(h.children).toHaveLength(1)
  } finally { h.power.dispose(); for (const child of h.children) child.emit('exit') }
})

test('a shutdown request is not proof that background computation has stopped', async () => {
  const h = harness()
  try {
    h.receive('a', { kind: 'tasks.snapshot', tasks: { items: [{ status: 'running', shutdownRequested: true }] } })
    await Promise.resolve()
    expect(h.power.read().assertion.desired).toBe(true)
    h.receive('a', { kind: 'tasks.snapshot', tasks: { items: [{ status: 'completed', shutdownRequested: true }] } })
    expect(h.power.read().assertion.desired).toBe(false)
  } finally { h.power.dispose(); for (const child of h.children) child.emit('exit') }
})

test('runtime teardown rejects late callbacks from old supervisor generations', async () => {
  const h = harness()
  h.activity('a', 'running'); await Promise.resolve()
  h.power.dispose()
  h.receive('b', { kind: 'event', event: { type: 'turn.status', activeTurn: true } })
  h.children[0]!.emit('exit')
  expect(h.power.read().assertion.desired).toBe(false)
  expect(h.power.read().sessions).toBe(0)
  expect(h.children).toHaveLength(1)
})

test('engine work truth outranks UI capability and coarse turn/activity frames', () => {
  const h = harness()
  try {
    h.receive('a', { kind: 'tasks.snapshot', tasks: {
      hasOperationalWork: false, hasForegroundTask: true, items: [{ status: 'running' }],
    } })
    h.activity('a', 'running')
    h.receive('a', { kind: 'event', event: { type: 'turn.status', activeTurn: true } })
    expect(h.power.read().assertion.desired).toBe(false)
    expect(h.power.read().sessions).toBe(0)
    h.receive('a', { kind: 'tasks.snapshot', tasks: { hasOperationalWork: true, items: [] } })
    h.activity('a', 'needs_user')
    h.receive('a', { kind: 'event', event: { type: 'turn.status', activeTurn: false } })
    expect(h.power.read().assertion.desired).toBe(true)
    h.receive('a', { kind: 'tasks.snapshot', tasks: { hasOperationalWork: false, items: [] } })
    expect(h.power.read().assertion.desired).toBe(false)
  } finally { h.power.dispose(); for (const child of h.children) child.emit('exit') }
})

test('local diagnostics exports power state through a closed metadata projection', () => {
  const h = harness()
  try {
    const snapshot = h.power.read()
    const power = { ...snapshot, assertion: { ...snapshot.assertion } }
    Object.assign(power, { raw: 'private-payload' })
    Object.assign(power.assertion, { raw: 'private-payload' })
    const bundle = JSON.parse(buildDiagnosticsBundle({ logsDirectory: '/nonexistent-cat-power-test', appVersion: 'test',
      currentLaunchId: 'test', power: () => power }))
    expect(bundle.power.assertion).toMatchObject({ desired: false, active: 0, health: 'idle' })
    expect(bundle.power.hardware.observation).toEqual(unknownPowerObservation())
    expect(bundle.power.limitations).toMatchObject({ physicalBacklightPower: 'unavailable',
      closedLidCoolingAndHeatTransfer: 'requires-physical-testing', lidCloseSleepOverride: false })
    expect(JSON.stringify(bundle)).not.toContain('private-payload')
  } finally { h.power.dispose() }
})
