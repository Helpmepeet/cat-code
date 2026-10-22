import { afterEach, expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { resetCommandQueue } from '../../src/utils/messageQueueManager.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import type { InlineCommandRun, InlineCommandSource } from '../shared/inlineCommand.js'
import { SidecarServer, type SidecarServerOptions } from './sidecarServer.js'
import { createTranscriptState, projectServerFrame, selectTranscriptRows } from '../renderer/src/transcriptProjector.js'
import { encodeInlineCommandResult } from '../shared/inlineCommand.js'
import { FrameReplayBuffer } from '../main/replayBuffer.js'
import type { SDKMessage } from '../shared/engine-types.snapshot.js'

const source: InlineCommandSource = {
  engineSessionId: 'engine-inline-test', messageUuid: 'assistant-message',
  contentBlockIndex: 0, fenceOrdinal: 0,
}

// Execution behavior belongs to the real-engine tests. This adapter records
// whether an untrusted desktop frame reaches the controller at all.
class RecordingController extends AppSessionController {
  calls = 0
  aborts = 0
  publishRun = true
  rejectBeforeProgress = false
  rejectAfterCompletion = false
  stopped: string[] = []
  release: (() => void) | null = null
  constructor() { super({ async *runTurn() {} }) }
  override async submitInlineCommand(
    selected: InlineCommandSource,
    progress: (run: InlineCommandRun) => void,
  ): Promise<void> {
    this.calls++
    if (this.rejectBeforeProgress) throw new Error('The selected code block is no longer available.')
    const run: InlineCommandRun = {
      runId: 'owned-run', source: selected, command: 'printf hello', cwd: '/isolated',
      status: 'running', output: 'hello', exitCode: null,
    }
    if (this.publishRun) progress(run)
    await new Promise<void>(resolve => { this.release = resolve })
    progress({ ...run, status: 'success', exitCode: 0 })
    if (this.rejectAfterCompletion) throw new Error('Agent response failed.')
  }
  override stopInlineCommand(runId: string): boolean {
    if (runId !== 'owned-run' || !this.release) return false
    this.stopped.push(runId)
    this.release()
    return true
  }
  override abort(reason?: string): void {
    this.aborts++
    super.abort(reason)
    this.release?.()
  }
}

const fixtures: { server: SidecarServer; controller: RecordingController }[] = []
function connect(overrides: Partial<SidecarServerOptions> = {}) {
  const controller = new RecordingController()
  const server = new SidecarServer({
    sessionId: 'app-inline-test', engineSessionId: source.engineSessionId,
    controller, log: () => {}, ...overrides,
  })
  fixtures.push({ server, controller })
  const received: ServerFrame[] = []
  const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
  const socket = {
    write(data: Uint8Array) {
      for (const result of decoder.push(Buffer.from(data))) {
        if (result.kind === 'frame') received.push(result.payload as ServerFrame)
      }
    },
    end() {},
  }
  const connection = server.addConnection(socket)
  const snapshot = received.find(frame => frame.kind === 'inline-command.snapshot')!
  if (snapshot.kind !== 'inline-command.snapshot') throw new Error('Missing Run handshake')
  const generation = snapshot.generation
  const send = (message: unknown) => server.handleData(connection, encodeFrame({
    protocolVersion: PROTOCOL_VERSION, sessionId: 'app-inline-test', message,
  }))
  const start = (requestId = 'start', selected = source, currentGeneration = generation) => send({
    type: 'inline-command.start', requestId, generation: currentGeneration, source: selected,
  })
  return { server, controller, received, generation, send, start, socket }
}

async function settle(controller: RecordingController) {
  controller.release?.()
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

afterEach(() => {
  for (const { server, controller } of fixtures) { controller.release?.(); server.close() }
  fixtures.length = 0
  resetCommandQueue()
})

test('edit resets previews and replays retained results without losing the live Run identity or dedupe', async () => {
  const assistant = {
    type: 'assistant', uuid: '11111111-1111-4111-8111-111111111111',
    session_id: source.engineSessionId, parent_tool_use_id: null,
    message: { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: '```sh\nprintf hello\n```' }] },
  } as SDKMessage
  const result = (id: string, output: string): SDKMessage => ({
    type: 'user', uuid: id, session_id: source.engineSessionId, parent_tool_use_id: null,
    isSynthetic: true, message: { role: 'user', content: encodeInlineCommandResult({
      runId: id, source, command: 'printf hello', cwd: '/isolated',
      status: 'success', exitCode: 0, output,
    }) },
  } as SDKMessage)
  const retainedResult = result('22222222-2222-4222-8222-222222222222', 'retained-output')
  const removedResult = result('33333333-3333-4333-8333-333333333333', 'removed-output')
  const { received, controller, start, send, generation } = connect({
    history: [assistant, retainedResult, removedResult],
    projectHistory: async () => ({ history: [assistant, retainedResult], truncated: false }),
    sessionActions: {
      selectUserMessage: () => ({ ok: true, message: 'Selected.', selectedPrompt: { content: 'edit' } }),
      editFromMessage: async () => ({ ok: true, message: 'Edited.', retainedMessages: [] }),
      rename: async () => ({ ok: true, message: 'Renamed.' }),
      export: async () => ({ ok: true, message: 'Exported.' }),
      branch: async () => ({ ok: false, message: 'Unavailable.' }),
      branchFromMessage: async () => ({ ok: false, message: 'Unavailable.' }),
      tag: async () => ({ ok: true, message: 'Tagged.' }),
    },
  })
  start()
  await settle(controller)
  let state = received.reduce(projectServerFrame, createTranscriptState())
  expect(state.sessions['app-inline-test']!.inlineCommandResults).toHaveLength(2)
  const buffer = new FrameReplayBuffer()
  for (const frame of received) buffer.record(frame.sessionId, frame)
  received.length = 0
  send({ type: 'session.editFromMessage', requestId: 'edit', userMessageId: '11111111-1111-4111-8111-1' })
  for (let index = 0; index < 12; index++) await Promise.resolve()
  expect(received.find(frame => frame.kind === 'session-action.result')).toMatchObject({ ok: true })
  expect(received.some(frame => frame.kind === 'ready')).toBe(false)
  for (const frame of received) {
    state = projectServerFrame(state, frame)
    buffer.record(frame.sessionId, frame)
  }
  const session = state.sessions['app-inline-test']!
  expect(session.engineSessionId).toBe(source.engineSessionId)
  expect(session.inlineCommands).toMatchObject({
    generation, runs: [], requests: [{ requestId: 'start', status: 'completed' }],
  })
  expect(session.inlineCommandResults).toHaveLength(1)
  expect(session.inlineCommandResults![0]!.output).toBe('retained-output')
  expect(selectTranscriptRows(state, 'app-inline-test').some(row => row.kind === 'assistant-text' && row.inlineCommandOrigin)).toBe(true)
  const reloaded = buffer.snapshot().reduce(projectServerFrame, createTranscriptState())
  expect(reloaded.sessions['app-inline-test']!.inlineCommandResults).toEqual(session.inlineCommandResults)
  expect(JSON.stringify(buffer.snapshot())).not.toContain('removed-output')
  send({ type: 'inline-command.get', requestId: 'query-after-edit' })
  start()
  expect(controller.calls).toBe(1)
  expect(received.filter(frame => frame.kind === 'inline-command.snapshot').at(-1)).toMatchObject({ generation, runs: [] })
})

test('pending, completed and reconnected retries execute only once; Run again is explicit', async () => {
  const { server, controller, start, received, socket } = connect()
  start()
  start()
  expect(controller.calls).toBe(1)
  expect(received.filter(frame => frame.kind === 'inline-command.snapshot').at(-1)).toMatchObject({
    runs: [{ runId: 'owned-run', status: 'running', command: 'printf hello' }],
  })
  await settle(controller)
  start()
  expect(controller.calls).toBe(1)
  server.addConnection(socket)
  start()
  expect(controller.calls).toBe(1)
  start('deliberate-second-run')
  expect(controller.calls).toBe(2)
  await settle(controller)
})

test('forged executable payloads, stale generations and foreign sources cannot start', () => {
  const { controller, send, start, generation, received } = connect()
  send({ type: 'inline-command.start', requestId: 'forged', generation, source, command: 'touch /outside' })
  send({ type: 'inline-command.start', requestId: 'nested', generation, source: { ...source, cwd: '/outside' } })
  start('old-generation', source, 'earlier-process')
  start('foreign', { ...source, engineSessionId: 'other-engine' })
  expect(controller.calls).toBe(0)
  expect(received.filter(frame => frame.kind === 'error')).toHaveLength(4)
  expect(received.find(frame => frame.kind === 'error' && frame.requestId === 'old-generation')).toMatchObject({
    code: 'bad_request',
  })
})

test('a live operation refuses different starts without replacing its owner', async () => {
  const { controller, start, received } = connect()
  start()
  start('another-start')
  expect(controller.calls).toBe(1)
  expect(received.find(frame => frame.kind === 'error' && frame.requestId === 'another-start')).toMatchObject({
    code: 'turn_already_running',
  })
  await settle(controller)
})

test('Stop is generation-bound and resolves only the owned run', async () => {
  const { controller, start, send, generation, received } = connect()
  start()
  send({ type: 'inline-command.stop', requestId: 'old-stop', generation: 'old', runId: 'owned-run' })
  send({ type: 'inline-command.stop', requestId: 'foreign-stop', generation, runId: 'another-run' })
  expect(controller.stopped).toEqual([])
  expect(received.find(frame => frame.kind === 'error' && frame.requestId === 'old-stop')).toMatchObject({
    code: 'bad_request',
  })
  send({ type: 'inline-command.stop', requestId: 'stop', generation, runId: 'owned-run' })
  expect(controller.stopped).toEqual(['owned-run'])
  await settle(controller)
})

test('replacement sidecar rejects an earlier generation and never replays Start', () => {
  const first = connect()
  const replacement = connect()
  replacement.start('stale-start', source, first.generation)
  expect(replacement.controller.calls).toBe(0)
  replacement.send({ type: 'inline-command.get', requestId: 'read-current' })
  expect(replacement.received.filter(frame => frame.kind === 'inline-command.snapshot').at(-1)).toMatchObject({
    generation: replacement.generation, runs: [],
  })
})

test('closing cancels an admitted command even before its first output snapshot', () => {
  const { server, controller, start } = connect()
  controller.publishRun = false
  start()
  expect(controller.calls).toBe(1)
  server.close()
  expect(controller.aborts).toBe(1)
})

test('lost pre-progress rejection survives reattach, Get and retry without execution', async () => {
  const { server, controller, start, received, socket, send } = connect()
  controller.rejectBeforeProgress = true
  start()
  await settle(controller)
  expect(received.some(frame => frame.kind === 'error')).toBe(true)
  received.length = 0
  server.addConnection(socket)
  send({ type: 'inline-command.get', requestId: 'query-after-reattach' })
  start()
  const snapshots = received.filter(frame => frame.kind === 'inline-command.snapshot')
  expect(snapshots.length).toBeGreaterThanOrEqual(3)
  for (const snapshot of snapshots) expect(snapshot).toMatchObject({
    runs: [], requests: [{ requestId: 'start', source, status: 'rejected', error: 'The selected code block is no longer available.' }],
  })
  expect(controller.calls).toBe(1)
})

test('agent response failure remains queryable after shell completion', async () => {
  const { controller, start, received, send } = connect()
  controller.rejectAfterCompletion = true
  start()
  await settle(controller)
  send({ type: 'inline-command.get', requestId: 'read' })
  expect(received.filter(frame => frame.kind === 'inline-command.snapshot').at(-1)).toMatchObject({
    runs: [{ status: 'success' }],
    requests: [{ requestId: 'start', runId: 'owned-run', status: 'rejected', error: 'Agent response failed.' }],
  })
})

test('untrusted and unreadable workspace trust fail closed before shell admission', () => {
  for (const snapshot of [null, { trusted: false, detectedRepo: null, trustRoot: '/untrusted' }]) {
    const { controller, start, received } = connect({
      workspaceTrust: {
        getSnapshot: () => snapshot,
        acceptTrust: () => ({ ok: false, message: 'Not trusted.', changed: false }),
      },
    })
    start('untrusted-start')
    expect(controller.calls).toBe(0)
    expect(received.find(frame => frame.kind === 'error' && frame.requestId === 'untrusted-start'))
      .toMatchObject({ code: 'unauthorized' })
  }
})
