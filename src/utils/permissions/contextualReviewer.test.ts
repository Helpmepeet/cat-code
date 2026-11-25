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
  const built = buildContextualReview({ action, assignment, conversation }, profile)
  return built ? JSON.parse(String(built.options.messages[0]?.content)) as ContextualEvidence : undefined
}

test('review trimming drops optional rows while retaining older operator proposals', () => {
  const earlier = operator('earlier', 'Inspect the fixture.', 'p'.repeat(16_000))
  const evidence = packet([
    { origin: 'assistant', text: 'a'.repeat(180_000) },
    { origin: 'other', text: 't'.repeat(260_000) },
    earlier,
    latest,
  ])
  expect(evidence?.conversation).toEqual([omitted, earlier, latest])
})

test('review trimming cannot split a reply from an over-budget collection of linked proposals', () => {
  const older = Array.from({ length: 19 }, (_, index) =>
    operator(`older-${index}`, 'No, leave that as it is.', `Change fixture ${index}: ${'p'.repeat(15_000)}`))
  expect(packet([...older, latest])).toBeUndefined()
})

test('review trimming keeps the worker assignment anchor and older operator instructions', () => {
  const anchor = operator('anchor', 'Run the fixture with this restriction.')
  const parentUpdate = operator('parent-update', 'Keep marker.txt private.')
  const workerOperator = operator('old-operator-turn', 'w'.repeat(130_000))
  const evidence = packet([workerOperator, latest], {
    actor: 'local-worker', origin: 'worker-launch', parentAnchor: anchor.id,
    parent: [{ origin: 'assistant', text: 'c'.repeat(170_000) }, anchor, parentUpdate],
  })
  expect(evidence?.assignment?.parentAnchor).toBe(anchor.id)
  expect(evidence?.assignment?.parent).toEqual([anchor, parentUpdate])
  expect(evidence?.conversation).toEqual([omitted, workerOperator, latest])
})

test('last-resort review trimming never separates an approval from its later withdrawal', () => {
  const approval = operator('approval', 'You may change marker.txt.')
  const withdrawal = operator('withdrawal', 'Do not change marker.txt after all.')
  const followUp = operator('follow-up', 'Continue with the documentation.')
  const longChat = Array.from({ length: 100 }, (_, index): Entry => ({
    origin: 'other', id: `background-${index}`, text: 'Background notes: ' + 'w'.repeat(3_000),
  }))
  const assignment = {
    actor: 'local-worker', origin: 'worker-launch' as const, parentAnchor: approval.id,
    parent: [approval, withdrawal, followUp],
  }
  const evidence = packet([...longChat, latest], assignment)
  expect(evidence?.assignment?.parent).toEqual([approval, withdrawal, followUp])
  expect(evidence?.conversation).toContainEqual(omitted)

  const tooLarge = operator('withdrawal', 'w'.repeat(260_000))
  expect(packet([latest], { ...assignment, parent: [approval, tooLarge, followUp] })).toBeUndefined()
})
