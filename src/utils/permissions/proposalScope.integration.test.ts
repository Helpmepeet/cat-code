import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { AppSessionController } from '../../app-runtime/AppSessionController.js'
import { appClientMessageSchema } from '../../app-runtime/appSessionProtocol.js'
import { buildTranscriptEntries, buildTranscriptForClassifier } from './yoloClassifier.js'
import { capturePriorAssistantContext, MAX_PROPOSAL_CHARS } from './priorAssistantContext.js'

const scope = 'Recipient: alice@example.test. Target: staging only. Exclude production. Send only after review.\n' +
  'Details '.repeat(500) + '\nTail: keep the caveat.'
function assistant(text = scope, uuid = 'proposal'): Message {
  return { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } } as Message
}
function reply(proposal: Message): Message {
  return { type: 'user', uuid: 'reply', message: { content: 'Sure' },
    priorAssistantContext: capturePriorAssistantContext([proposal]) } as Message
}
function render(messages: Message[]) {
  return buildTranscriptForClassifier(messages, [], false, { priorAssistantContext: true })
}

test('desktop displayed full scope passes closed submission schema and engine verification into checker', () => {
  const proposal = assistant()
  const controller = new AppSessionController({ getMessages: () => [proposal], async *runTurn() {} })
  const observedProposal = { messageUuid: proposal.uuid, text: scope }
  expect(appClientMessageSchema.safeParse({ type: 'app.submit', requestId: 'r', prompt: 'Sure', options: { observedProposal } }).success).toBe(true)
  const binding = controller.bindObservedProposal(observedProposal)
  expect(binding).toEqual(capturePriorAssistantContext([proposal]))
  expect(controller.bindObservedProposal({ ...observedProposal, text: scope.slice(-2000) })).toBeNull()
  const humanReply = { ...reply(proposal), priorAssistantContext: binding } as Message
  expect(buildTranscriptEntries([proposal, humanReply], false, { priorAssistantContext: true })[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: scope }] })
  expect(render([proposal, humanReply])).toBe(`Assistant: ${JSON.stringify(scope)}\nUser: Sure\n`)
})

test('unchanged tail cannot reuse binding after recipient, target, exclusion or condition changes', () => {
  const original = assistant()
  const humanReply = reply(original)
  for (const [from, to] of [['alice', 'carol'], ['staging', 'production'], ['Exclude production', 'Include production'], ['after review', 'without review']]) {
    const changed = assistant(scope.replace(from!, to!))
    expect(render([changed, humanReply])).toBe('User: Sure\n')
    expect(render([original, changed, original, humanReply])).toBe('User: Sure\n')
  }
  expect(render([assistant(scope, 'different-uuid'), humanReply])).toBe('User: Sure\n')
  const legacy = { ...humanReply, priorAssistantContext: {
    messageUuid: original.uuid,
    textHash: createHash('sha256').update(scope.slice(-2000)).digest('hex'),
  } } as Message
  expect(render([original, legacy])).toBe('User: Sure\n')
})

test('queue and ordinary serialized resume preserve submission binding, not later output', () => {
  const proposal = assistant()
  const later = assistant('Send to somebody else?', 'later')
  const queued = { type: 'attachment', uuid: 'queue', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'Sure', priorAssistantContext: capturePriorAssistantContext([proposal]) } } as Message
  for (const humanReply of [reply(proposal), queued]) {
    const restored = JSON.parse(JSON.stringify([proposal, later, humanReply])) as Message[]
    expect(render(restored)).toContain('Recipient: alice@example.test.')
    expect(render(restored)).not.toContain('somebody else')
  }
})

test('clarification binds only the latest prose, never arbitrarily approves an older proposal', () => {
  const proposal = assistant()
  const question = { type: 'user', uuid: 'clarification', message: { content: 'Does that include production?' } } as Message
  const clarification = assistant('No, staging only.', 'clarification-answer')
  const humanReply = reply(clarification)
  expect(capturePriorAssistantContext([proposal, question, clarification])).toEqual(capturePriorAssistantContext([clarification]))
  expect(render([proposal, question, clarification, humanReply])).toBe('User: Does that include production?\nAssistant: No, staging only.\nUser: Sure\n')
})

test('missing proposal, compaction boundaries and oversized proposals fail closed', () => {
  const proposal = assistant()
  const humanReply = reply(proposal)
  expect(render([humanReply])).toBe('User: Sure\n')
  expect(render([proposal, { type: 'system', subtype: 'compact_boundary' } as Message, humanReply])).toBe('User: Sure\n')
  const oversized = assistant('Recipient: hidden.\n' + 'x'.repeat(MAX_PROPOSAL_CHARS))
  expect(capturePriorAssistantContext([proposal, oversized])).toBeNull()
  expect(render([oversized, humanReply])).toBe('User: Sure\n')
  expect(render([proposal, humanReply])).toContain('Recipient: alice@example.test.')
})
