import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LidClosedMode } from './lidClosedMode.js'
import { LidSetupCancelled, type LidNativeSnapshot, type LidNativeReply } from './lidClosedNative.js'
import type { LidWorkAggregate } from './lidWorkObserver.js'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cat-lid-owner-'))
  const marker = join(directory, 'pending.json')
  let installed = false
  let outdated = false
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
  let aggregate: LidWorkAggregate = { availability: 'fresh', hasUnfinishedWork: true, activeSessions: 1, activeSubagents: 0, waitingForApproval: false, revision: 1, supervisionLost: false }
  const workListeners = new Set<(value: LidWorkAggregate) => void>()
  let workStarted = false
  let verifyGate: ReturnType<typeof deferred> | undefined
  let verificationStarted = false
  let renewalReceipt: 'accepted' | 'rejected' | 'wrong-sequence' = 'accepted'
  let completionSafetyReason: string | undefined
  let snapshot: LidNativeSnapshot = { record: { phase: 'off', began: 0, deadline: 0, allowance: 0, needsRestore: false, sleepRequested: false, sleepRequestAttempted: false },
    safety: { sleepDisabled: false, lidClosed: false, onBattery: true, batteryPercent: 75, thermal: 'nominal' }, remainingSeconds: 0, hardwareQualified: true }
  const phases: string[] = []
  const calls: string[] = []
  const deps = {
    marker, installed: () => installed,
    current: async () => installed && !outdated,
    hardware: async () => ({ qualified: true, evidence: 'fixture', model: 'fixture', osBuild: 'fixture', safety: snapshot.safety }),
    install: async () => {
      calls.push('install'); await installGate?.promise
      if (failInstall) throw new Error('Authorization cancelled')
      if (cancelInstall) throw new LidSetupCancelled('Administrator setup was cancelled.')
      installed = true
      outdated = false
      if (partialInstallFailure) {
        partialInstallFailure = false; failRestore = true
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'unresolved', identity: randomUUID(), needsRestore: true }, safety: { ...snapshot.safety, sleepDisabled: true } }
        throw new Error('Installation interrupted')
      }
    },
    work: {
      async start() { workStarted = true; return structuredClone(aggregate) },
      read() { return structuredClone(workStarted ? aggregate : { ...aggregate, availability: 'unknown' as const }) },
      async refresh() { return structuredClone(aggregate) },
      async verify() { verificationStarted = true; await verifyGate?.promise; return structuredClone(aggregate) },
      subscribe(listener: (value: LidWorkAggregate) => void) { workListeners.add(listener); return () => workListeners.delete(listener) },
      stop() { workStarted = false; workListeners.clear() },
    },
    native: { close() {}, async command(input: { op: string; identity?: string; allowance?: number; sequence?: number }): Promise<LidNativeReply> {
      calls.push(input.op)
      if (input.op === 'renew-work') await pulseGate?.promise
      if (helperUnavailable) throw new Error('Helper unavailable')
      if (input.op === 'start-work') {
        expect(JSON.parse(readFileSync(marker, 'utf8')).pending).toBe(true)
        await startGate?.promise
        snapshot = { ...snapshot, record: { ...snapshot.record, version: 2, mode: 'work', renewalSequence: 0, phase: 'active', identity: input.identity, began: 100, deadline: 110, allowance: 0, needsRestore: true, sleepRequested: false, sleepRequestAttempted: false, sleepRequestSucceeded: undefined }, safety: { ...snapshot.safety, sleepDisabled: true }, remainingSeconds: 10 }
      }
      if (['stop','retry','sleep','finish-work'].includes(input.op)) {
        if (transitionPending) return { ok: false, error: 'transition-pending', snapshot: structuredClone(snapshot) }
        if (failRestore) return { ok: false, snapshot: { ...snapshot, record: { ...snapshot.record, phase: 'unresolved' } } }
        if (input.op === 'finish-work' && completionSafetyReason) {
          snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: completionSafetyReason },
            safety: { ...snapshot.safety, sleepDisabled: false } }
          return { ok: false, snapshot: structuredClone(snapshot) }
        }
        const sleepRequested = input.op === 'sleep' || snapshot.record.sleepRequested
        snapshot = { ...snapshot, record: { ...snapshot.record, phase: 'ended', needsRestore: false, reason: input.op === 'sleep' ? 'sleep-requested' : input.op === 'finish-work' ? 'work-finished' : 'stopped',
          sleepRequested, sleepRequestAttempted: sleepRequested, sleepRequestSucceeded: sleepRequested ? true : undefined,
          ...(sleepRequested ? sleepResult : {}) }, safety: { ...snapshot.safety, sleepDisabled: false } }
      }
      if (input.op === 'renew-work') {
        snapshot = { ...snapshot, record: { ...snapshot.record,
          renewalSequence: renewalReceipt === 'wrong-sequence' ? input.sequence! + 1 : input.sequence!,
          deadline: 110 + input.sequence! }, remainingSeconds: 10 }
        if (renewalReceipt === 'rejected') return { ok: false, snapshot: structuredClone(snapshot) }
      }
      return { ok: true, snapshot: structuredClone(snapshot) }
    } },
    changed(view: { phase: string }) { phases.push(view.phase) },

  }
  let mode = new LidClosedMode(deps)
  return { get mode() { return mode }, marker, calls, phases,
    existingHelper(stale = false) { installed = true; outdated = stale },
    workState(next: Partial<LidWorkAggregate>) {
      aggregate = { ...aggregate, ...next, revision: next.revision ?? aggregate.revision + 1 }
      for (const listener of workListeners) listener(structuredClone(aggregate))
    },
    get workStarted() { return workStarted },
    blockVerify(gate: ReturnType<typeof deferred>) { verifyGate = gate },
    renewalReceipt(value: typeof renewalReceipt) { renewalReceipt = value },
    completionSafety(reason: string) { completionSafetyReason = reason },
    get verificationStarted() { return verificationStarted },
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
    nativeWorkEnded(reason: string) {
      snapshot = { ...snapshot, record: { ...snapshot.record, version: 2, mode: 'work', renewalSequence: 0, phase: 'ended', needsRestore: false, reason }, safety: { ...snapshot.safety, sleepDisabled: false } }
    },
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
    async cleanup() { failRestore = false; transitionPending = false; pulseGate?.resolve(); verifyGate?.resolve(); installGate?.resolve(); startGate?.resolve(); await mode.shutdown(); rmSync(directory, { recursive: true, force: true }) },
  }
}
async function until(check: () => boolean) { const end = Date.now() + 4000; while (!check() && Date.now() < end) await Bun.sleep(10); expect(check()).toBe(true) }

test('manual activation without work stays off and does not touch setup or power', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.workState({ hasUnfinishedWork: false })
    await f.mode.command({ action: 'start' })
    expect(f.calls).toEqual([])
    expect(f.mode.read()).toMatchObject({ phase: 'off', reason: 'no-work' })
    expect(() => readFileSync(f.marker, 'utf8')).toThrow()
  } finally { await f.cleanup() }
})

test('manual activation requires current work and starts work-mode supervision', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    expect(f.calls.slice(0, 2)).toEqual(['install', 'start-work'])
    expect(f.mode.read().phase).toBe('active')
    await until(() => f.calls.includes('renew-work'))
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('fresh empty work ends only after grace and final verification', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    f.workState({ hasUnfinishedWork: false })
    await until(() => f.calls.includes('finish-work'))
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'work-finished' })
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
  } finally { await f.cleanup() }
})

test('work that finishes during helper setup is not activated', async () => {
  const f = fixture()
  try {
    f.existingHelper(true)
    await f.mode.initialize()
    const gate = f.setupGate()
    const start = f.mode.command({ action: 'start' })
    await until(() => f.calls.includes('install'))
    f.workState({ hasUnfinishedWork: false })
    gate.resolve()
    await start
    expect(f.calls).toEqual(['status', 'install'])
    expect(f.mode.read()).toMatchObject({ phase: 'off', reason: 'no-work' })
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
  } finally { await f.cleanup() }
})

test('work that finishes during native admission is restored without an active view', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    const gate = f.nativeStartGate()
    const start = f.mode.command({ action: 'start' })
    await until(() => f.calls.includes('start-work'))
    const phasesAtAdmission = f.phases.length
    f.workState({ hasUnfinishedWork: false })
    gate.resolve()
    await start
    expect(f.phases.slice(phasesAtAdmission)).not.toContain('active')
    expect(f.calls).toContain('finish-work')
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'work-finished' })
  } finally { await f.cleanup() }
})

test('new admission during final verification cancels finish-work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    const gate = deferred()
    f.blockVerify(gate)
    f.workState({ hasUnfinishedWork: false })
    await until(() => f.verificationStarted)
    f.mode.onAdmissionStarted()
    f.workState({ hasUnfinishedWork: true })
    gate.resolve()
    await Bun.sleep(20)
    expect(f.calls).not.toContain('finish-work')
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('native renewals continue while final verification waits', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    const gate = deferred()
    f.blockVerify(gate)
    f.workState({ hasUnfinishedWork: false })
    await until(() => f.verificationStarted)
    await until(() => f.calls.includes('renew-work'))
    expect(f.mode.read().phase).toBe('active')
    gate.resolve()
    await until(() => f.calls.includes('finish-work'))
  } finally { await f.cleanup() }
})

for (const receipt of ['rejected', 'wrong-sequence'] as const) {
  test(`${receipt} active renewal receipt cannot keep work mode active`, async () => {
    const f = fixture()
    try {
      await f.mode.initialize()
      await f.mode.command({ action: 'start' })
      f.renewalReceipt(receipt)
      await until(() => f.calls.includes('renew-work'))
      await until(() => f.mode.read().phase !== 'active')
      expect(f.mode.read().reason).not.toBe('work-finished')
      expect(f.calls.filter(call => call === 'renew-work')).toHaveLength(1)
    } finally { await f.cleanup() }
  })
}

test('native safety ending wins over a queued work completion', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    f.completionSafety('thermal')
    f.workState({ hasUnfinishedWork: false })
    await until(() => f.calls.includes('finish-work'))
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'thermal' })
  } finally { await f.cleanup() }
})

test('unknown initial work refuses activation before helper setup', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.workState({ availability: 'unknown' })
    await f.mode.command({ action: 'start' })
    expect(f.calls).toEqual([])
    expect(f.mode.read()).toMatchObject({ phase: 'off', reason: 'work-status-unavailable' })
  } finally { await f.cleanup() }
})

test('an older installed helper is upgraded on start, not during initialization', async () => {
  const f = fixture()
  try {
    f.existingHelper(true)
    await f.mode.initialize()
    expect(f.calls).toEqual(['status'])
    await f.mode.command({ action: 'start' })
    expect(f.calls).toEqual(['status', 'install', 'start-work'])
    expect(f.mode.read()).toMatchObject({ phase: 'active' })
  } finally { await f.cleanup() }
})

test('an unchanged installed helper starts without administrator setup', async () => {
  const f = fixture()
  try {
    f.existingHelper()
    await f.mode.initialize()
    await f.mode.command({ action: 'start' })
    expect(f.calls).toEqual(['status', 'start-work'])
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('cancelling a helper upgrade preserves confirmed normal sleep without starting', async () => {
  const f = fixture()
  try {
    f.existingHelper(true)
    await f.mode.initialize()
    f.cancelAdministratorDialog()
    await f.mode.command({ action: 'start' })
    expect(f.calls).toEqual(['status', 'install'])
    expect(f.mode.read()).toMatchObject({ phase: 'off', installed: true })
    expect(f.mode.read().error).toBeUndefined()
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
  } finally { await f.cleanup() }
})

test('cancelling during an upgrade cannot activate the newly installed helper', async () => {
  const f = fixture()
  try {
    f.existingHelper(true)
    await f.mode.initialize()
    const gate = f.setupGate()
    const start = f.mode.command({ action: 'start' })
    await until(() => f.calls.includes('install'))
    const cancel = f.mode.command({ action: 'cancel' })
    gate.resolve()
    await Promise.all([start, cancel])
    expect(f.calls).not.toContain('start-work')
    expect(f.mode.read().phase).toBe('off')
  } finally { await f.cleanup() }
})

test('a start refused for low battery can start again once charged', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.battery(20)
    await f.mode.command({ action: 'start' })
    expect(f.mode.read()).toMatchObject({ phase: 'unavailable', error: 'Charge above 20% before starting.' })
    f.battery(80)
    await f.mode.command({ action: 'start' })
    expect(f.mode.read().phase).toBe('active')
  } finally { await f.cleanup() }
})

test('cancel during setup and native admission cannot activate a late result', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    const gate = f.setupGate(); const setup = f.mode.command({ action: 'start' })
    await until(() => f.calls.includes('install'))
    const cancel = f.mode.command({ action: 'cancel' }); gate.resolve()
    await Promise.all([setup, cancel]); expect(f.calls).not.toContain('start-work'); expect(f.mode.read().phase).toBe('off')
    const native = f.nativeStartGate(); const start = f.mode.command({ action: 'start' })
    await until(() => f.calls.includes('start-work'))
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
    await f.mode.initialize(); await f.mode.command({ action: 'start' })
    f.failRestore(true); await f.mode.command({ action: 'stop' })
    expect(f.mode.read().phase).toBe('unresolved'); expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
    await f.restart(); expect(f.mode.read().phase).toBe('unresolved')
    const count = f.calls.filter(call => call === 'start-work').length
    await f.mode.command({ action: 'start' }); expect(f.calls.filter(call => call === 'start-work')).toHaveLength(count)
    f.failRestore(false); await f.mode.command({ action: 'retry' })
    expect(f.mode.read().phase).toBe('ended'); expect(f.calls).not.toContain('continue')
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
    expect(f.calls.filter(call => call === 'start-work')).toHaveLength(count)
  } finally { await f.cleanup() }
})

for (const action of ['stop', 'sleep'] as const) {
  test(`${action} intent survives failed active replies and status until explicit recovery`, async () => {
    const f = fixture()
    try {
      await f.mode.initialize(); await f.mode.command({ action: 'start' })
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
      expect(f.calls).not.toContain('renew-work')
      await f.mode.command({ action: 'dismiss' })
      await f.mode.command({ action: 'start' })
      expect(f.mode.read().phase).toBe('unresolved')
      expect(f.calls.filter(call => call === 'start-work')).toHaveLength(1)
      f.transitionPending(false)
      const recoveryFrom = f.calls.length
      await f.mode.command({ action: 'retry' })
      expect(f.calls.slice(recoveryFrom)).toEqual(['retry'])
      expect(f.mode.read().phase).toBe('ended')
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
      await f.mode.command({ action: 'start' })
      expect(f.mode.read().phase).toBe('active')
    } finally { await f.cleanup() }
  })
}

test('stop intent prevents an in-flight pulse reply from readmitting active work', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start' })
    const gate = f.nativePulseGate()
    await until(() => f.calls.includes('renew-work'))
    f.transitionPending(true)
    const from = f.phases.length
    const stop = f.mode.command({ action: 'stop' })
    gate.resolve(); await stop
    expect(f.phases.slice(from)).not.toContain('active')
    expect(f.mode.read().phase).toBe('unresolved')
    await until(() => f.calls.includes('status'))
    expect(f.calls.filter(call => call === 'renew-work')).toHaveLength(1)
  } finally { await f.cleanup() }
})

for (const outcome of [
  { name: 'never admitted', sleepRequested: false, sleepRequestAttempted: false },
  { name: 'recorded but never attempted', sleepRequested: true, sleepRequestAttempted: false },
  { name: 'attempted without a receipt', sleepRequested: true, sleepRequestAttempted: true },
  { name: 'failed', sleepRequested: true, sleepRequestAttempted: true, sleepRequestSucceeded: false, error: 'sleep-request-failed' },
  { name: 'confirmed', sleepRequested: true, sleepRequestAttempted: true, sleepRequestSucceeded: true },
]) {
  test(`watchdog safety reason wins over the ${outcome.name} Sleep intent without another request`, async () => {
    const f = fixture()
    try {
      await f.mode.initialize(); await f.mode.command({ action: 'start' })
      f.transitionPending(true)
      await f.mode.command({ action: 'sleep' })
      const { name: _name, ...record } = outcome
      f.watchdogRestored(record)
      await until(() => f.mode.read().phase === 'ended')
      expect(f.mode.read()).toMatchObject({
        reason: 'supervision-lost',
        sleepRequested: outcome.sleepRequested,
      })
      expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(false)
      expect(f.calls.filter(call => call === 'sleep')).toHaveLength(1)
      expect(f.calls).not.toContain('renew-work')
      const settledCalls = f.calls.length
      await f.mode.command({ action: 'retry' })
      expect(f.calls).toHaveLength(settledCalls)
    } finally { await f.cleanup() }
  })
}

test('a direct Sleep failure does not overwrite its unconfirmed outcome after restoration', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start' })
    f.sleepResult({ sleepRequestSucceeded: false, error: 'sleep-request-failed' })
    await f.mode.command({ action: 'sleep' })
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'sleep-unconfirmed', error: 'sleep-request-failed' })
    expect(f.calls.filter(call => call === 'sleep')).toHaveLength(1)
    expect(f.calls).not.toContain('renew-work')
  } finally { await f.cleanup() }
})

test('a confirmed direct Sleep request retains its native outcome', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start' })
    await f.mode.command({ action: 'sleep' })
    expect(f.mode.read()).toMatchObject({ phase: 'ended', reason: 'sleep-requested', sleepRequested: true })
  } finally { await f.cleanup() }
})

test('a cooled thermal ending is terminal and cannot offer Continue', async () => {
  const f = fixture()
  try {
    await f.mode.initialize(); await f.mode.command({ action: 'start' })
    f.thermalEnd()
    f.workState({ supervisionLost: true })
    await until(() => f.mode.read().phase === 'ended')
    expect(f.mode.read().reason).toBe('supervision-lost')
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
      expect(f.calls).not.toContain('start-work')
    } finally { await f.cleanup() }
  }
})

test('a partially installed helper cannot make unresolved sleep a dismissible setup error', async () => {
  const f = fixture()
  try {
    await f.mode.initialize()
    f.failAfterPublishingAuthority()
    await f.mode.command({ action: 'start' })
    expect(f.mode.read().phase).toBe('unresolved')
    expect(JSON.parse(readFileSync(f.marker, 'utf8')).pending).toBe(true)
    await f.mode.command({ action: 'dismiss' })
    expect(f.mode.read().phase).toBe('unresolved')
    expect(f.calls).not.toContain('start-work')
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
    await f.mode.command({ action: 'start' })
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
