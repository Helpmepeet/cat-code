import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { getBranch } from '../../src/utils/git.js'
import { createSidecarDiagnosticsDomain as createDomain } from './diagnosticsDomain.js'
import * as status from '../../src/utils/status.js'
import * as claudemd from '../../src/utils/claudemd.js'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { SidecarServer } from './sidecarServer.js'
import { createProbeAdapter } from './probeAdapter.js'
import { FrameDecoder } from '../shared/framing.js'
import type { ServerFrame } from '../shared/protocol.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'

const spies: Array<{ mockRestore(): void }> = []
const domains: Awaited<ReturnType<typeof createDomain>>[] = []
beforeEach(() => {
  spies.push(spyOn(status, 'buildInstallationDiagnostics').mockResolvedValue([]))
  spies.push(spyOn(status, 'buildInstallationHealthDiagnostics').mockResolvedValue([]))
  spies.push(spyOn(claudemd, 'getMemoryFiles').mockResolvedValue([]))
})
afterEach(() => {
  for (const domain of domains.splice(0)) domain.dispose()
  for (const spy of spies.splice(0)) spy.mockRestore()
})
async function createSidecarDiagnosticsDomain(store: ReturnType<typeof makeAppStateStore>) {
  const domain = await createDomain(store)
  domains.push(domain)
  const ready = new Promise<void>(resolve => domain.subscribe(resolve))
  domain.start()
  await ready
  return domain
}

// The compiled sidecar receives MACRO via Bun's build defines
// (initializeRuntime.ts); a bare unit test mirrors that same fallback so
// `MACRO.VERSION` is defined before the domain reads it.
;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO ??= {
  VERSION: 'test-version',
}

function makeAppStateStore(overrides: Partial<AppState> = {}) {
  return createStore({ ...getDefaultAppState(), ...overrides })
}

test('the domain reads once at spawn — getSnapshot returns a stable reference', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  const first = domain.getSnapshot()
  const second = domain.getSnapshot()
  expect(first).toBe(second)
})

test('reads the real MACRO version, sandbox flag, and model/effort/fast from the live app-state store', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({
      mainLoopModel: 'claude-opus-4-6',
      mainLoopModelForSession: 'claude-opus-4-6',
      effortValue: 'high',
      fastMode: true,
    }),
  )
  const snapshot = domain.getSnapshot()
  expect(snapshot).not.toBeNull()
  expect(snapshot?.version).toBe('test-version')
  expect(snapshot?.mainLoopModel).toBe('claude-opus-4-6')
  expect(snapshot?.mainLoopModelForSession).toBe('claude-opus-4-6')
  expect(snapshot?.reasoningEffort).toBe('high')
  expect(snapshot?.fastMode).toBe(true)
  expect(typeof snapshot?.sandboxEnabled).toBe('boolean')
  expect(Array.isArray(snapshot?.installationWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.healthWarnings)).toBe(true)
  expect(Array.isArray(snapshot?.memoryWarnings)).toBe(true)
})

test('a null mainLoopModel override still resolves a session model; unset effort/fast report honestly', async () => {
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  const snapshot = domain.getSnapshot()
  // The raw override is null (built-in default), not a fabricated label.
  expect(snapshot?.mainLoopModel).toBeNull()
  // mainLoopModelForSession falls back to the engine's own resolver
  // (getMainLoopModel) — a real string, or null only if resolution throws.
  const resolved = snapshot?.mainLoopModelForSession
  expect(resolved === null || typeof resolved === 'string').toBe(true)
  // No explicit effort set → null (running at the provider default), not "High".
  expect(snapshot?.reasoningEffort).toBeNull()
  // Fast mode is off unless explicitly enabled.
  expect(snapshot?.fastMode).toBe(false)
})

test('an explicit mainLoopModelForSession is preferred over the resolver fallback', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({ mainLoopModel: null, mainLoopModelForSession: 'gpt-5.6-terra' }),
  )
  expect(domain.getSnapshot()?.mainLoopModelForSession).toBe('gpt-5.6-terra')
})

// Live path, not shape-only: the branch on the wire must be what the ENGINE's own
// reader says, because the transcript catalog stamps its `gitBranch` with that
// same call (`src/utils/sessionStorage.ts:1464`) and the two must never disagree.
// This suite runs inside a git checkout, so the guarded arm is the real one.
test('the branch is the engine own getBranch(), with HEAD normalised to null', async () => {
  const engineBranch = await getBranch()
  const snapshot = (
    await createSidecarDiagnosticsDomain(makeAppStateStore())
  ).getSnapshot()
  if (engineBranch && engineBranch !== 'HEAD') {
    expect(snapshot?.gitBranch).toBe(engineBranch)
    expect(snapshot?.gitBranch?.length).toBeGreaterThan(0)
  } else {
    // No repo, or a detached HEAD: neither is a branch, so nothing is claimed.
    expect(snapshot?.gitBranch).toBeNull()
  }
})

test('a numeric effort value serialises to its string form', async () => {
  const domain = await createSidecarDiagnosticsDomain(
    makeAppStateStore({ effortValue: 3 }),
  )
  expect(domain.getSnapshot()?.reasoningEffort).toBe('3')
})

test('pending is null; start is idempotent and completion is retained for reconnects', async () => {
  let finish!: (warnings: string[]) => void
  const probe = spyOn(status, 'buildInstallationDiagnostics').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  expect(domain.getSnapshot()).toBeNull()
  let publications = 0
  const ready = new Promise<void>(resolve => domain.subscribe(() => { publications++; resolve() }))
  domain.start()
  domain.start()
  await Promise.resolve()
  expect(domain.getSnapshot()).toBeNull()
  finish(['warning'])
  await ready
  const first = domain.getSnapshot()
  domain.start()
  expect(domain.getSnapshot()).toBe(first)
  expect(first?.installationWarnings).toEqual(['warning'])
  expect(publications).toBe(1)
  expect(probe).toHaveBeenCalledTimes(1)
})

for (const beforeAttach of [true, false]) test(`real diagnostics completion ${beforeAttach ? 'before' : 'after'} attachment survives reconnect without another probe`, async () => {
  const installation = spyOn(status, 'buildInstallationDiagnostics').mockResolvedValue([])
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  const ready = new Promise<void>(resolve => domain.subscribe(resolve))
  if (beforeAttach) { domain.start(); await ready }
  const server = new SidecarServer({ sessionId: 'diagnostics-session', engineSessionId: 'diagnostics-engine',
    controller: new AppSessionController(createProbeAdapter()), diagnostics: domain, log() {} })
  const connect = () => {
    const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
    const frames: ServerFrame[] = []
    const connection = server.addConnection({ write(data) {
      for (const result of decoder.push(Buffer.from(data))) {
        if (result.kind === 'frame') frames.push(result.payload as ServerFrame)
      }
    }, end() {} })
    return { connection, frames }
  }
  try {
    const first = connect()
    if (!beforeAttach) {
      expect(first.frames.some(frame => frame.kind === 'diagnostics.snapshot')).toBe(false)
      await ready
    }
    expect(first.frames.filter(frame => frame.kind === 'diagnostics.snapshot')).toHaveLength(1)
    server.removeConnection(first.connection)
    const next = connect()
    await Bun.sleep(5)
    expect(next.frames.filter(frame => frame.kind === 'diagnostics.snapshot')).toHaveLength(1)
    expect(installation).toHaveBeenCalledTimes(1)
  } finally {
    server.close()
  }
})

test('disposal aborts owned work and suppresses late publication', async () => {
  let finish!: (warnings: string[]) => void
  let signal!: AbortSignal
  spyOn(status, 'buildInstallationDiagnostics').mockImplementation(budget => {
    signal = budget!.signal
    return new Promise(resolve => { finish = resolve })
  })
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  let publications = 0
  domain.subscribe(() => { publications++ })
  domain.start()
  await Promise.resolve()
  domain.dispose()
  expect(signal.aborted).toBe(true)
  finish([])
  await Bun.sleep(0)
  expect(domain.getSnapshot()).toBeNull()
  expect(publications).toBe(0)
})

test('probe failure is not reported as healthy', async () => {
  spyOn(status, 'buildInstallationDiagnostics').mockRejectedValue(new Error('fixture failure'))
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  expect(domain.getSnapshot()?.installationWarnings).toEqual(['Installation checks could not be completed.'])
})

test('a probe rejecting after cancellation stays handled and cannot publish', async () => {
  let reject!: (error: Error) => void
  spyOn(status, 'buildInstallationDiagnostics').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  let publications = 0
  domain.subscribe(() => { publications++ })
  domain.start()
  await Promise.resolve()
  domain.dispose()
  reject(new Error('late fixture rejection'))
  await Bun.sleep(0)
  expect(domain.getSnapshot()).toBeNull()
  expect(publications).toBe(0)
})

test('required instructions are prepared once and supply memory warnings before optional checks', async () => {
  const instructions = spyOn(claudemd, 'getMemoryFiles').mockResolvedValue([
    { type: 'Project', path: '/isolated/CLAUDE.md', content: 'x'.repeat(claudemd.MAX_MEMORY_CHARACTER_COUNT + 1) },
  ])
  const installation = spyOn(status, 'buildInstallationDiagnostics').mockResolvedValue([])
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  expect(instructions).toHaveBeenCalledTimes(1)
  expect(installation).not.toHaveBeenCalled()
  const ready = new Promise<void>(resolve => domain.subscribe(resolve))
  domain.start()
  await ready
  expect(instructions).toHaveBeenCalledTimes(1)
  expect(domain.getSnapshot()?.memoryWarnings).toHaveLength(1)
  expect(domain.getSnapshot()?.memoryWarnings[0]).toContain('CLAUDE.md')
})

test('disposing before start prevents any optional work', async () => {
  const installation = spyOn(status, 'buildInstallationDiagnostics').mockResolvedValue([])
  const domain = await createDomain(makeAppStateStore())
  domain.dispose()
  domain.start()
  await Promise.resolve()
  expect(installation).not.toHaveBeenCalled()
  expect(domain.getSnapshot()).toBeNull()
})

test('failed required diagnostic preparation retains the existing absent-snapshot degradation', async () => {
  spies.push(spyOn(status, 'buildMemoryDiagnostics').mockRejectedValue(new Error('fixture preparation failure')))
  const installation = spyOn(status, 'buildInstallationDiagnostics').mockResolvedValue([])
  const domain = await createDomain(makeAppStateStore())
  domains.push(domain)
  domain.start()
  await Promise.resolve()
  expect(domain.getSnapshot()).toBeNull()
  expect(installation).not.toHaveBeenCalled()
})

test('total timeout publishes a complete failure aggregate even for an unresolved probe', async () => {
  spyOn(status, 'buildInstallationDiagnostics').mockImplementation(() => new Promise(() => {}))
  const domain = await createSidecarDiagnosticsDomain(makeAppStateStore())
  expect(domain.getSnapshot()?.installationWarnings).toEqual(['Installation checks cancelled or timed out.'])
  expect(domain.getSnapshot()?.healthWarnings).toEqual([])
}, 7000)
