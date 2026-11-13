import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { loadTranscriptFile } from '../sessionStorage.js'
import { buildTranscriptForClassifier } from './yoloClassifier.js'
import {
  capturePriorAssistantContext,
  parsePriorAssistantContext,
  readAssistantProposal,
  MAX_PROPOSAL_CHARS,
} from './priorAssistantContext.js'

function assistant(text: string, uuid = 'proposal'): Message {
  return { type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } }
}

describe('submission-time proposal identity', () => {
  test('captures an immutable complete-text digest, not a live history reference', () => {
    const original = assistant('May I list windows?')
    const messages = [original]
    const binding = capturePriorAssistantContext(messages)
    expect(binding).toEqual(readAssistantProposal(original)?.binding)
    messages.push(assistant('May I close windows?', 'later'))
    expect(binding?.messageUuid).toBe('proposal')
    expect(binding).not.toEqual(capturePriorAssistantContext(messages))
    expect(readAssistantProposal(assistant('May I close windows?'))?.binding).not.toEqual(binding)
  })

  test('validates closed, bounded persisted bindings and never manufactures one for legacy input', () => {
    const valid = capturePriorAssistantContext([assistant('May I inspect?')])!
    expect(parsePriorAssistantContext(valid)).toEqual(valid)
    expect(parsePriorAssistantContext(valid)).not.toBe(valid)
    for (const invalid of [
      undefined, null, [], '', {},
      { ...valid, messageUuid: '' },
      { ...valid, messageUuid: 'x'.repeat(201) },
      { ...valid, textHash: 'no hash' },
      { ...valid, textHash: 'a'.repeat(65) },
      { ...valid, approved: true },
    ]) {
      expect(parsePriorAssistantContext(invalid)).toBeNull()
    }
  })

  test('captures through tool activity but not across a new user or injected turn', () => {
    const proposal = assistant('May I inspect?')
    const activity = [
      { type: 'assistant', uuid: 'tool', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'approved' }] } },
    ] as Message[]
    expect(capturePriorAssistantContext([proposal, ...activity])).toEqual(readAssistantProposal(proposal)?.binding)
    for (const boundary of [
      { type: 'user', message: { content: 'hello' } },
      { type: 'user', isMeta: true, message: { content: 'hello' } },
      { type: 'user', origin: { kind: 'peer' }, message: { content: 'hello' } },
      { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'attachment', attachment: { type: 'queued_command', prompt: 'Sure' } },
      { ...assistant('synthetic'), isApiErrorMessage: true },
    ] as Message[]) {
      expect(capturePriorAssistantContext([proposal, boundary])).toBeNull()
    }
  })

  test('missing identity and synthetic assistant content cannot become a proposal', () => {
    expect(readAssistantProposal(assistant('May I inspect?', ''))).toBeNull()
    expect(readAssistantProposal(assistant('   '))).toBeNull()
    expect(readAssistantProposal({ ...assistant('May I inspect?'), isInternalNoResponseSentinel: true } as Message)).toBeNull()
  })

  test('preserves full scope and Unicode rather than retaining only a tail', () => {
    const text = 'To: alice. Exclude live accounts. Approval only after review.\n' +
      'x'.repeat(2100) + '\u{1f600}' + 'y'.repeat(1999)
    const proposal = readAssistantProposal(assistant(text))!
    expect(proposal.text).toBe(text)
    expect(proposal.binding.textHash).toMatch(/^[a-f0-9]{64}$/)
    expect(readAssistantProposal(assistant(text.replace('alice', 'carol')))?.binding).not.toEqual(proposal.binding)
  })

  test('oversized proposals cannot supply partial scope or fall back to older prose', () => {
    const older = assistant('May I inspect?', 'older')
    expect(readAssistantProposal(assistant('x'.repeat(MAX_PROPOSAL_CHARS)))?.text.length).toBe(MAX_PROPOSAL_CHARS)
    const oversized = assistant('x'.repeat(MAX_PROPOSAL_CHARS + 1))
    expect(readAssistantProposal(oversized)).toBeNull()
    expect(capturePriorAssistantContext([older, oversized])).toBeNull()
  })

  test('restored user and queued-attachment records keep A rather than infer later B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-code-approval-binding-'))
    try {
      for (const queued of [false, true]) {
        const first = assistant('May I list windows, read-only?', randomUUID())
        const later = assistant('May I close all windows?', randomUUID())
        const priorAssistantContext = capturePriorAssistantContext([first])
        const reply = queued
          ? { type: 'attachment', uuid: randomUUID(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'Sure', priorAssistantContext } }
          : { type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'Sure' }, priorAssistantContext }
        const sessionId = randomUUID()
        let parentUuid: string | null = null
        const rows = [first, later, reply].map(message => {
          const row = { ...message, parentUuid, sessionId, cwd: root, version: 'fixture', isSidechain: false, timestamp: new Date().toISOString() }
          parentUuid = message.uuid
          return row
        })
        const path = join(root, `${queued ? 'queued' : 'direct'}.jsonl`)
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
        const loaded = await loadTranscriptFile(path, { strict: true })
        const rendered = buildTranscriptForClassifier(
          [...loaded.messages.values()], [], false, { priorAssistantContext: true },
        )
        expect(rendered).toBe('Assistant: May I list windows, read-only?\nUser: Sure\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
