import { describe, expect, test } from 'bun:test'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { deriveTranscriptOutline } from './transcriptOutlineModel.js'

function row(kind: string, id: string, content = '', extra: Record<string, unknown> = {}): NestedTranscriptRow {
  return { kind, id, frameId: id, sessionId: 'session', messageId: id, blockIndex: 0,
    parentToolUseId: null, children: [], role: kind === 'user-text' ? 'user' : 'assistant',
    isReplay: false, content, ...extra } as NestedTranscriptRow
}
const prompt = (id: string, content = id, extra = {}) => row('user-text', id, content, extra)
const answer = (id: string, content = id, extra = {}) => row('assistant-text', id, content, extra)

describe('deriveTranscriptOutline', () => {
  test('deduplicates frame blocks and images without mutating rows', () => {
    const rows = [prompt('p', 'First'), prompt('block', 'First', { frameId: 'p' }),
      row('user-image', 'image', '', { frameId: 'p' }), prompt('more', 'Second', { frameId: 'p' }), answer('a')]
    const before = JSON.stringify(rows)
    expect(deriveTranscriptOutline(rows)).toEqual([
      { id: '["session","p"]', rowKey: 'p', prompt: 'First Second', answer: 'a' },
    ])
    expect(JSON.stringify(rows)).toBe(before)
  })

  test('excludes hidden, nested, synthetic, notices and question replies', () => {
    const rows = [prompt('real'), row('thinking', 'thought', 'private'),
      row('tool-use', 'tool', 'secret', { children: [prompt('child'), answer('child-answer')] }),
      prompt('nested', 'worker', { parentToolUseId: 'tool' }), answer('worker', 'worker', { agentName: 'worker' }),
      prompt('hidden', 'hidden', { isHidden: true }), row('injected-turn', 'injected'),
      row('task-notification', 'notice'), row('question-reply', 'question'),
      row('user-image', 'injected-image', '', { frameId: 'injected' }), answer('a', 'Visible')]
    expect(deriveTranscriptOutline(rows).map(entry => [entry.prompt, entry.answer])).toEqual([['real', 'Visible']])
  })

  test('owns answers only until the next prompt and prefers final phase', () => {
    expect(deriveTranscriptOutline([
      answer('orphan'), prompt('p1'), answer('comment', 'Working', { phase: 'commentary' }),
      answer('final', 'Finished', { phase: 'final_answer' }), prompt('p2'), prompt('p3'),
      answer('first', 'First fallback'), answer('later', 'Later fallback'), prompt('p4'),
    ]).map(entry => entry.answer)).toEqual(['Finished', '', 'First fallback', ''])
  })

  test('identity survives prepended history and streamed answers', () => {
    const initial = deriveTranscriptOutline([prompt('p')])[0]!
    const updated = deriveTranscriptOutline([prompt('old'), answer('old-answer'), prompt('p'), answer('stream', 'Partial', { isStreaming: true })])[1]!
    expect(updated.id).toBe(initial.id)
    expect(updated.rowKey).toBe(initial.rowKey)
    expect(updated.answer).toBe('Partial')
  })

  test('image-only prompts address actual lone and grouped renderer items', () => {
    const image = (id: string, frameId: string) => row('user-image', id, '', { frameId })
    expect(deriveTranscriptOutline([image('one', 'first'), answer('a'), image('two', 'second'), image('three', 'second')])
      .map(entry => [entry.rowKey, entry.prompt])).toEqual([
        ['one', 'Image attachment'], ['user-images:two', 'Image attachment'],
      ])
  })

  test('operator command echoes use parsed command fields, not their envelope', () => {
    expect(deriveTranscriptOutline([row('command-echo', 'cmd', '<command-message>unsafe</command-message>',
      { commandName: 'review', args: 'changes', skillFormat: false }), answer('a')])[0]!.prompt).toBe('/review changes')
  })

  test('answers keep Markdown line structure while prompts stay on one line', () => {
    const entry = deriveTranscriptOutline([prompt('p', 'Two\nlines'), answer('a', '\n## Plan\n\n- one\n- two\n')])[0]!
    expect(entry.prompt).toBe('Two lines')
    expect(entry.answer).toBe('## Plan\n\n- one\n- two')
  })

  test('huge unsafe-looking input stays bounded inert text', () => {
    const unsafe = '<script>alert(1)</script> **[link](javascript:bad)** ``` ' + 'x'.repeat(100_000)
    const entry = deriveTranscriptOutline([prompt('p', unsafe), answer('a', unsafe)])[0]!
    expect(entry.prompt.length).toBeLessThanOrEqual(240)
    expect(entry.answer.length).toBeLessThanOrEqual(240)
    expect(entry.prompt.startsWith('<script>alert(1)</script>')).toBe(true)
  })
})
