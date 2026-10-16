import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LidClosedMode } from './lidClosedMode.js'
import type { LidNativeSnapshot, LidNativeReply } from './lidClosedNative.js'
import type { LidWorkControl, LidWorkRun } from '../shared/lidClosed.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cat-lid-owner-'))
  const marker = join(directory, 'pending.json')
  const session = { id: randomUUID(), generation: randomUUID(), title: 'Build' }
  const original: LidWorkRun = { id: randomUUID(), startedAt: Date.now(), activeTurn: true, status: 'running', children: [] }
  let runs = [original]; let installed = false; let sequence = 0
  let installGate: ReturnType<typeof deferred> | undefined
  let startGate: ReturnType<typeof deferred> | undefined
  let failRestore = false
  let helperUnavailable = false
  let failInstall = false
  let setupOnly = false
  let partialInstallFailure = false
  let snapshot: LidNativeSnapshot = { record: { phase: 'off', began: 0, deadline: 0, allowance: 0, needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
    safety: { sleepDisabled: false, lidClosed: false, onBattery: true, batteryPercent: 75, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
  const phases: string[] = []
  const calls: string[] = []; const controls: LidWorkControl[] = []
  const deps = {
    marker, sessions: () => [session], installed: () => installed,
    reopen: () => { calls.push('reopen') },
    hardware: async () => ({ qualified: true, evidence: 'fixture', model: 'fixture', osBuild: 'fixture', safety: snapshot.safety }),
    install: async () => {
      calls.push('install'); await installGate?.promise
      if (failInstall) throw new Error('Authorization cancelled')
      installed = true
      if (partialInstallFailure) {
        partialInstallFailure = false; failRestore = true
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'unresolved', identity: randomUUID(), needsRestore: true }, safety: { ...snapshot.safety, sleepDisabled: true } }
        throw new Error('Installation interrupted')
      }
    },
    native: { close() {}, async command(input: { op: string; identity?: string; allowance?: number }): Promise<LidNativeReply> {
      calls.push(input.op)
      if (helperUnavailable) throw new Error('Helper unavailable')
      if (input.op === 'start') {
        if (setupOnly) return { ok: false, error: 'authorized-copy-required', setupOnly: true, snapshot: structuredClone(snapshot) }
        expect(JSON.parse(readFileSync(marker, 'utf8')).pending).toBe(true)
        await startGate?.promise
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'active', identity: input.identity, began: 100, deadline: 100 + input.allowance!, allowance: input.allowance!, needsRestore: true }, safety: { ...snapshot.safety, sleepDisabled: true }, remainingSeconds: input.allowance! }
      }
      if (['stop','retry','sleep'].includes(input.op)) {
        if (failRestore) return { ok: false, snapshot: { ...snapshot, record: { ...snapshot.record, phase: 'unresolved' } } }
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: 'stopped' }, safety: { ...snapshot.safety, sleepDisabled: false } }
      }
      if (input.op === 'continue') snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'active', needsRestore: true }, safety: { ...snapshot.safety, sleepDisabled: true } }
      return { ok: true, snapshot: structuredClone(snapshot), ...(setupOnly ? { setupOnly: true } : {}) }
    } },
    changed(view: { phase: string }) { phases.push(view.phase) },
    send(_id: string, control: LidWorkControl) { controls.push(control); queueMicrotask(() => mode.receive(session.id, control.requestId, { generation: session.generation, sequence: ++sequence, available: true, runs })) },
  }
  let mode = new LidClosedMode(deps)
  return { get mode() { return mode }, marker, session, original, calls, controls, phases,
    setRuns(value: LidWorkRun[]) { runs = value },
    setupGate() { installGate = deferred(); return installGate },
    nativeStartGate() { startGate = deferred(); return startGate },
    failRestore(value: boolean) { failRestore = value },
    protectedCopyRequired() { installed = true; setupOnly = true },
    failAfterPublishingAuthority() { partialInstallFailure = true },
    interrupted(kind: 'journal' | 'signature') {
      installed = true
      if (kind === 'journal') snapshot = { ...snapshot, error: 'journal-unreadable' }
      else { helperUnavailable = true; failInstall = true }
    },
    thermalEnd() { snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: 'thermal', thermalRestart: true }, safety: { ...snapshot.safety, sleepDisabled: false, thermal: 'nominal' } } },
    opened() { snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'lid-open', needsRestore: false, reason: 'lid-open' }, safety: { ...snapshot.safety, sleepDisabled: false }, remainingSeconds: 731 } },
    async restart() { await mode.shutdown(); mode = new LidClosedMode(deps); await mode.initialize() },
    async cleanup() { failRestore = false; installGate?.resolve(); startGate?.resolve(); await mode.shutdown(); rmSync(directory, { recursive: true, force: true }) },
  }
}
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true) }

test('cancel during setup and native admission cannot activate a late result', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    const gate = f.setupGate(); const setup = f.mode.command({ action: 'setup' })
    await until(() => f.calls.includes('install'))
    const cancel = f.mode.command({ action: 'cancel' }); gate.resolve()
    await Promise.all([setup, cancel]); expect(f.calls).not.toContain('start'); expect(f.mode.read().phase).toBe('off')
    const native = f.nativeStartGate(); const start = f.mode.command({ action: 'start', minutes: 15 })
    await until(() => f.calls.includes('start'))
    const phaseStart = f.phases.length
    const stop = f.mode.command({ action: 'stop' }); native.resolve(); await Promise.all([start, stop])
    expect(f.phases.slice(phaseStart)).not.toContain('active')
    expect(f.calls).toContain('stop'); expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
    expect(f.mode.read().phase).not.toBe('active')
  } finally { await f.cleanup() }
})

test('original roots survive new turns and lid-open Continue retains the native deadline', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 30 }); await f.mode.command({ action: 'setup' })
    const later = { ...f.original, id: randomUUID() }
    f.setRuns([{ ...f.original, activeTurn: false, children: [{ id: 'build', label: 'Build', status: 'running' }] }, later])
    await until(() => f.mode.read().currentRuns[f.session.id] === later.id)
    expect(f.mode.read().included.map(run => run.id)).toEqual([f.original.id])
    expect(f.controls.filter(c => c.window?.active).every(c => !c.window!.roots.includes(later.id))).toBe(true)
    f.opened(); await until(() => f.mode.read().canContinue)
    const starts = f.calls.filter(call => call === 'start').length
    await f.mode.command({ action: 'continue' })
    expect(f.mode.read().phase).toBe('active'); expect(f.mode.read().remainingSeconds).toBe(731)
    expect(f.calls.filter(call => call === 'start')).toHaveLength(starts)
    f.setRuns([{ ...f.original, activeTurn: false, status: 'completed', children: [] }, later])
    await until(() => f.mode.read().phase === 'ended')
    expect(f.mode.read().reason).toBe('completed')
  } finally { await f.cleanup() }
})

test('failed restoration stays unresolved across restart and retry cannot activate work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 }); await f.mode.command({ action: 'setup' })
    f.failRestore(true); await f.mode.command({ action: 'stop' })
    expect(f.mode.read().phase).toBe('unresolved'); expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
    await f.restart(); expect(f.mode.read().phase).toBe('unresolved')
    const count = f.calls.filter(call => call === 'start').length
    await f.mode.command({ action: 'start', minutes: 120 }); expect(f.calls.filter(call => call === 'start')).toHaveLength(count)
    f.failRestore(false); await f.mode.command({ action: 'retry' })
    expect(f.mode.read().phase).toBe('ended'); expect(f.mode.read().canContinue).toBe(false)
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
    expect(f.calls.filter(call => call === 'start')).toHaveLength(count)
  } finally { await f.cleanup() }
})

test('a cooled thermal ending still withdraws admission and idle assertions', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 }); await f.mode.command({ action: 'setup' })
    f.thermalEnd(); await until(() => f.mode.read().phase === 'ended')
    await until(() => f.controls.some(control => control.window?.block === true))
    const window = f.controls.at(-1)!.window!
    expect(window.active).toBe(false); expect(window.block).toBe(true); expect(window.suppressIdleSleep).toBe(true)
    expect(f.mode.read().canContinue).toBe(false)
  } finally { await f.cleanup() }
})

test('unreadable installed authority stays red without a local marker, including failed repair', async () => {
  for (const kind of ['journal', 'signature'] as const) {
    const f = fixture()
    try {
      f.interrupted(kind)
      await f.mode.initialize()
      expect(f.mode.read().phase).toBe('unresolved')
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
      const start = f.phases.length
      await f.mode.command({ action: 'retry' })
      expect(new Set(f.phases.slice(start))).toEqual(new Set(['unresolved']))
      expect(f.mode.read().recovering).toBe(false)
      await f.mode.command({ action: 'dismiss' })
      expect(f.mode.read().phase).toBe('unresolved')
      expect(f.calls).not.toContain('start')
    } finally { await f.cleanup() }
  }
})

test('setup requires the protected copy and reopening waits for all current work', async () => {
  const f = fixture()
  try {
    f.protectedCopyRequired()
    await f.mode.initialize()
    expect(f.mode.read().relaunchRequired).toBe(true)
    expect(f.mode.read().phase).toBe('unavailable')
    await f.mode.command({ action: 'reopen' })
    expect(f.calls).not.toContain('reopen')
    await f.mode.command({ action: 'start', minutes: 15 })
    expect(f.calls).not.toContain('start')
    await f.mode.command({ action: 'dismiss' })
    expect(f.mode.read().phase).toBe('off')
    await f.mode.command({ action: 'start', minutes: 15 })
    expect(f.mode.read().phase).toBe('unavailable')
    expect(f.calls).not.toContain('start')
    f.setRuns([{ ...f.original, activeTurn: false, status: 'completed' }])
    await f.mode.command({ action: 'reopen' })
    expect(f.calls.filter(call => call === 'reopen')).toHaveLength(1)
  } finally { await f.cleanup() }
})

test('a partially installed helper cannot make unresolved sleep a dismissible setup error', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start', minutes: 15 })
    f.failAfterPublishingAuthority()
    await f.mode.command({ action: 'setup' })
    expect(f.mode.read().phase).toBe('unresolved')
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
    await f.mode.command({ action: 'dismiss' })
    expect(f.mode.read().phase).toBe('unresolved')
    expect(f.calls).not.toContain('start')
    f.failRestore(false)
    await f.mode.command({ action: 'retry' })
    expect(f.mode.read().phase).toBe('ended')
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
  } finally { await f.cleanup() }
})
