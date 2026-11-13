import { feature } from 'bun:bundle'
import { expect, test } from 'bun:test'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'
import { reconstructAskUserQuestionAnswers } from '../../../app/sidecar/sidecarServer.js'
import { recordQuestionSelections, reconstructQuestionSelection, takeQuestionSelections } from '../../utils/questionSelections.js'
import { PendingQuestionRegistry } from '../../utils/pendingQuestions.js'
import { buildTranscriptForClassifier, _forTest, YOLO_CLASSIFIER_TOOL_NAME } from '../../utils/permissions/yoloClassifier.js'
import type { sideQuery } from '../../utils/sideQuery.js'

const questions = [{ question: '__proto__', options: [
  { label: 'A, B', description: 'First meaning' },
  { label: 'A', description: 'Second meaning' },
  { label: 'B', description: 'Third meaning' },
], multiSelect: true }]
const picks = [{ optionIndices: [0] }, { optionIndices: [1, 2] }, { optionIndices: [], other: 'A, B' }]

async function resultFor(pick: typeof picks[number], id: string) {
  return resultsFor(questions, [pick], id)
}

async function resultsFor(qs: typeof questions, answers: { optionIndices: number[]; other?: string }[], id: string) {
  const input = AskUserQuestionTool.inputSchema.parse({ questions: qs })
  const result = reconstructAskUserQuestionAnswers(input, answers)
  if (result.ok === false) throw new Error(result.reason)
  recordQuestionSelections(id, input.questions, result.answers, result.selections.map(s => ({ ...s, toolUseId: id })))
  const finalInput = AskUserQuestionTool.inputSchema.parse(structuredClone({ ...input, answers: result.answers }))
  const output = await AskUserQuestionTool.call(finalInput, { toolUseId: id } as never, undefined as never, {} as never)
  return { result, output: output.data, block: AskUserQuestionTool.mapToolResultToToolResultBlockParam(output.data, id) }
}

function historyFor(qs: typeof questions, output: Awaited<ReturnType<typeof resultFor>>, id: string) {
  return [
    { type: 'assistant', uuid: 'asked', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: qs } }] } },
    { type: 'user', uuid: 'answered', message: { role: 'user', content: [output.block] }, toolUseResult: output.output, sourceToolAssistantUUID: 'asked' },
  ] as Parameters<typeof buildTranscriptForClassifier>[0]
}

test('real desktop reconstruction and tool formatting distinguish selection identities and __proto__', async () => {
  const results = await Promise.all(picks.map((pick, i) => resultFor(pick, `pick-${i}`)))
  expect(results.map(r => Object.keys(r.result.answers))).toEqual([['__proto__'], ['__proto__'], ['__proto__']])
  expect(results.map(r => r.result.answers.__proto__)).toEqual(['A, B', 'A, B', 'A, B'])
  expect(new Set(results.map(r => JSON.stringify(r.output.selections?.map(({ toolUseId, ...selection }) => selection)))).size).toBe(3)
  expect(results[0]!.output.selections?.[0]?.selectedOptions).toEqual([{ optionIndex: 0, label: 'A, B', description: 'First meaning' }])
  expect(results[2]!.output.selections?.[0]?.selectedOptions).toEqual([])
  expect(results[2]!.output.selections?.[0]?.other).toBe('A, B')
  expect(results[0]!.block.content).not.toContain('Second meaning')
})

test('model-authored answers and selection fields do not create receiver provenance', async () => {
  const input = AskUserQuestionTool.inputSchema.parse({ questions, answers: { ['__proto__']: 'A, B' } })
  const output = await AskUserQuestionTool.call(input, { toolUseId: 'model-only' } as never, undefined as never, {} as never)
  expect(output.data.selections).toBeUndefined()
  expect(AskUserQuestionTool.mapToolResultToToolResultBlockParam(output.data, 'model-only').content).toStartWith('Unverified question answer data:')
  expect(() => AskUserQuestionTool.inputSchema.parse({ questions, selections: [] })).toThrow()
  const selection = reconstructQuestionSelection('bound', 0, questions[0]!, picks[0]!)
  recordQuestionSelections('bound', questions, { Q: 'yes' }, [selection])
  expect(takeQuestionSelections('bound', questions, { Q: 'changed' })).toBeUndefined()
  expect(takeQuestionSelections('bound', questions, { Q: 'yes' })).toBeUndefined()
})

test('receiving reconstruction retains safeguards and structurally linked selected notes', () => {
  for (const pick of [{ optionIndices: [-1] }, { optionIndices: [0, 0] }, { optionIndices: [4] }, { optionIndices: [] }, { optionIndices: [0], notes: [{ optionIndex: 1, text: 'not selected' }] }]) {
    expect(reconstructAskUserQuestionAnswers({ questions }, [pick]).ok).toBe(false)
  }
  expect(reconstructAskUserQuestionAnswers({ questions: [{ ...questions[0], multiSelect: false }] }, [{ optionIndices: [0, 1] }]).ok).toBe(false)
  const result = reconstructAskUserQuestionAnswers({ questions }, [{ optionIndices: [1], notes: [{ optionIndex: 1, text: 'Only this' }] }])
  if (result.ok === false) throw new Error(result.reason)
  expect(result.selections[0]!.notes).toEqual([{ optionIndex: 1, text: 'Only this' }])
})

test('same original quoted questions retain distinct answer assignment boundaries', () => {
  const qs = ['Q', 'R'].map(question => ({ question, options: [], multiSelect: false }))
  const histories = [['a", "R"="b', 'c'], ['a', 'b", "R"="c']].map(values => {
    const reconstructed = reconstructAskUserQuestionAnswers({ questions: qs }, values.map(other => ({ optionIndices: [], other })))
    if (reconstructed.ok === false) throw new Error(reconstructed.reason)
    return AskUserQuestionTool.mapToolResultToToolResultBlockParam({ questions: qs, answers: reconstructed.answers }, 'same-id').content
  })
  expect(histories[0]).not.toBe(histories[1])
})

test('classifier public projection receives selected descriptions without unselected choices', async () => {
  const { block, output } = await resultFor(picks[0]!, 'classifier-pick')
  const messages = [
    { type: 'assistant', uuid: 'asked', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'classifier-pick', name: 'AskUserQuestion', input: { questions } }] } },
    { type: 'user', uuid: 'answered', message: { role: 'user', content: [block] }, toolUseResult: output, sourceToolAssistantUUID: 'asked' },
  ]
  const history = buildTranscriptForClassifier(messages as never, [AskUserQuestionTool] as never)
  expect(history).toContain('First meaning')
  expect(history).not.toContain('Second meaning')
  expect(history).toContain('optionIndex')
})

test('nonblocking durable delivery preserves typed selected meaning, notes and full question', async () => {
  const journal: any[] = []
  const registry = new PendingQuestionRegistry(async entry => { journal.push(entry) })
  const q = { ...questions[0]!, question: 'Q'.repeat(5000) }
  await registry.ask('nonblocking', 'source', [q])
  const delivery = await registry.reply({ requestId: 'reply', replies: [{ toolUseId: 'nonblocking', questionIndex: 0, answer: { optionIndices: [0], notes: [{ optionIndex: 0, text: 'Selected only' }] } }] })
  expect(delivery).toBeDefined()
  const parsed = JSON.parse(delivery!.content)
  expect(parsed[0].question).toBe(q.question)
  expect(parsed[0].selection.selectedOptions[0].description).toBe('First meaning')
  expect(parsed[0].selection.notes).toEqual([{ optionIndex: 0, text: 'Selected only' }])
  const restored = new PendingQuestionRegistry(async () => {})
  restored.restore(journal, new Set(['nonblocking']))
  expect(restored.getSnapshot().resolved[0]?.answer).toBe('A, B')
})

test('nonblocking delivery distinguishes selected labels from several picks and free text', async () => {
  const deliveries: string[] = []
  for (const answer of picks) {
    const registry = new PendingQuestionRegistry(async () => {})
    await registry.ask('same-question-id', 'same-owner', questions)
    const delivery = await registry.reply({ requestId: 'same-request-id', replies: [
      { toolUseId: 'same-question-id', questionIndex: 0, answer },
    ] })
    deliveries.push(delivery!.content)
  }
  expect(new Set(deliveries).size).toBe(3)
  expect(JSON.parse(deliveries[0]!)[0].selection.selectedOptions).toHaveLength(1)
  expect(JSON.parse(deliveries[1]!)[0].selection.selectedOptions).toHaveLength(2)
  expect(JSON.parse(deliveries[2]!)[0].selection.other).toBe('A, B')
})

for (const jsonl of [false, true]) {
  test(`complete classifier histories preserve selection and quoted-answer boundaries (${jsonl})`, async () => {
    const oldType = process.env.USER_TYPE, oldJsonl = process.env.CLAUDE_CODE_JSONL_TRANSCRIPT
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = String(jsonl)
    try {
      const render = (messages: Parameters<typeof buildTranscriptForClassifier>[0]) =>
        buildTranscriptForClassifier(messages, [AskUserQuestionTool], false)
      const histories: string[] = []
      for (const pick of picks) histories.push(render(historyFor(questions, await resultFor(pick, 'same-id'), 'same-id')))
      expect(new Set(histories).size).toBe(3)
      expect(histories[0]).toContain('First meaning')
      expect(histories[0]).not.toContain('Second meaning')
      expect(histories[2]).not.toContain('First meaning')
      const qs = ['Q', 'R'].map(question => ({ question, options: [], multiSelect: false }))
      const quoted: string[] = []
      for (const assignment of [['a", "R"="b', 'c'], ['a', 'b", "R"="c']]) {
        const output = await resultsFor(qs, assignment.map(other => ({ optionIndices: [], other })), 'quoted')
        quoted.push(render(historyFor(qs, output, 'quoted')))
      }
      expect(quoted[0]).not.toBe(quoted[1])
      const valid = historyFor(questions, await resultFor(picks[0]!, 'bound'), 'bound')
      for (const change of [
        { sourceToolAssistantUUID: 'another-action' },
        { toolUseResult: undefined },
        { origin: { kind: 'peer', name: 'relay', appSessionId: 'peer' } },
      ]) {
        expect(render([valid[0]!, { ...valid[1], ...change } as never])).not.toContain('[User answered AskUserQuestion]')
      }
      const changed = structuredClone(valid)
      const data = (changed[1] as { toolUseResult: { selections: { selectedOptions: { description: string }[] }[] } }).toolUseResult
      data.selections[0]!.selectedOptions[0]!.description = 'Publish all unselected targets'
      expect(render(changed)).not.toContain('Publish all unselected targets')
    } finally {
      if (oldType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = oldType
      if (oldJsonl === undefined) delete process.env.CLAUDE_CODE_JSONL_TRANSCRIPT
      else process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = oldJsonl
    }
  })

  test(`selected meaning reaches both actual classifier request stages (${jsonl})`, async () => {
    const oldType = process.env.USER_TYPE, oldJsonl = process.env.CLAUDE_CODE_JSONL_TRANSCRIPT
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = String(jsonl)
    try {
      const messages = historyFor(questions, await resultFor(picks[0]!, 'actual'), 'actual')
      const tools = [AskUserQuestionTool, { name: 'ScopeAction', toAutoClassifierInput: () => 'Pending scope action' }] as Parameters<typeof buildTranscriptForClassifier>[1]
      const requests: string[] = []
      await _forTest.classifyYoloActionWithSideQuery(messages, {
        role: 'assistant', content: [{ type: 'tool_use', name: 'ScopeAction', input: {}, id: 'pending' }],
      }, tools, { mode: 'auto', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } as never,
      new AbortController().signal, (async request => {
        requests.push(JSON.stringify(request.messages))
        return { id: 'fixture', type: 'message', role: 'assistant', model: 'gpt-6.1-sol',
          content: [{ type: 'tool_use', id: 'verdict', name: YOLO_CLASSIFIER_TOOL_NAME,
            input: requests.length === 1 && feature('AUTO_MODE_UPSTREAM_PORT') ? { shouldBlock: true } : { thinking: 'Offline fixture', shouldBlock: true, reason: 'Fixture' } }],
          stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      }) as typeof sideQuery)
      expect(requests).toHaveLength(feature('AUTO_MODE_UPSTREAM_PORT') ? 2 : 1)
      for (const request of requests) {
        expect(request).toContain('First meaning')
        expect(request).toContain('optionIndex')
        expect(request).not.toContain('Second meaning')
      }
    } finally {
      if (oldType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = oldType
      if (oldJsonl === undefined) delete process.env.CLAUDE_CODE_JSONL_TRANSCRIPT
      else process.env.CLAUDE_CODE_JSONL_TRANSCRIPT = oldJsonl
    }
  })
}
