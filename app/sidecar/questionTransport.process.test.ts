import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_FRAME_BYTES, MAX_QUESTION_REPLY_FRAME_BYTES } from '../shared/limits.js'
import { PROTOCOL_VERSION, type CatCodeBridge, type ServerFrame } from '../shared/protocol.js'
import { createRendererIpcGuard } from '../preload/rendererIpcGuard.js'
import { buildAskAnswerPayload } from '../renderer/src/askQuestionFlowModel.js'
import { sendQuestionVerb } from '../renderer/src/sendQuestionVerb.js'
import { questionReplyMessageSchema } from './nonblockingQuestionMessages.js'

function journal(root: string): any[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return journal(path)
    return entry.name.endsWith('.jsonl') ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  })
}
async function until(predicate: () => boolean, logs: string[]) {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Question transport timed out: ${logs.join('\n')}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('producer-backed cross-call close crosses preload, real supervisor/socket and sidecar with durable acceptance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'question-transport-'))
  const logs: string[] = []
  const frames: ServerFrame[] = []
  const supervisor = new SidecarSupervisor({
    sidecarCommand: process.execPath, sidecarArgs: ['--feature=NONBLOCKING_ASK_USER_QUESTION', join(import.meta.dir, 'questionTransport.fixture.ts')],
    sidecarCwd: root, socketDir: join(root, 'sock'), killGraceMs: 100,
    sidecarEnv: { HOME: root, XDG_CONFIG_HOME: root, CLAUDE_CONFIG_DIR: root, NODE_ENV: 'test', CLAUDE_CODE_SIMPLE: '1', TEST_ENABLE_SESSION_PERSISTENCE: '1' },
    log: line => logs.push(line),
  })
  supervisor.subscribe((event: SupervisorEvent) => { if (event.type === 'frame') frames.push(event.frame) })
  const result = (id: string) => frames.find(frame => 'requestId' in frame && frame.requestId === id)
  try {
    supervisor.spawnSession('question-transport')
    await until(() => frames.some(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot' && frame.event.snapshot.pending.length === 9), logs)
    const snapshot = frames.findLast(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot')!
    if (snapshot.kind !== 'event' || snapshot.event.type !== 'question.snapshot') throw new Error('Missing snapshot')
    const pending = snapshot.event.snapshot.pending
    expect(new Set(pending.map(q => q.toolUseId)).size).toBe(9)
    const message = {
      type: 'askUserQuestion.reply' as const, requestId: 'cross-call-close',
      replies: pending.map(q => ({ toolUseId: q.toolUseId, questionIndex: q.questionIndex,
        answer: buildAskAnswerPayload([{ optionIndices: [0, 1, 2, 3], other: '界'.repeat(4097), notes: { 0: 'x'.repeat(4096), 1: 'x'.repeat(4096), 2: 'x'.repeat(4096), 3: 'x'.repeat(20000) } }])[0]!,
      })),
    }
    expect(questionReplyMessageSchema.parse(message)).toEqual(message)
    const wire = encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'question-transport', message })
    expect(wire.byteLength - 4).toBeGreaterThan(MAX_FRAME_BYTES)
    expect(wire.byteLength - 4).toBeLessThan(MAX_QUESTION_REPLY_FRAME_BYTES)
    // These producer-backed bytes cannot fit the unchanged ordinary control allowance.
    expect(new FrameDecoder(MAX_FRAME_BYTES).push(wire)[0]?.kind).toBe('error')
    const guard = createRendererIpcGuard()
    const payload = { sessionId: 'question-transport', verb: message }
    expect(() => guard.assertAllowed(payload)).toThrow()
    guard.assertAllowed(payload, 'question-reply')
    supervisor.send('question-transport', { ...message, requestId: 'unknown-reference', replies: [{ ...message.replies[0]!, toolUseId: 'not-pending' }] })
    await until(() => Boolean(result('unknown-reference')), logs)
    expect(result('unknown-reference')).toMatchObject({ kind: 'question.result', accepted: false })
    supervisor.send('question-transport', { ...message, requestId: 'unknown-field', forged: true } as never)
    await until(() => Boolean(result('unknown-field')), logs)
    expect(result('unknown-field')).toMatchObject({ kind: 'error', code: 'bad_request' })
    expect(journal(root).filter(entry => entry.type === 'question-lifecycle' && entry.operation === 'resolved')).toHaveLength(0)
    const bridge = {
      subscribe(listener: (frames: ServerFrame[]) => void) {
        return supervisor.subscribe(event => { if (event.type === 'frame') listener([event.frame]) })
      },
      questionVerb(sessionId, verb) {
        guard.assertAllowed({ sessionId, verb }, verb.type === 'askUserQuestion.reply' ? 'question-reply' : 'control')
        supervisor.send(sessionId, verb)
      },
    } as Pick<CatCodeBridge, 'subscribe' | 'questionVerb'>
    await sendQuestionVerb(bridge as CatCodeBridge, 'question-transport', message)
    expect(result(message.requestId)).toMatchObject({ kind: 'question.result', accepted: true })
    // Read disk immediately on acknowledgement: one atomic lifecycle/outbox record, all real references.
    const committed = journal(root).filter(entry => entry.type === 'question-lifecycle' && entry.operation === 'resolved')
    expect(committed).toHaveLength(1)
    expect(committed[0].resolutions).toHaveLength(9)
    expect(committed[0].delivery).toMatchObject({ batchId: message.requestId })
    expect(committed[0].delivery.questions).toHaveLength(9)
    expect(JSON.parse(committed[0].delivery.content)).toHaveLength(9)
    expect(committed[0].resolutions.map((q: any) => q.toolUseId)).toEqual(pending.map(q => q.toolUseId))
    expect(committed[0].resolutions.every((q: any) => q.notes.endsWith(`Storage 3: ${'x'.repeat(20000)}`))).toBe(true)
    await until(() => frames.some(frame => frame.kind === 'event' && frame.event.type === 'question.snapshot' &&
      frame.event.snapshot.pending.length === 0 && frame.event.snapshot.resolved.length === 9), logs)
    supervisor.send('question-transport', message)
    await until(() => frames.filter(frame => frame.kind === 'question.result' && frame.requestId === message.requestId).length === 2, logs)
    expect(journal(root).filter(entry => entry.type === 'question-lifecycle' && entry.operation === 'resolved')).toHaveLength(1)
  } finally {
    await supervisor.stopSession('question-transport')
    supervisor.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
}, 25000)
