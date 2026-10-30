import { describe, expect, test } from 'bun:test'
import { PendingQuestionRegistry, questionReplyBatchSchema, type QuestionJournalEntry, type PendingQuestionSpec } from './pendingQuestions.js'

const question: PendingQuestionSpec = {
  question: 'Which storage?', multiSelect: false,
  options: [{ label: 'Local', description: 'On disk', preview: '<div>local</div>' }, { label: 'Remote', description: 'On server' }],
}
const pick = (toolUseId = 'call-1', questionIndex = 0, optionIndices = [0]) => ({ toolUseId, questionIndex, answer: { optionIndices } })
function fixture() {
  const journal: QuestionJournalEntry[] = []
  const registry = new PendingQuestionRegistry(async entry => { journal.push(structuredClone(entry)) })
  return { journal, registry }
}

describe('nonblocking per-question durable outbox', () => {
  test('owner fencing also rejects cached receipts and idempotent asks without another write', async () => {
    let current = true
    const journal: QuestionJournalEntry[] = []
    const registry = new PendingQuestionRegistry(async entry => { journal.push(structuredClone(entry)) }, undefined, () => {
      if (!current) throw new Error('Question owner changed')
    })
    await registry.ask('call-1', 'assistant-1', [question, question])
    const batch = { requestId: 'answered', replies: [pick()] }
    const dismissal = { requestId: 'dismissed', toolUseId: 'call-1', questionIndex: 1 }
    await registry.reply(batch)
    await registry.dismiss(dismissal)
    current = false
    await expect(registry.reply(batch)).rejects.toThrow('owner changed')
    await expect(registry.dismiss(dismissal)).rejects.toThrow('owner changed')
    await expect(registry.ask('call-1', 'assistant-1', [question, question])).rejects.toThrow('owner changed')
    expect(journal).toHaveLength(3)
    expect(registry.needsRecovery()).toBe(false)
  })
  test('partially answers a call and combines multiple calls into one next-turn input', async () => {
    const { registry } = fixture()
    await registry.ask('call-1', 'assistant-1', [question, { ...question, question: 'What name?', options: [] }])
    await registry.ask('call-2', 'assistant-2', [question])
    const delivery = await registry.reply({ requestId: 'close-1', replies: [pick(), pick('call-2')] })
    expect(delivery.questions).toEqual([{ toolUseId: 'call-1', questionIndex: 0 }, { toolUseId: 'call-2', questionIndex: 0 }])
    expect(JSON.parse(delivery.content)).toHaveLength(2)
    expect(registry.getSnapshot().pending.map(q => [q.toolUseId, q.questionIndex])).toEqual([['call-1', 1]])
    expect(registry.undelivered(new Set())).toEqual([delivery])
    expect(registry.undelivered(new Set([delivery.uuid]))).toEqual([])
  })

  test('exact retry returns one durable delivery; conflicting reuse and double answer fail', async () => {
    const { registry, journal } = fixture()
    await registry.ask('call-1', 'assistant-1', [question])
    const batch = { requestId: 'close-1', replies: [pick()] }
    const first = await registry.reply(batch)
    expect(await registry.reply(batch)).toEqual(first)
    expect(journal).toHaveLength(2)
    await expect(registry.reply({ ...batch, replies: [pick('call-1', 0, [1])] })).rejects.toThrow('reused')
    await expect(registry.reply({ ...batch, requestId: 'close-2' })).rejects.toThrow('not pending')
  })

  test('reply versus dismiss is serialized, and dismissal is silent', async () => {
    const { registry } = fixture()
    await registry.ask('call-1', 'assistant-1', [question, question])
    const results = await Promise.allSettled([
      registry.dismiss({ requestId: 'dismiss-1', toolUseId: 'call-1', questionIndex: 0 }),
      registry.reply({ requestId: 'close-1', replies: [pick()] }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(registry.undelivered(new Set())).toEqual([])
    expect(registry.getSnapshot().resolved[0]?.state).toBe('dismissed')
    expect(registry.getSnapshot().pending[0]?.questionIndex).toBe(1)
    await registry.dismiss({ requestId: 'dismiss-1', toolUseId: 'call-1', questionIndex: 0 })
  })

  test('restore after crash keeps unanswered questions, silent dismissals and pending deliveries', async () => {
    const { registry, journal } = fixture()
    await registry.ask('call-1', 'assistant-1', [question, question, question])
    const delivery = await registry.reply({ requestId: 'close-1', replies: [pick()] })
    await registry.dismiss({ requestId: 'dismiss-1', toolUseId: 'call-1', questionIndex: 1 })
    const restored = new PendingQuestionRegistry(async () => {})
    restored.restore(journal, new Set(['call-1']))
    expect(restored.getSnapshot()).toEqual(registry.getSnapshot())
    expect(restored.undelivered(new Set())).toEqual([delivery])
    expect(await restored.reply({ requestId: 'close-1', replies: [pick()] })).toEqual(delivery)
    await restored.reply({ requestId: 'close-2', replies: [pick('call-1', 2)] })
    expect(restored.getSnapshot().pending).toHaveLength(0)
  })

  test('rewind/clear drops calls no longer in the full active conversation', async () => {
    const { registry, journal } = fixture()
    await registry.ask('call-1', 'assistant-1', [question])
    await registry.ask('call-2', 'assistant-2', [question])
    await registry.reply({ requestId: 'close-1', replies: [pick('call-2')] })
    registry.restore(journal, new Set(['call-1']))
    expect(registry.getSnapshot().pending.map(q => q.toolUseId)).toEqual(['call-1'])
    expect(registry.undelivered(new Set())).toEqual([])
    registry.restore(journal, new Set())
    expect(registry.getSnapshot()).toEqual({ pending: [], resolved: [] })
  })

  test('failed persistence never publishes acceptance or removes picks', async () => {
    let fail = false
    const registry = new PendingQuestionRegistry(async () => { if (fail) throw new Error('disk full') })
    await registry.ask('call-1', 'assistant-1', [question])
    const changes: unknown[] = []
    registry.subscribe(() => changes.push(registry.getSnapshot()))
    fail = true
    await expect(registry.reply({ requestId: 'close-1', replies: [pick()] })).rejects.toThrow('disk full')
    expect(registry.getSnapshot().pending).toHaveLength(1)
    expect(changes).toHaveLength(0)
    fail = false
    await expect(registry.reply({ requestId: 'close-1', replies: [pick()] })).rejects.toThrow('recovery')
    registry.restore([{ type: 'question-lifecycle', version: 1, operation: 'asked', toolUseId: 'call-1', sourceMessageUuid: 'assistant-1', questions: [question] }], new Set(['call-1']))
    changes.length = 0
    await registry.reply({ requestId: 'close-1', replies: [pick()] })
    expect(changes).toHaveLength(1)
  })

  test('validates whole batch before mutation, rejects invented calls, labels and notes', async () => {
    const { registry, journal } = fixture()
    await registry.ask('call-1', 'assistant-1', [question])
    for (const replies of [
      [pick(), pick('invented')], [pick(), pick()], [pick('call-1', 0, [2])],
      [pick('call-1', 0, [0, 1])], [pick('call-1', 0, [0, 0])],
      [{ ...pick(), answer: { optionIndices: [0], notes: [{ optionIndex: 1, text: 'invented' }] } }],
    ]) await expect(registry.reply({ requestId: 'invalid', replies })).rejects.toThrow()
    expect(questionReplyBatchSchema.safeParse({ requestId: 'bad', replies: [{ ...pick(), question: 'forged' }] }).success).toBe(false)
    expect(questionReplyBatchSchema.safeParse({ requestId: 'bad', replies: [{ ...pick(), answer: { optionIndices: [0], label: 'forged' } }] }).success).toBe(false)
    expect(journal).toHaveLength(1)
    expect(registry.getSnapshot().pending).toHaveLength(1)
  })

  test('an ambiguous append failure fences new request ids until journal recovery, so one question cannot be delivered twice', async () => {
    const journal: QuestionJournalEntry[] = []
    let failResolved = true
    const registry = new PendingQuestionRegistry(async entry => {
      journal.push(structuredClone(entry))
      if (entry.operation === 'resolved' && failResolved) throw new Error('sync failed after append')
    })
    await registry.ask('call-1', 'assistant-1', [question])
    await expect(registry.reply({ requestId: 'first', replies: [pick()] })).rejects.toThrow('sync failed')
    await expect(registry.reply({ requestId: 'second', replies: [pick()] })).rejects.toThrow('recovery')
    expect(journal).toHaveLength(2)
    failResolved = false
    registry.restore(journal, new Set(['call-1']))
    await expect(registry.reply({ requestId: 'second', replies: [pick()] })).rejects.toThrow('not pending')
    expect(registry.undelivered(new Set())).toHaveLength(1)
    expect(await registry.reply({ requestId: 'first', replies: [pick()] })).toEqual(registry.undelivered(new Set())[0]!)
  })

  test('active source identity prevents a recycled tool id from reopening an inactive question', async () => {
    const { registry, journal } = fixture()
    await registry.ask('call-1', 'old-source', [question])
    registry.restore(journal, new Set(['call-1']), false, new Map([['call-1', 'new-source']]))
    expect(registry.getSnapshot().pending).toEqual([])
    await registry.ask('call-1', 'new-source', [question])
    expect(registry.getSnapshot().pending[0]?.sourceMessageUuid).toBe('new-source')
    await expect(registry.ask('call-1', 'different-source', [question])).rejects.toThrow('reused')
  })

  test('multi-select, notes, Other and free text use engine-owned question/labels', async () => {
    const { registry } = fixture()
    await registry.ask('call-1', 'assistant-1', [{ ...question, multiSelect: true }, { ...question, options: [] }])
    const delivery = await registry.reply({ requestId: 'close-1', replies: [
      { ...pick(), answer: { optionIndices: [1, 0], other: ' Custom ', notes: [{ optionIndex: 1, text: ' only later ' }] } },
      { ...pick('call-1', 1), answer: { optionIndices: [], other: ' Name ' } },
    ] })
    const answers = JSON.parse(delivery.content)
    expect(answers[0]).toMatchObject({ question: question.question, answer: 'Local, Remote, Custom', notes: 'Remote: only later' })
    expect(answers[1].answer).toBe('Name')
  })

  test('ask publication budget rejects before persistence, notification or turn mutation', async () => {
    const journal: QuestionJournalEntry[] = []
    const registry = new PendingQuestionRegistry(async entry => { journal.push(structuredClone(entry)) }, 1024)
    let notifications = 0
    registry.subscribe(() => { notifications++ })
    const before = registry.getSnapshot()
    // Use multibyte content to exercise bytes, not JavaScript string length.
    await expect(registry.ask('oversized', 'assistant-1', [{
      ...question, question: '界'.repeat(400),
    }])).rejects.toThrow('publication budget')
    expect(registry.getSnapshot()).toBe(before)
    expect(registry.displayReferences([{ toolUseId: 'oversized', questionIndex: 0 }])).toHaveLength(1)
    expect(journal).toEqual([])
    expect(notifications).toBe(0)
    expect(registry.needsRecovery()).toBe(false)
    // A rejected call has not reserved the ID or poisoned the write lane.
    await registry.ask('oversized', 'assistant-1', [question])
    expect(journal).toHaveLength(1)
    expect(notifications).toBe(1)
  })

  test('resolution publication budget checks the whole batch before committing any answer', async () => {
    const journal: QuestionJournalEntry[] = []
    const registry = new PendingQuestionRegistry(async entry => { journal.push(structuredClone(entry)) }, 1024)
    await registry.ask('call-1', 'assistant-1', [question, question])
    const before = registry.getSnapshot()
    let notifications = 0
    registry.subscribe(() => { notifications++ })
    await expect(registry.reply({ requestId: 'budget', replies: [
      pick(), { ...pick('call-1', 1), answer: { optionIndices: [], other: '界'.repeat(400) } },
    ] })).rejects.toThrow('publication budget')
    expect(registry.getSnapshot()).toBe(before)
    expect(journal).toHaveLength(1)
    expect(notifications).toBe(0)
    expect(registry.undelivered(new Set())).toEqual([])
    expect(registry.needsRecovery()).toBe(false)
    // Neither the request ID nor the first pick was consumed.
    await registry.reply({ requestId: 'budget', replies: [pick()] })
    expect(journal).toHaveLength(2)
    expect(registry.getSnapshot().pending).toHaveLength(1)
  })

  test('resolved publication is narrow while private recovery and delivery retain the selected preview', async () => {
    const { registry, journal } = fixture()
    const preview = '界'.repeat(2048)
    const spec = { ...question, options: [{ ...question.options[0]!, preview }, question.options[1]!] }
    await registry.ask('call-1', 'assistant-1', [spec, spec])
    const batch = { requestId: 'answer', replies: [pick()] }
    const delivery = await registry.reply(batch)
    await registry.dismiss({ requestId: 'dismiss', toolUseId: 'call-1', questionIndex: 1 })
    for (const resolved of registry.getSnapshot().resolved) {
      expect(resolved).not.toHaveProperty('options')
      expect(resolved).not.toHaveProperty('multiSelect')
      expect(resolved).not.toHaveProperty('selectedPreview')
    }
    const entry = journal[1]!
    expect(entry.operation).toBe('resolved')
    if (entry.operation !== 'resolved') throw new Error('Expected resolution')
    expect(entry.resolutions[0]).toMatchObject({ options: spec.options, multiSelect: false, selectedPreview: preview })
    expect(JSON.parse(delivery.content)[0].selectedPreview).toBe(preview)
    const restored = new PendingQuestionRegistry(async () => { throw new Error('Retry must not append') })
    restored.restore(journal, new Set(['call-1']))
    expect(restored.getSnapshot()).toEqual(registry.getSnapshot())
    expect(await restored.reply(batch)).toEqual(delivery)
    expect(restored.undelivered(new Set())).toEqual([delivery])
    await restored.ask('call-1', 'assistant-1', [spec, spec])
    await expect(restored.ask('call-1', 'assistant-1', [question, question])).rejects.toThrow('reused')
  })

  test.each(['asked', 'dismissed'] as const)('ambiguous %s writes publish nothing and recover idempotently', async operation => {
    const journal: QuestionJournalEntry[] = []
    let fail = operation === 'asked'
    const registry = new PendingQuestionRegistry(async entry => {
      journal.push(structuredClone(entry))
      if (fail) throw new Error('sync failed after append')
    })
    if (operation === 'dismissed') await registry.ask('call-1', 'assistant-1', [question])
    fail = true
    const before = registry.getSnapshot()
    let notifications = 0
    registry.subscribe(() => { notifications++ })
    const write = () => operation === 'asked'
      ? registry.ask('call-1', 'assistant-1', [question])
      : registry.dismiss({ requestId: 'dismiss', toolUseId: 'call-1', questionIndex: 0 })
    await expect(write()).rejects.toThrow('sync failed')
    expect(registry.getSnapshot()).toBe(before)
    expect(notifications).toBe(0)
    expect(registry.needsRecovery()).toBe(true)
    const count = journal.length
    await expect(registry.ask('call-2', 'assistant-2', [question])).rejects.toThrow('recovery')
    expect(journal).toHaveLength(count)
    registry.restore(journal, new Set(['call-1']))
    fail = false
    await write()
    expect(journal).toHaveLength(count)
    expect(registry.needsRecovery()).toBe(false)
    expect(registry.undelivered(new Set())).toEqual([])
    if (operation === 'dismissed') {
      await expect(registry.reply({ requestId: 'dismiss', replies: [pick()] })).rejects.toThrow('reused')
    }
  })
})
