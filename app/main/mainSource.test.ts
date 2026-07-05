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

test('restart IPC routes through the host (SF5), which evicts replay + refreshes the row', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('ipcMain.on(CH_RESTART')
  const handlerEnd = source.indexOf('\n  })', handlerStart)

  expect(handlerStart).toBeGreaterThan(-1)
  expect(handlerEnd).toBeGreaterThan(-1)

  const handlerSource = source.slice(handlerStart, handlerEnd)

  // The restart no longer pokes the supervisor directly — the host owns it now,
  // so the registry advisory fields (pid/socketPath) refresh and replay is
  // evicted inside host.restartSession (proven in host.test.ts).
  expect(handlerSource).toContain('host.restartSession(arg.sessionId)')
  expect(handlerSource).not.toContain('supervisor.restartSession')
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
  expect(body).toContain('registry.launch()')
  // The primary session goes through the host API (call may wrap across lines).
  expect(/host\s*\.?\s*\n?\s*\.createSession\(/.test(body) || body.includes('host.createSession(')).toBe(true)
  expect(body).toContain('const primaryCwd = devHarnessConfig.initialCwd ?? process.cwd()')
  expect(body).toContain('createSession({ cwd: primaryCwd })')
  // The P3-0 carry: replay eviction is wired via the injected gate callback.
  expect(body).toContain('attachmentGate.clearSession(appSessionId)')
})

test('debug-state channel is registered only behind the dev + env double gate', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function registerDebugStateHandler(): void')
  const end = source.indexOf('\nfunction writeDebugStateExport', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(-1)

  const body = source.slice(start, end)
  expect(body).toContain('if (!IS_DEV || !devHarnessConfig.debugState) return')
  expect(body).toContain('ipcMain.on(DEBUG_SHELL_STATE_CHANNEL')
  expect(body).toContain('parseDebugSnapshot(snapshot)')
})

test('dev app name does not depend on app.getPath(userData)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  expect(source).toContain("app.setName('Cat Code Dev')")
  expect(source).not.toContain("app.getPath('userData')")
  expect(source).not.toContain('app.getPath("userData")')
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

test('HC1 ORIGIN rule: the renderer create handler resolves a token, never a renderer cwd', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  // The picker returns a one-time TOKEN, not the chosen path.
  expect(source).toContain('function mintCwdToken(')
  expect(source).toContain('function consumeCwdToken(')
  // pickDirectory mints a token from the validated realpath — it must NOT return
  // the realpath to the renderer.
  const pickStart = source.indexOf('ipcMain.handle(\n    CH_HOST_PICK_DIR')
  const pickEnd = source.indexOf('ipcMain.handle(\n    CH_HOST_CREATE', pickStart)
  const pickBody = source.slice(pickStart, pickEnd)
  expect(pickBody).toContain('return mintCwdToken(chosen.realpath)')
  expect(pickBody).not.toContain('return chosen.realpath')

  // The CREATE handler resolves the token to a cwd — it must NOT read a cwd off
  // the renderer payload, and must NOT forward a renderer resumeEngineSessionId.
  const createStart = source.indexOf('ipcMain.handle(\n    CH_HOST_CREATE')
  const createEnd = source.indexOf('ipcMain.handle(\n    CH_HOST_RESTORE', createStart)
  const createBody = source.slice(createStart, createEnd)
  expect(createBody).toContain("consumeCwdToken(token)")
  // No renderer-authored cwd or resume id reaches host.createSession.
  expect(createBody).not.toMatch(/readString\([^)]*['"]cwd['"]\)/)
  expect(createBody).not.toContain('resumeEngineSessionId')
})

test('restart routes through the host (SF5) and lifecycle uses host.shutdownAll (B3)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  // Restart no longer pokes the supervisor directly — it goes through the host so
  // the registry advisory fields refresh.
  const restartStart = source.indexOf('ipcMain.on(CH_RESTART')
  const restartEnd = source.indexOf('\n  })', restartStart)
  const restartBody = source.slice(restartStart, restartEnd)
  expect(restartBody).toContain('host.restartSession(arg.sessionId)')
  expect(restartBody).not.toContain('supervisor.restartSession')

  // Die-with-window marks rows clean via host.shutdownAll before the kill.
  expect(source).toContain('host.shutdownAll()')
  const wac = source.slice(
    source.indexOf("app.on('window-all-closed'"),
    source.indexOf("app.on('before-quit'"),
  )
  expect(wac).toContain('host.shutdownAll()')
})

test('B4: the launch promise is handed to the host as its readiness gate', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function ensureHost(): Host')
  const end = source.indexOf('\nfunction errText', start)
  const body = source.slice(start, end)
  // launch() is captured and passed to the host as `launched`, not just chained.
  expect(body).toContain('const launched = registry.launch()')
  expect(body).toContain('launched,')
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

test('F6: validateCwd NFC-normalizes the realpath (engine canonicalizePath parity)', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function validateCwd(')
  const end = source.indexOf('\n}\n', start)

  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(-1)

  const validateCwdSource = source.slice(start, end)
  // The engine sanitizes project dirs from realpath + NFC
  // (sessionStoragePortable.ts canonicalizePath); the host's validator must
  // produce the same canonical form or non-ASCII cwds break restore (F6).
  expect(validateCwdSource).toContain('realpathSync')
  expect(validateCwdSource).toContain(".normalize('NFC')")
})
