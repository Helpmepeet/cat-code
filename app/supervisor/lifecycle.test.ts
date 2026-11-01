import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { type ChildProcess } from 'node:child_process'
import { type Socket } from 'node:net'
import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import { SidecarSupervisor } from './supervisor.js'

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture deadline'); await Bun.sleep(10) }
}

test('isolated parent awaits TERM-resistant child exit before cleaning socket directory', async () => {
  const dir = mkdtempSync('/tmp/cc-life-')
  const marker = `${dir}/armed`
  const modulePath = new URL('./supervisor.ts', import.meta.url).pathname
  const child = `process.on('SIGTERM',()=>{}); require('node:net').createServer(()=>{}).listen(process.env.CATCODE_SIDECAR_SOCKET,()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)));`
  const script = `import {SidecarSupervisor} from ${JSON.stringify(modulePath)};
    const s=new SidecarSupervisor({sidecarCommand:process.execPath,sidecarArgs:['-e',${JSON.stringify(child)}],socketDir:${JSON.stringify(`${dir}/sockets`)},killGraceMs:40});
    s.spawnSession('fixture');
    while(!require('node:fs').existsSync(${JSON.stringify(marker)})) await Bun.sleep(10);
    const first=s.shutdown(); if(first!==s.shutdown()) throw Error('not idempotent');
    const result=await first; if(!result.confirmed) throw Error('unconfirmed');`
  const parent = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  let pid: number | undefined
  try {
    await until(() => existsSync(marker))
    pid = Number(readFileSync(marker, 'utf8'))
    expect(await parent.exited).toBe(0)
    expect(alive(pid)).toBe(false)
    expect(existsSync(`${dir}/sockets`)).toBe(false)
  } finally {
    parent.kill()
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unconfirmed captured child preserves its socket evidence and blocks replacement', async () => {
  const dir = mkdtempSync('/tmp/cc-unconfirmed-')
  const path = `${dir}/evidence.sock`
  writeFileSync(path, 'ownership evidence')
  const signals: string[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, signalCode: null,
    kill(signal: string) { signals.push(signal); return false },
  }) as unknown as ChildProcess
  const s = new SidecarSupervisor({ sidecarCommand: process.execPath, socketDir: dir, killGraceMs: 5, log: () => {} })
  const registry = (s as unknown as { registry: Map<string, unknown> }).registry
  registry.set('unconfirmed', { sessionId: 'unconfirmed', generation: 'captured', child, socketPath: path, socket: null, decoder: new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES), status: 'connecting', operationalBuffer: '' })
  try {
    const barrier = s.shutdown()
    expect(s.shutdown()).toBe(barrier)
    expect(await barrier).toEqual({ confirmed: false, unresolvedSessionIds: ['unconfirmed'] })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(existsSync(path)).toBe(true)
    expect(() => s.spawnSession('unconfirmed')).toThrow()
    child.emit('exit', null, 'SIGKILL')
    expect(existsSync(path)).toBe(false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('deregistering a TERM-resistant child retains evidence until its delayed exit is confirmed', async () => {
  const s = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', `process.on('SIGTERM',()=>{});require('node:net').createServer(()=>{}).listen(process.env.CATCODE_SIDECAR_SOCKET)`],
    killGraceMs: 150, startupTimeoutMs: 3000, log: () => {},
  })
  s.spawnSession('delayed')
  const pid = s.getSessionProcessId('delayed')!
  const socketPath = s.getSessionSocketPath('delayed')!
  try {
    await until(() => s.listSessions().some(row => row.status === 'connecting'))
    s.killSession('delayed')
    expect(s.getSessionProcessId('delayed')).toBeUndefined()
    expect(alive(pid)).toBe(true)
    expect(existsSync(socketPath)).toBe(true)
    const barrier = s.shutdown()
    expect(alive(pid)).toBe(true)
    expect(existsSync(socketPath)).toBe(true)
    expect(await barrier).toEqual({ confirmed: true, unresolvedSessionIds: [] })
    expect(alive(pid)).toBe(false)
    expect(existsSync(socketPath)).toBe(false)
  } finally { await s.shutdown() }
})

for (const ready of ['never-connect', 'late', 'valid'] as const) {
  test(`startup deadline fences ${ready} transport callbacks`, async () => {
    const socket = Object.assign(new EventEmitter(), { destroy() {} }) as unknown as Socket
    let attached = false
    const s = new SidecarSupervisor({
      sidecarCommand: process.execPath,
      sidecarArgs: ['-e', `require('node:fs').writeFileSync(process.env.CATCODE_SIDECAR_SOCKET,'fixture');setInterval(()=>{},1000)`],
      startupTimeoutMs: 200, killGraceMs: 10, log: () => {},
      connectSocket: () => { attached = true; return socket },
    })
    const statuses: string[] = []
    s.subscribe(event => { if (event.type === 'status') statuses.push(event.status) })
    s.spawnSession('fenced')
    const sendReady = () => socket.emit('data', encodeFrame({ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'fenced', engineSessionId: 'engine', payload: { type: 'app.ready' } }))
    try {
      await until(() => attached)
      if (ready === 'valid') {
        socket.emit('connect')
        sendReady()
        await Bun.sleep(230)
        expect(statuses).toContain('ready')
        expect(statuses).not.toContain('failed')
      } else {
        await until(() => statuses.includes('failed'))
        if (ready === 'late') { socket.emit('connect'); sendReady() }
        expect(statuses).not.toContain('ready')
      }
    } finally { expect((await s.shutdown()).confirmed).toBe(true) }
  })
}

test('socket accepting silently cannot remain connecting past startup deadline', async () => {
  const s = new SidecarSupervisor({ sidecarCommand: process.execPath, sidecarArgs: ['-e', `require('node:net').createServer(()=>{}).listen(process.env.CATCODE_SIDECAR_SOCKET)`], startupTimeoutMs: 150, killGraceMs: 20, log: () => {} })
  const statuses: string[] = []
  s.subscribe(event => { if (event.type === 'status') statuses.push(event.status) })
  s.spawnSession('silent')
  const pid = s.getSessionProcessId('silent')!
  try {
    await until(() => statuses.includes('failed'))
    expect(statuses).not.toContain('ready')
    expect((await s.shutdown()).confirmed).toBe(true)
    expect(alive(pid)).toBe(false)
  } finally { await s.shutdown() }
})

// Capture the actual scheduled callbacks, including callbacks cleared by ready.
// Firing one explicitly models an already-queued timer without wall-clock races.
function controlledStartup() {
  const callbacks: Array<() => void> = []
  const original = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 123_456) callbacks.push(callback)
    return original(callback, delay, ...args)
  }) as typeof setTimeout)
  const sockets: Socket[] = []
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['-e', `require('node:fs').writeFileSync(process.env.CATCODE_SIDECAR_SOCKET,'fixture');setInterval(()=>{},1000)`],
    startupTimeoutMs: 123_456, killGraceMs: 10, log: () => {},
    connectSocket: () => {
      const socket = Object.assign(new EventEmitter(), { destroy() {} }) as unknown as Socket
      sockets.push(socket)
      return socket
    },
  })
  const ready = (socket: Socket, engineSessionId = 'engine') => socket.emit('data', encodeFrame({
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'controlled',
    engineSessionId, payload: { type: 'app.ready' },
  }))
  return { supervisor, sockets, callbacks, ready, restore: () => timer.mockRestore() }
}

for (const order of ['ready-before-deadline', 'ready-after-deadline', 'malformed-before-ready'] as const) {
  test(`controlled startup boundary: ${order}`, async () => {
    const fixture = controlledStartup()
    const { supervisor: s, sockets, callbacks, ready } = fixture
    const statuses: string[] = []
    let frames = 0
    s.subscribe(event => {
      if (event.type === 'status') statuses.push(event.status)
      if (event.type === 'frame') frames++
    })
    try {
      s.spawnSession('controlled')
      await until(() => sockets.length === 1)
      sockets[0]!.emit('connect')
      if (order === 'ready-before-deadline') {
        ready(sockets[0]!)
        callbacks[0]!()
        expect(s.listSessions()).toEqual([{ sessionId: 'controlled', status: 'ready' }])
        expect(statuses).not.toContain('failed')
        expect(frames).toBe(1)
      } else {
        if (order === 'malformed-before-ready') {
          sockets[0]!.emit('data', encodeFrame({ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'controlled', engineSessionId: '', payload: { type: 'app.ready' } }))
        } else callbacks[0]!()
        ready(sockets[0]!)
        sockets[0]!.emit('connect')
        callbacks[0]!()
        expect(statuses).toContain('failed')
        expect(statuses).not.toContain('ready')
        expect(frames).toBe(0)
      }
    } finally {
      fixture.restore()
      expect((await s.shutdown()).confirmed).toBe(true)
    }
  })
}

test('expired generation callbacks cannot affect connecting or ready replacement', async () => {
  const fixture = controlledStartup()
  const { supervisor: s, sockets, callbacks, ready } = fixture
  const engines: string[] = []
  s.subscribe(event => {
    if (event.type === 'frame' && event.frame.kind === 'ready') engines.push(event.frame.engineSessionId)
  })
  try {
    s.spawnSession('controlled')
    const first = s.getSessionGeneration('controlled')
    await until(() => sockets.length === 1)
    callbacks[0]!()
    expect(await s.stopSession('controlled')).toBe(true)
    s.spawnSession('controlled')
    expect(s.getSessionGeneration('controlled')).not.toBe(first)
    await until(() => sockets.length === 2)
    // The old socket reconnects and delivers late bytes while the new one connects.
    sockets[0]!.emit('connect')
    ready(sockets[0]!, 'expired')
    sockets[0]!.emit('data', encodeFrame({ kind: 'event', sessionId: 'controlled', event: { type: 'ignored-old-data' } }))
    callbacks[0]!()
    expect(engines).toEqual([])
    expect(s.listSessions()).toEqual([{ sessionId: 'controlled', status: 'connecting' }])
    sockets[1]!.emit('connect')
    ready(sockets[1]!, 'replacement')
    callbacks[0]!()
    ready(sockets[0]!, 'expired-again')
    sockets[0]!.emit('end')
    sockets[0]!.emit('close')
    expect(s.listSessions()).toEqual([{ sessionId: 'controlled', status: 'ready' }])
    expect(engines).toEqual(['replacement'])
  } finally {
    fixture.restore()
    expect((await s.shutdown()).confirmed).toBe(true)
  }
})
