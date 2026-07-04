import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('normal Electron startup does not opt into the sidecar probe', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const createSupervisorStart = source.indexOf(
    'function createSupervisor(): SidecarSupervisor',
  )
  const createSupervisorEnd = source.indexOf(
    'function applySecurityBaseline(): void',
  )

  expect(createSupervisorStart).toBeGreaterThan(-1)
  expect(createSupervisorEnd).toBeGreaterThan(-1)

  const createSupervisorSource = source.slice(
    createSupervisorStart,
    createSupervisorEnd,
  )

  expect(createSupervisorSource).not.toContain('CATCODE_SIDECAR_PROBE')
})

test('bridges supervisor lifecycle events to renderer server frames', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const bridgeStart = source.indexOf('function wireRendererBridge(')
  const bridgeEnd = source.indexOf('\n}\n', bridgeStart)

  expect(bridgeStart).toBeGreaterThan(-1)
  expect(bridgeEnd).toBeGreaterThan(-1)

  const bridgeSource = source.slice(bridgeStart, bridgeEnd)

  expect(bridgeSource).not.toContain("if (event.type !== 'frame') return")
  expect(bridgeSource).toContain('supervisorEventToServerFrame')
  expect(bridgeSource).toContain('isTerminalLifecycleFrame')
  expect(bridgeSource).toContain('attachmentGate.clearSession(event.sessionId)')
})

test('configures a main-owned default sidecar boot cwd (P1_1_CWD hardcode retired)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const createSupervisorStart = source.indexOf(
    'function createSupervisor(): SidecarSupervisor',
  )
  const createSupervisorEnd = source.indexOf(
    'function applySecurityBaseline(): void',
  )

  expect(createSupervisorStart).toBeGreaterThan(-1)
  expect(createSupervisorEnd).toBeGreaterThan(-1)

  const createSupervisorSource = source.slice(
    createSupervisorStart,
    createSupervisorEnd,
  )

  // The P1-1 pinned literal is gone; main owns the default boot cwd until the
  // host API adds a native-picker cwd (P3-3).
  expect(createSupervisorSource).toContain('sidecarCwd: process.cwd()')
  expect(source).not.toContain('P1_1_CWD')
})

test('restart IPC clears stale replay before restarting the addressed session', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('ipcMain.on(CH_RESTART')
  const handlerEnd = source.indexOf('\n  })', handlerStart)

  expect(handlerStart).toBeGreaterThan(-1)
  expect(handlerEnd).toBeGreaterThan(-1)

  const handlerSource = source.slice(handlerStart, handlerEnd)

  expect(handlerSource.indexOf('attachmentGate.clearSession(arg.sessionId)')).toBeGreaterThan(-1)
  expect(handlerSource.indexOf('supervisor.restartSession(arg.sessionId)')).toBeGreaterThan(
    handlerSource.indexOf('attachmentGate.clearSession(arg.sessionId)'),
  )
})

test('uses crypto randomUUID instead of Math.random for request IDs in main.ts', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  expect(source).not.toContain('cryptoRandomId')
  expect(source).not.toContain('Math.random')
})

test('takes the OS single-instance lock BEFORE constructing the host (REGISTRY §5)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  const lockIndex = source.indexOf('app.requestSingleInstanceLock()')
  const whenReadyIndex = source.indexOf('app.whenReady()')
  // The ensureHost() CALL (not its definition) lives inside the whenReady block,
  // which only runs in the lock-held branch. The runtime host construction is
  // gated behind the lock.
  const ensureHostCallIndex = source.indexOf('ensureHost()', whenReadyIndex)

  expect(lockIndex).toBeGreaterThan(-1)
  // The lock is requested BEFORE whenReady, and whenReady's ensureHost() call
  // (the actual host construction at runtime) comes after the lock.
  expect(lockIndex).toBeLessThan(whenReadyIndex)
  expect(lockIndex).toBeLessThan(ensureHostCallIndex)
  // The whenReady body (and thus ensureHost) is only reachable in the else branch
  // of the lock check — a second instance defers rather than building a host.
  expect(source).toContain('const gotSingleInstanceLock = app.requestSingleInstanceLock()')
  expect(source).toContain('if (!gotSingleInstanceLock) {')
  expect(source).toContain("app.on('second-instance'")
})

test('main is a host-API caller: ensureHost composes supervisor + registry + host', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  const start = source.indexOf('function ensureHost(): Host')
  const end = source.indexOf('\nfunction errText', start)
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, end)

  expect(body).toContain('new SessionRegistry(')
  expect(body).toContain('new Host(')
  // Registry launch sweep runs, THEN the primary session goes through the host
  // API (not a bare supervisor.spawnSession) so registry hygiene applies.
  expect(body).toContain('registry')
  expect(body).toContain('.launch()')
  expect(body).toContain('host?.createSession(')
  // The P3-0 carry: closeSession/restart replay eviction wired via the gate.
  expect(body).toContain('attachmentGate.clearSession(appSessionId)')
})

test('control-plane cwd never trusts the renderer: HC1 native picker + host revalidation', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  // HC1 — the only cwd source is main's native dialog; the host revalidates.
  expect(source).toContain('dialog.showOpenDialog')
  expect(source).toContain('function validateCwd(cwd: string): CwdValidation')
  expect(source).toContain('realpathSync(cwd)')
  expect(source).toContain('.isDirectory()')

  // The five control-plane methods ride fixed per-method channels (HC3).
  expect(source).toContain("const CH_HOST_CREATE = 'catcode:host:create'")
  expect(source).toContain("const CH_HOST_PICK_DIR = 'catcode:host:pick-directory'")
  // Each fixed channel is served by an ipcMain.handle (arg may wrap to the next
  // line, so match the constant near a handle, not a glued string).
  for (const channel of [
    'CH_HOST_CREATE',
    'CH_HOST_RESTORE',
    'CH_HOST_CLOSE',
    'CH_HOST_LIST',
    'CH_HOST_PICK_DIR',
  ]) {
    expect(new RegExp(`ipcMain\\.handle\\(\\s*${channel}\\b`).test(source)).toBe(true)
  }
})

test('control plane adds ZERO new socket frame types (stays off the wire in v1)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  // Control-plane calls are host-API invocations, never SidecarClientMessages —
  // main never forwards a create/close/list as a frame to a sidecar.
  expect(source).not.toContain("type: 'app.createSession'")
  expect(source).not.toContain("type: 'host.")
  // The only forward() targets remain the four engine commands + setMode.
  const forwardTypes = [...source.matchAll(/forward\([^,]+,\s*\{\s*\n?\s*type:\s*'([^']+)'/g)].map(
    m => m[1],
  )
  for (const t of forwardTypes) {
    expect([
      'app.submit',
      'app.abort',
      'permission.response',
      'permission.setMode',
      'app.ping',
    ]).toContain(t)
  }
})
