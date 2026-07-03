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
})

test('configures the sidecar boot cwd to match the Phase-1 session cwd', () => {
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

  expect(createSupervisorSource).toContain('sidecarCwd: P1_1_CWD')
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
