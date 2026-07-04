import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_PROMPT_BYTES } from '../shared/limits.js'
import {
  SidecarSendError,
  SidecarSupervisor,
  type SupervisorEvent,
  type SupervisorOptions,
} from './supervisor.js'

const supervisors: SidecarSupervisor[] = []
const tempDirs: string[] = []

function readyScript({
  sessionIdExpression = 'process.env.CATCODE_SIDECAR_SESSION_ID',
  engineSessionIdExpression = "'engine-test-session'",
  afterOpen = '',
  omitEngineSessionId = false,
}: {
  sessionIdExpression?: string
  engineSessionIdExpression?: string
  afterOpen?: string
  omitEngineSessionId?: boolean
} = {}): string {
  return `
    const socketPath = process.env.CATCODE_SIDECAR_SOCKET
    try { require('node:fs').unlinkSync(socketPath) } catch {}
    function writeFrame(socket, payload) {
      const json = Buffer.from(JSON.stringify(payload), 'utf8')
      const prefix = Buffer.allocUnsafe(4)
      prefix.writeUInt32BE(json.byteLength, 0)
      socket.write(Buffer.concat([prefix, json]))
    }
    Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          writeFrame(socket, {
            kind: 'ready',
            protocolVersion: 1,
            sessionId: ${sessionIdExpression},
            ${omitEngineSessionId ? '' : `engineSessionId: ${engineSessionIdExpression},`}
            payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true }
          })
          ${afterOpen}
        },
        data() {}
      }
    })
    setInterval(() => {}, 1000)
  `
}

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.shutdown()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

test('starts the sidecar process in the configured session cwd', async () => {
  const socketDir = makeTempDir('catcode-supervisor-socket-')
  const sessionCwd = makeTempDir('catcode-supervisor-cwd-')
  const observedCwdPath = join(socketDir, 'observed-cwd.txt')
  const script = [
    "const { writeFileSync } = require('node:fs')",
    'writeFileSync(process.argv[1], process.cwd())',
  ].join(';')

  const options = {
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', script, observedCwdPath],
    sidecarCwd: sessionCwd,
    socketDir,
  } as SupervisorOptions & { sidecarCwd: string }
  const supervisor = new SidecarSupervisor(options)
  supervisors.push(supervisor)
  supervisor.spawnSession('cwd-session')

  await waitFor(() => existsSync(observedCwdPath), 'sidecar did not report its cwd')
  expect(realpathSync(readFileSync(observedCwdPath, 'utf8'))).toBe(
    realpathSync(sessionCwd),
  )
})

test('rejects an oversized prompt before writing it and keeps the session usable', async () => {
  const socketDir = makeTempDir('catcode-supervisor-live-')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['run', join(import.meta.dir, '..', 'sidecar', 'index.ts')],
    sidecarEnv: { CATCODE_SIDECAR_PROBE: '1' },
    socketDir,
  })
  supervisors.push(supervisor)

  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))
  const sessionId = supervisor.spawnSession('oversized-prompt-session')
  await waitFor(
    () =>
      events.some(
        event =>
          event.type === 'status' &&
          event.sessionId === sessionId &&
          event.status === 'ready',
      ),
    'sidecar did not become ready',
  )

  expect(() =>
    supervisor.send(sessionId, {
      type: 'app.submit',
      requestId: 'oversized-request',
      prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1),
    }),
  ).toThrow(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`)

  supervisor.send(sessionId, { type: 'app.ping', nonce: 'still-alive' })
  await waitFor(
    () =>
      events.some(
        event =>
          event.type === 'frame' &&
          event.frame.kind === 'pong' &&
          event.frame.nonce === 'still-alive',
      ),
    'session did not answer after the rejected prompt',
  )
  expect(supervisor.listSessions()).toContainEqual({
    sessionId,
    status: 'ready',
  })
})

test('remote FIN transitions ready to disconnected and the session can restart', async () => {
  const socketDir = makeTempDir('catcode-supervisor-fin-')
  const script = readyScript({ afterOpen: 'setTimeout(() => socket.end(), 50)' })
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', script],
    socketDir,
  })
  supervisors.push(supervisor)

  const statuses: string[] = []
  supervisor.subscribe(event => {
    if (event.type === 'status') statuses.push(event.status)
  })
  const sessionId = supervisor.spawnSession('remote-fin-session')
  await waitFor(() => statuses.includes('disconnected'), 'remote FIN stayed ready')
  expect(statuses).toContain('ready')
  expect(supervisor.listSessions()).toContainEqual({
    sessionId,
    status: 'disconnected',
  })

  const readyCount = statuses.filter(status => status === 'ready').length
  supervisor.restartSession(sessionId)
  await waitFor(
    () => statuses.filter(status => status === 'ready').length > readyCount,
    'restarted session did not reconnect',
  )
})

test('F7 — spawn error transitions session status to failed without throwing', async () => {
  const socketDir = makeTempDir('catcode-supervisor-err-')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: '/no/such/binary/that/exists',
    socketDir,
  })
  supervisors.push(supervisor)

  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))
  const sessionId = supervisor.spawnSession('spawn-error-session')

  await waitFor(
    () => events.some(e => e.type === 'status' && e.sessionId === sessionId && e.status === 'failed'),
    'session did not transition to failed on spawn error',
  )

  expect(supervisor.listSessions()).toContainEqual({
    sessionId,
    status: 'failed',
  })
})

test('send to an unknown session throws terminal session_not_found', () => {
  const socketDir = makeTempDir('catcode-supervisor-unknown-')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    socketDir,
  })
  supervisors.push(supervisor)

  try {
    supervisor.send('missing-session', { type: 'app.ping', nonce: 'n' })
    throw new Error('send unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarSendError)
    expect((error as SidecarSendError).code).toBe('session_not_found')
    expect((error as SidecarSendError).retryable).toBe(false)
  }
})

test('send to a spawning session throws retryable session_not_ready', () => {
  const socketDir = makeTempDir('catcode-supervisor-spawning-')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', 'setInterval(() => {}, 1000)'],
    socketDir,
  })
  supervisors.push(supervisor)
  const sessionId = supervisor.spawnSession('spawning-session')

  try {
    supervisor.send(sessionId, { type: 'app.ping', nonce: 'n' })
    throw new Error('send unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarSendError)
    expect((error as SidecarSendError).code).toBe('session_not_ready')
    expect((error as SidecarSendError).retryable).toBe(true)
  }
})

test('send to an exited session throws terminal session_disconnected', async () => {
  const socketDir = makeTempDir('catcode-supervisor-exited-')
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: [
      '-e',
      readyScript({ afterOpen: 'setTimeout(() => process.exit(0), 50)' }),
    ],
    socketDir,
  })
  supervisors.push(supervisor)
  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))
  const sessionId = supervisor.spawnSession('exited-session')

  await waitFor(
    () =>
      events.some(
        event =>
          event.type === 'status' &&
          event.sessionId === sessionId &&
          event.status === 'exited',
      ),
    'session did not exit',
  )

  try {
    supervisor.send(sessionId, { type: 'app.ping', nonce: 'n' })
    throw new Error('send unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarSendError)
    expect((error as SidecarSendError).code).toBe('session_disconnected')
    expect((error as SidecarSendError).retryable).toBe(false)
  }
})

test('ready frame missing engineSessionId marks the session failed and is not emitted', async () => {
  const socketDir = makeTempDir('catcode-supervisor-ready-schema-')
  const events: SupervisorEvent[] = []
  const logs: string[] = []
  const loggedSupervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', readyScript({ omitEngineSessionId: true })],
    socketDir,
    log: line => logs.push(line),
  })
  supervisors.push(loggedSupervisor)
  loggedSupervisor.subscribe(event => events.push(event))
  const sessionId = loggedSupervisor.spawnSession('bad-ready-session')

  await waitFor(
    () =>
      events.some(
        event =>
          event.type === 'status' &&
          event.sessionId === sessionId &&
          event.status === 'failed',
      ),
    'session did not fail on malformed ready frame',
  )

  expect(events.some(event => event.type === 'frame')).toBe(false)
  expect(logs.some(line => line.includes('missing engineSessionId'))).toBe(true)
})

test('outbound frame sessionId tripwire drops and logs a mis-stamped frame', async () => {
  const socketDir = makeTempDir('catcode-supervisor-tripwire-')
  const logs: string[] = []
  const script = readyScript({
    afterOpen:
      "writeFrame(socket, { kind: 'pong', protocolVersion: 1, sessionId: 'wrong-session', nonce: 'bad' })",
  })
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', script],
    socketDir,
    log: line => logs.push(line),
  })
  supervisors.push(supervisor)
  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))
  const sessionId = supervisor.spawnSession('tripwire-session')

  await waitFor(
    () =>
      events.some(
        event =>
          event.type === 'frame' &&
          event.sessionId === sessionId &&
          event.frame.kind === 'ready',
      ),
    'valid ready frame was not emitted',
  )
  await waitFor(
    () => logs.some(line => line.includes('did not match connection')),
    'mis-stamped frame was not logged',
  )

  expect(
    events.some(
      event =>
        event.type === 'frame' &&
        event.frame.kind === 'pong' &&
        event.frame.nonce === 'bad',
    ),
  ).toBe(false)
})

test('F11 — a stale old-child exit after restart does not mark the new session dead', async () => {
  const socketDir = makeTempDir('catcode-supervisor-stale-')
  const script = readyScript()

  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', script],
    socketDir,
  })
  supervisors.push(supervisor)

  const events: SupervisorEvent[] = []
  supervisor.subscribe(event => events.push(event))
  const sessionId = supervisor.spawnSession('stale-exit-session')

  await waitFor(
    () => events.some(e => e.type === 'status' && e.sessionId === sessionId && e.status === 'ready'),
    'initial session did not become ready',
  )

  // Clear events to start fresh tracking for restart
  events.length = 0

  // Restart the session
  supervisor.restartSession(sessionId)

  // Wait for the restarted session to become ready
  await waitFor(
    () => events.some(e => e.type === 'status' && e.sessionId === sessionId && e.status === 'ready'),
    'restarted session did not become ready',
  )

  // Wait for old child to exit after SIGTERM
  await Bun.sleep(200)

  // The new session must still be ready
  expect(supervisor.listSessions()).toContainEqual({
    sessionId,
    status: 'ready',
  })

  // No exit events should mark this session status as exited post-restart
  const hasUnexpectedExit = events.some(
    e => e.type === 'status' && e.sessionId === sessionId && e.status === 'exited',
  )
  expect(hasUnexpectedExit).toBe(false)
})

