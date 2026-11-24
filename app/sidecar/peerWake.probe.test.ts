import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host } from '../host/host.js'
import { SessionRegistry } from '../host/registry.js'
import { createPeerRequestPlane } from '../main/peerRequestPlane.js'
import { isSessionLive, isSessionReadyForFrames, SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'
import type { ServerFrame } from '../shared/protocol.js'
import { SidecarSendError, SidecarSupervisor } from '../supervisor/supervisor.js'

test.each(['empty', 'whitespace', 'reasoning'])('a peer wakes a closed chat after a successful %s reply', async response => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-wake-')))
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const transcriptPath = (path: string, id: string) => join(root, 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl')
  const registry = new SessionRegistry({ storageDir: join(root, 'desktop'), transcriptPathFor: transcriptPath })
  const logs: string[] = []
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath,
    sidecarArgs: ['--preload=' + new URL('./peerWakeProvider.fixture.ts', import.meta.url).pathname,
      ...SIDECAR_RUNTIME_ARGS, new URL('./index.ts', import.meta.url).pathname],
    sidecarEnv: {
      ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('CATCODE_')).map(key => [key, ''])),
      HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: join(root, 'codex'),
      NODE_ENV: 'development',
      CAT_CODE_MODEL: 'claude-sonnet-4-6', PEER_WAKE_RESPONSE: response,
      ANTHROPIC_API_KEY: 'isolated-peer-wake-probe', ANTHROPIC_BASE_URL: 'https://peer-wake.invalid',
      ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_USE_OPENAI: '', CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
      CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ENABLE_TOOL_SEARCH: 'false', TEST_ENABLE_SESSION_PERSISTENCE: '1',
    },
    log: message => logs.push(message),
  })
  try {
    await registry.launch()
    const host = new Host({ supervisor, registry, validateCwd: path => ({ ok: true, realpath: path }) })
    const frames: ServerFrame[] = []
    const routed: Array<{ outcome: string; messageId: string }> = []
    const isLive = (id: string) => isSessionLive(supervisor.listSessions(), id)
    const plane = createPeerRequestPlane({
      rows: () => registry.readCurrentSessions(),
      isLive, isReady: id => isSessionReadyForFrames(supervisor.listSessions(), id),
      canResume: id => host.canResume(id),
      restoreSession: id => host.restoreSession(id, { openedByPeer: true }),
      createSessionInWorkspace: (id, peer) => host.createSessionInWorkspace(id, peer),
      setPeerNotice: (id, notice) => registry.setPeerNotice(id, notice),
      forward: (id, message) => {
        try { supervisor.send(id, message); return null }
        catch (error) { if (error instanceof SidecarSendError) return error.code; throw error }
      },
      logRouted: (_id, fields) => routed.push(fields),
    })
    supervisor.subscribe(event => {
      if (event.type === 'exit') plane.onSessionDown(event.sessionId)
      if (event.type !== 'frame') return
      frames.push(event.frame)
      if (event.frame.kind === 'ready') plane.onReady(event.sessionId)
      if (event.frame.kind === 'host.request') void plane.handleRequest(event.sessionId, event.frame)
    })
    const wait = async (predicate: () => boolean, goal: string, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (!predicate()) {
        if (Date.now() > deadline) {
          const results = frames.flatMap(frame => {
            if (frame.kind === 'error') return [frame.code + ': ' + frame.message]
            if (frame.kind !== 'event' || frame.event.type !== 'message' || frame.event.message.type !== 'result') return []
            const result = frame.event.message
            return [result.subtype + ': ' + JSON.stringify(result.subtype === 'success' ? result.result : result)]
          })
          throw new Error('Waiting for ' + goal + ': ' + [...logs.slice(-18), ...results.slice(-4)].join('\n'))
        }
        await Bun.sleep(10)
      }
    }
    const open = async () => {
      const created = await host.createSession({ cwd, permissionMode: 'default' })
      if (!created.ok) throw new Error(created.error.message)
      const { appSessionId, name } = created.value
      if (!name) throw new Error('Peer was not named')
      await wait(() => frames.some(frame => frame.sessionId === appSessionId && frame.kind === 'ready'), 'initial ready')
      return { appSessionId, name }
    }
    const submit = (id: string, prompt: string) => supervisor.send(id, { type: 'app.submit', requestId: randomUUID(), prompt })
    const succeeded = (id: string, from: number, text?: string) => frames.slice(from).some(frame =>
      frame.sessionId === id && frame.kind === 'event' && frame.event.type === 'message' &&
      frame.event.message.type === 'result' && frame.event.message.subtype === 'success' &&
      (text === undefined || frame.event.message.result?.trim() === text))

    const recipient = await open()
    const trustId = randomUUID()
    supervisor.send(recipient.appSessionId, { type: 'workspace.trust', requestId: trustId })
    await wait(() => frames.some(frame => frame.kind === 'workspace.trust.result' && frame.requestId === trustId), 'workspace trust')
    expect(frames.find(frame => frame.kind === 'workspace.trust.result' && frame.requestId === trustId)).toMatchObject({ ok: true })
    const sender = await open()
    submit(recipient.appSessionId, 'peer-wake send to ' + sender.name + ': First peer message')
    await wait(() => succeeded(recipient.appSessionId, 0, ''), 'recipient silent completion')
    await wait(() => succeeded(sender.appSessionId, 0), 'first message consumed')
    expect(routed.map(line => line.outcome)).toEqual(['queued_live'])
    expect(await host.closeSession(recipient.appSessionId)).toMatchObject({ ok: true })
    expect(isLive(recipient.appSessionId)).toBe(false)
    expect(host.canResume(recipient.appSessionId)).toBe(true)

    const afterClose = frames.length
    submit(sender.appSessionId, 'peer-wake send to ' + recipient.name + ': Second peer message')
    await wait(() => frames.slice(afterClose).some(frame => frame.sessionId === recipient.appSessionId && frame.kind === 'ready'), 'automatic recipient restore')
    await wait(() => succeeded(recipient.appSessionId, afterClose), 'recipient processing the second peer message without human input')
    expect(routed.map(line => line.outcome)).toEqual(['queued_live', 'queued_wake'])
    expect(plane.pendingFor(recipient.appSessionId)).toEqual([])
    const ready = frames.slice(afterClose).find(frame => frame.sessionId === recipient.appSessionId && frame.kind === 'ready')
    if (ready?.kind !== 'ready') throw new Error('Missing restored transcript id')
    expect(frames.find(frame => frame.sessionId === recipient.appSessionId && frame.kind === 'ready')).toMatchObject({ engineSessionId: ready.engineSessionId })
    const rows = readFileSync(transcriptPath(cwd, ready.engineSessionId), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const delivery = routed[1]!.messageId
    expect(rows.filter(row => row.type === 'user' && row.uuid === delivery)).toEqual([
      expect.objectContaining({ origin: expect.objectContaining({ kind: 'peer', name: sender.name }) }),
    ])
    const completion = rows.find(row => row.type === 'assistant' && row.isInternalNoResponseSentinel)
    expect(completion?.uuid).toBeDefined()
    expect(frames.some(frame => frame.kind === 'event' && frame.event.type === 'message' &&
      frame.event.message.uuid === completion?.uuid)).toBe(false)
  } finally {
    const stopped = await supervisor.shutdown()
    if (stopped.confirmed) rmSync(root, { recursive: true, force: true })
    expect(stopped.confirmed).toBe(true)
  }
}, 45_000)
