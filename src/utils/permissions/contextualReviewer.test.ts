import { expect, test } from 'bun:test'
import { type ContextualEvidence } from './contextualReviewPrompt.js'
import { buildContextualReview } from './contextualReviewer.js'

type Entry = ContextualEvidence['conversation'][number]

const action = {
  tool: 'Bash', effect: 'Write a fixture file', input: { command: 'printf fixture > marker.txt' },
  actor: 'peer-session', cwd: '/fixture', attempt: 'call',
}
const profile = { provider: 'openai', model: 'gpt-6.2-astra' } as const
const operator = (id: string, text: string, proposal?: string): Entry => ({
  id, text, origin: 'operator', ...(proposal && { proposal: { id: `proposal-${id}`, text: proposal } }),
})
const latest = operator('latest', 'Leave marker.txt unchanged.', 'Proposed fixture change.')
const omitted = expect.objectContaining({ origin: 'other', text: expect.stringMatching(/entries were omitted/i) })

function packet(conversation: Entry[], assignment?: ContextualEvidence['assignment']) {
  const built = buildContextualReview({ action, assignment, conversation }, profile, undefined, true)
  return built ? JSON.parse(String(built.options.messages[0]?.content)) as ContextualEvidence : undefined
}

test('review trimming drops assistant and tool rows before stripping older operator proposals', () => {
  const earlier = operator('earlier', 'Inspect the fixture.', 'p'.repeat(16_000))
  const evidence = packet([
    { origin: 'assistant', text: 'a'.repeat(180_000) },
    { origin: 'other', text: 't'.repeat(260_000) },
    earlier,
    latest,
  ])
  expect(evidence?.conversation).toEqual([omitted, earlier, latest])
})

test('review trimming strips older attached proposals before dropping operator rows', () => {
  const older = Array.from({ length: 19 }, (_, index) =>
    operator(`older-${index}`, `Operator restriction ${index}.`, 'p'.repeat(16_000)))
  const evidence = packet([...older, latest])
  const operatorRows = evidence?.conversation.filter(row => row.origin === 'operator')
  expect(operatorRows?.map(row => row.text)).toEqual([...older, latest].map(row => row.text))
  expect(operatorRows?.[0]?.proposal).toBeUndefined()
  expect(operatorRows?.at(-1)).toEqual(latest)
  expect(evidence?.conversation).toContainEqual(omitted)
})

test('last-resort review trimming keeps the assignment anchor and newest operator rows', () => {
  const anchor = operator('anchor', 'Run the fixture with this restriction.')
  const creatorUpdate = operator('creator-update', 'Keep marker.txt private.')
  const evidence = packet([operator('old-peer-turn', 'w'.repeat(130_000)), latest], {
    actor: 'peer-session', origin: 'peer', parentAnchor: anchor.id,
    parent: [anchor, operator('old-parent-turn', 'c'.repeat(170_000)), creatorUpdate],
  })
  expect(evidence?.assignment?.parentAnchor).toBe(anchor.id)
  expect(evidence?.assignment?.parent).toEqual([anchor, creatorUpdate])
  expect(evidence?.conversation).toEqual([omitted, expect.objectContaining({ id: 'old-peer-turn' }), latest])
})
