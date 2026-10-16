import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LidClosedMode } from './lidClosedMode.js'
import { LidSetupCancelled, type LidNativeSnapshot, type LidNativeReply } from './lidClosedNative.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cat-lid-owner-'))
  const marker = join(directory, 'pending.json')
  let installed = false
  let installGate: ReturnType<typeof deferred> | undefined
  let startGate: ReturnType<typeof deferred> | undefined
  let failRestore = false
  let transitionPending = false
  let sleepResult: Partial<LidNativeSnapshot['record']> = {}
  let pulseGate: ReturnType<typeof deferred> | undefined
  let helperUnavailable = false
  let failInstall = false
  let cancelInstall = false
  let partialInstallFailure = false
  let snapshot: LidNativeSnapshot = { record: { phase: 'off', began: 0, deadline: 0, allowance: 0, needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
    safety: { sleepDisabled: false, lidClosed: false, onBattery: true, batteryPercent: 75, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
  const phases: string[] = []
  const calls: string[] = []
  const deps = {
    marker, installed: () => installed,
    hardware: async () => ({ qualified: true, evidence: 'fixture', model: 'fixture', osBuild: 'fixture', safety: snapshot.safety }),
    install: async () => {
      calls.push('install'); await installGate?.promise
      if (failInstall) throw new Error('Authorization cancelled')
      if (cancelInstall) throw new LidSetupCancelled('Administrator setup was cancelled.')
      installed = true
      if (partialInstallFailure) {
        partialInstallFailure = false; failRestore = true
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'unresolved', identity: randomUUID(), needsRestore: true }, safety: { ...snapshot.safety, sleepDisabled: true } }
        throw new Error('Installation interrupted')
      }
    },
    native: { close() {}, async command(input: { op: string; identity?: string; allowance?: number }): Promise<LidNativeReply> {
      calls.push(input.op)
      if (input.op === 'pulse') await pulseGate?.promise
      if (helperUnavailable) throw new Error('Helper unavailable')
      if (input.op === 'start') {
        expect(JSON.parse(readFileSync(marker, 'utf8')).pending).toBe(true)
        await startGate?.promise
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'active', identity: input.identity, began: 100, deadline: 100 + input.allowance!, allowance: input.allowance!, needsRestore: true, sleepRequested: false, sleepRequestAttempted: false, sleepRequestSucceeded: undefined }, safety: { ...snapshot.safety, sleepDisabled: true }, remainingSeconds: input.allowance! }
      }
      if (['stop','retry','sleep'].includes(input.op)) {
        if (transitionPending) return { ok: false, error: 'transition-pending', snapshot: structuredClone(snapshot) }
        if (failRestore) return { ok: false, snapshot: { ...snapshot, record: { ...snapshot.record, phase: 'unresolved' } } }
        const sleepRequested = input.op === 'sleep' || snapshot.record.sleepRequested
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: input.op === 'sleep' ? 'sleep-requested' : 'stopped',
          sleepRequested, sleepRequestAttempted: sleepRequested, sleepRequestSucceeded: sleepRequested ? true : undefined,
          ...(sleepRequested ? sleepResult : {}) }, safety: { ...snapshot.safety, sleepDisabled: false } }
      }
      return { ok: true, snapshot: structuredClone(snapshot) }
    } },
    changed(view: { phase: string }) { phases.push(view.phase) },

  }
  let mode = new LidClosedMode(deps)
  return { get mode() { return mode }, marker, calls, phases,
    setupGate() { installGate = deferred(); return installGate },
    nativeStartGate() { startGate = deferred(); return startGate },
    failRestore(value: boolean) { failRestore = value },
    transitionPending(value: boolean) { transitionPending = value },
    sleepResult(record: Partial<LidNativeSnapshot['record']>) { sleepResult = record },
    watchdogRestored(record: Partial<LidNativeSnapshot['record']>) {
      snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: 'supervision-lost', ...record },
        safety: { ...snapshot.safety, sleepDisabled: false } }
    },
    nativePulseGate() { pulseGate = deferred(); return pulseGate },
    failAfterPublishingAuthority() { partialInstallFailure = true },
    cancelAdministratorDialog() { cancelInstall = true },
    battery(batteryPercent: number) { snapshot = { ...snapshot, safety: { ...snapshot.safety, batteryPercent } } },
    leftoverNote(sleepDisabled: boolean) { writeFileSync(marker, JSON.stringify({ pending: true }) + '\n'); snapshot = { ...snapshot, safety: { ...snapshot.safety, sleepDisabled } } },
    interrupted(kind: 'journal' | 'signature') {
      installed = true
      if (kind === 'journal') snapshot = { ...snapshot, error: 'journal-unreadable' }
      else { helperUnavailable = true; failInstall = true }
    },
    thermalEnd() { snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: 'thermal', thermalRestart: true }, safety: { ...snapshot.safety, sleepDisabled: false, thermal: 'nominal' } } },
    async restart() { await mode.shutdown(); mode = new LidClosedMode(deps); await mode.initialize() },
    async cleanup() { failRestore = false; transitionPending = false; pulseGate?.resolve(); installGate?.resolve(); startGate?.resolve(); await mode.shutdown(); rmSync(directory, { recursive: true, force: true }) },
  }
}
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true) }

test('manual mode starts without any running Cat Code work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start', minutes: 15 })
    expect(f.calls.slice(0, 2)).toEqual(['install', 'start'])
    expect(f.mode.read().phase).toBe('active')
    await until(() => f.calls.includes('pulse'))
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('a start refused for low battery can start again once charged', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.battery(20)
    await f.mode.command({ action: 'start', minutes: 15 })
    expect(f.mode.read()).toMatchObject({ phase: 'unavailable', error: 'Charge above 20% before starting.' })
    f.battery(80)
    await f.mode.command({ action: 'start', minutes: 15 })
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('cancel during setup and native admission cannot activate a late result', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    const gate = f.setupGate(); const setup = f.mode.command({ action: 'start', minutes: 15 })
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

test('failed restoration stays unresolved across restart and retry cannot activate work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    f.failRestore(true); await f.mode.command({ action: 'stop' })
    expect(f.mode.read().phase).toBe('unresolved'); expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
    await f.restart(); expect(f.mode.read().phase).toBe('unresolved')
    const count = f.calls.filter(call => call === 'start').length
    await f.mode.command({ action: 'start', minutes: 120 }); expect(f.calls.filter(call => call === 'start')).toHaveLength(count)
    f.failRestore(false); await f.mode.command({ action: 'retry' })
    expect(f.mode.read().phase).toBe('ended'); expect(f.calls).not.toContain('continue')
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
    expect(f.calls.filter(call => call === 'start')).toHaveLength(count)
  } finally { await f.cleanup() }
})

for (const action of ['stop', 'sleep'] as const) {
  test(`${action} intent survives failed active replies and status until explicit recovery`, async () => {
    const f = fixture()
    try {
      await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
      f.transitionPending(true)
      const from = f.phases.length
      await f.mode.command({ action })
      expect(f.mode.read()).toMatchObject({
        phase: 'unresolved', reason: action === 'sleep' ? 'sleep-requested' : 'stopped',
        sleepRequested: action === 'sleep', error: 'Normal sleep has not been restored. Retry recovery.',
      })
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
      await until(() => f.calls.includes('status'))
      expect(f.phases.slice(from)).not.toContain('active')
      expect(f.calls).not.toContain('pulse')
      await f.mode.command({ action: 'dismiss' })
      await f.mode.command({ action: 'start', minutes: 120 })
      expect(f.mode.read().phase).toBe('unresolved')
      expect(f.calls.filter(call => call === 'start')).toHaveLength(1)
      f.transitionPending(false)
      const recoveryFrom = f.calls.length
      await f.mode.command({ action: 'retry' })
      expect(f.calls.slice(recoveryFrom)).toEqual([action])
      expect(f.mode.read().phase).toBe('ended')
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
      await f.mode.command({ action: 'start', minutes: 15 })
      expect(f.mode.read().phase).toBe('active')
    } finally { await f.cleanup() }
  })
}

test('stop intent prevents an in-flight pulse reply from readmitting active work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    const gate = f.nativePulseGate()
    await until(() => f.calls.includes('pulse'))
    f.transitionPending(true)
    const from = f.phases.length
    const stop = f.mode.command({ action: 'stop' })
    gate.resolve(); await stop
    expect(f.phases.slice(from)).not.toContain('active')
    expect(f.mode.read().phase).toBe('unresolved')
    await until(() => f.calls.includes('status'))
    expect(f.calls.filter(call => call === 'pulse')).toHaveLength(1)
  } finally { await f.cleanup() }
})

for (const outcome of [
  { name: 'never admitted', sleepRequested: false, sleepRequestAttempted: false },
  { name: 'recorded but never attempted', sleepRequested: true, sleepRequestAttempted: false },
  { name: 'attempted without a receipt', sleepRequested: true, sleepRequestAttempted: true },
  { name: 'failed', sleepRequested: true, sleepRequestAttempted: true, sleepRequestSucceeded: false, error: 'sleep-request-failed' },
  { name: 'confirmed', sleepRequested: true, sleepRequestAttempted: true, sleepRequestSucceeded: true },
]) {
  test(`watchdog restoration preserves the ${outcome.name} Sleep outcome without sending another request`, async () => {
    const f = fixture()
    try {
      await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
      f.transitionPending(true)
      await f.mode.command({ action: 'sleep' })
      const { name: _name, ...record } = outcome
      f.watchdogRestored(record)
      await until(() => f.mode.read().phase === 'ended')
      expect(f.mode.read()).toMatchObject({
        reason: outcome.sleepRequestSucceeded === true ? 'sleep-requested' : 'sleep-unconfirmed',
        sleepRequested: outcome.sleepRequested,
      })
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
      expect(f.calls.filter(call => call === 'sleep')).toHaveLength(1)
      expect(f.calls).not.toContain('pulse')
      const settledCalls = f.calls.length
      await f.mode.command({ action: 'retry' })
      expect(f.calls).toHaveLength(settledCalls)
    } finally { await f.cleanup() }
  })
}

test('a direct Sleep failure does not overwrite its unconfirmed outcome after restoration', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    f.sleepResult({ sleepRequestSucceeded: false, error: 'sleep-request-failed' })
    await f.mode.command({ action: 'sleep' })
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'sleep-unconfirmed', error: 'sleep-request-failed' })
    expect(f.calls.filter(call => call === 'sleep')).toHaveLength(1)
    expect(f.calls).not.toContain('pulse')
  } finally { await f.cleanup() }
})

test('a confirmed direct Sleep request retains its native outcome', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    await f.mode.command({ action: 'sleep' })
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'sleep-requested', sleepRequested: true })
  } finally { await f.cleanup() }
})

test('a cooled thermal ending is terminal and cannot offer Continue', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start', minutes: 15 })
    f.thermalEnd(); await until(() => f.mode.read().phase === 'ended')
    expect(f.mode.read().reason).toBe('thermal')
    expect(f.calls).not.toContain('continue')
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

test('a partially installed helper cannot make unresolved sleep a dismissible setup error', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.failAfterPublishingAuthority()
    await f.mode.command({ action: 'start', minutes: 15 })
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

test('cancelling the administrator dialog returns to off without an error', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.cancelAdministratorDialog()
    await f.mode.command({ action: 'start', minutes: 30 })
    expect(f.calls).toEqual(['install'])
    expect(f.mode.read().phase).toBe('off')
    expect(f.mode.read().error).toBeUndefined()
  } finally { await f.cleanup() }
})

test('a leftover note without a helper clears only when normal sleep is observed', async () => {
  for (const sleepDisabled of [false, true]) {
    const f = fixture()
    try {
      f.leftoverNote(sleepDisabled)
      await f.mode.initialize()
      expect(f.mode.read().phase).toBe(sleepDisabled ? 'unresolved' : 'off')
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(sleepDisabled)
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }
})
