import { expect, test } from 'bun:test'
import type { CatCodeBridge, ServerFrame } from '../../shared/protocol.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import type { QuestionVerb } from '../../shared/nonblockingQuestions.js'
import { sendQuestionVerb } from './sendQuestionVerb.js'

const verb: QuestionVerb = { type: 'askUserQuestion.dismiss', requestId: 'dismiss-1', toolUseId: 'ask-1', questionIndex: 0 }
const receipt = (overrides: Partial<Extract<ServerFrame, { kind: 'question.result' }>> = {}): ServerFrame => ({
  kind: 'question.result', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1', requestId: verb.requestId, accepted: true, ...overrides,
})
function fixture(send?: (publish: (frames: ServerFrame[]) => void) => void) {
  let listener: ((frames: ServerFrame[]) => void) | undefined
  let unsubscribed = 0
  const publish = (frames: ServerFrame[]) => listener?.(frames)
  const bridge = {
    subscribe(callback: (frames: ServerFrame[]) => void) { listener = callback; return () => { listener = undefined; unsubscribed++ } },
    questionVerb() { send?.(publish) },
  } as unknown as CatCodeBridge
  return { bridge, publish, get unsubscribed() { return unsubscribed } }
}

test('subscribes before sending so an immediate durable receipt is not lost', async () => {
  const f = fixture(publish => publish([receipt()]))
  await sendQuestionVerb(f.bridge, 'session-1', verb)
  expect(f.unsubscribed).toBe(1)
})

test('unrelated session and request receipts cannot accept the pending reply', async () => {
  const f = fixture()
  let settled = false
  const pending = sendQuestionVerb(f.bridge, 'session-1', verb).then(() => { settled = true })
  f.publish([receipt({ sessionId: 'other-session' }), receipt({ requestId: 'other-request' })])
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.unsubscribed).toBe(0)
  f.publish([receipt()])
  await pending
  expect(settled).toBe(true)
  expect(f.unsubscribed).toBe(1)
})

test('a negative durable receipt rejects and releases the subscription for retry', async () => {
  const f = fixture(publish => publish([receipt({ accepted: false })]))
  await expect(sendQuestionVerb(f.bridge, 'session-1', verb)).rejects.toThrow('not accepted')
  expect(f.unsubscribed).toBe(1)
})

test('correlated sidecar errors retain their message and release the subscription', async () => {
  const f = fixture(publish => publish([{ kind: 'error', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1', requestId: verb.requestId,
    code: 'bad_request', message: 'Invalid question index', retryable: false }]))
  await expect(sendQuestionVerb(f.bridge, 'session-1', verb)).rejects.toThrow('Invalid question index')
  expect(f.unsubscribed).toBe(1)
})

test('a synchronous bridge failure releases the subscription', async () => {
  const f = fixture(() => { throw new Error('Bridge disconnected') })
  await expect(sendQuestionVerb(f.bridge, 'session-1', verb)).rejects.toThrow('Bridge disconnected')
  expect(f.unsubscribed).toBe(1)
})

test('a legacy bridge without question controls fails without subscribing', async () => {
  const f = fixture()
  delete f.bridge.questionVerb
  await expect(sendQuestionVerb(f.bridge, 'session-1', verb)).rejects.toThrow('unavailable')
  expect(f.unsubscribed).toBe(0)
})
