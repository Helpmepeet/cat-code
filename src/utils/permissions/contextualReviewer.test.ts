import { expect, test } from 'bun:test'
import { buildSideQueryRequest } from '../sideQuery.js'
import { CONTEXTUAL_REVIEW_MAX_BYTES, type ContextualEvidence } from './contextualReviewPrompt.js'
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

function packet(conversation: Entry[], assignment?: ContextualEvidence['assignment'], script?: ContextualEvidence['action']['script']) {
  const built = buildContextualReview({ action: { ...action, script }, assignment, conversation }, profile, [], Boolean(script))
  if (!built) return undefined
  const content = String(built.options.messages[0]?.content)
  expect(Buffer.byteLength(String(built.options.system)) + Buffer.byteLength(content))
    .toBeLessThanOrEqual(CONTEXTUAL_REVIEW_MAX_BYTES)
  return JSON.parse(content) as ContextualEvidence & { omittedHistoryEntries: number }
}

test('keeps the first operator message and fills the rest with the newest whole entries', () => {
  const first = operator('first', 'Inspect the fixture.')
  const old = operator('old', 'o'.repeat(1_100_000), 'An older proposal.')
  const fresh = { ...operator('fresh', 'é'.repeat(520_000)), actor: 'Peer session' }
  const proposalTail = 'p'.repeat(1_978) + 'Leave the file alone.\n'
  const newest = operator('newest', 'Yes.', 'Old options.\n' + proposalTail)
  const evidence = packet([first, old, fresh, newest])
  expect(evidence?.conversation).toEqual([first, fresh, {
    ...newest, proposal: { id: 'proposal-newest', text: proposalTail, truncated: true },
  }])
  expect(evidence?.omittedHistoryEntries).toBe(1)
})

test('an oversized first operator message ages out when the newest one fits', () => {
  const evidence = packet([operator('first', 'e'.repeat(2_000_000)), latest])
  expect(evidence?.conversation).toEqual([latest])
  expect(evidence?.omittedHistoryEntries).toBe(1)
})

test('an oversized newest operator message prevents review even with older history removed', () => {
  const newest = operator('newest', 'é'.repeat(1_000_000))
  expect(packet([latest, newest, { origin: 'peer', text: 'A later teammate update.' }])).toBeUndefined()
})

test('worker history shares the budget in chronological order with the local conversation', () => {
  const anchor = operator('anchor', 'Run the fixture with this restriction.')
  const evidence = packet([latest], {
    actor: 'local-worker', origin: 'worker-launch', parentAnchor: anchor.id,
    parent: [anchor, operator('old-parent', 'o'.repeat(2_000_000)), operator('parent-update', 'Keep marker.txt private.')],
  })
  expect(evidence?.assignment).toEqual({
    actor: 'local-worker', origin: 'worker-launch', parentAnchor: anchor.id,
    parent: [anchor, operator('parent-update', 'Keep marker.txt private.')],
  })
  expect(evidence?.conversation).toEqual([latest])
  expect(evidence?.omittedHistoryEntries).toBe(1)
})

test('consecutive reviews share the prefix through all earlier history entries', () => {
  const settings = [{ source: 'userSettings', soft_deny: ['Keep private files local.'] }]
  const workspaceInstructions = 'Keep the fixture in the workspace.'
  const prefix = (attempt: string, conversation: Entry[]) => {
    const built = buildContextualReview({ action: { ...action, attempt, input: { command: attempt } },
      workspaceInstructions, conversation }, profile, settings)
    expect(built).toBeDefined()
    const request = buildSideQueryRequest(built!.options, profile.provider)
    const content = String(request.messages[0]?.content)
    const workspacePrefix = `{"workspaceInstructions":${JSON.stringify(workspaceInstructions)},`
    expect(content).toStartWith(workspacePrefix)
    const system = request.system.map(block => block.text).join('\n\n')
    expect(system).toEndWith(JSON.stringify(settings))
    return system + content
  }
  const previousHistory = [operator('first', 'Inspect the fixture.'), latest]
  const first = prefix('one', previousHistory)
  const second = prefix('two', [...previousHistory, operator('next', 'Summarize the result.')])
  const history = JSON.stringify(previousHistory).slice(0, -1)
  expect(first).toContain(history + ']')
  expect(second).toStartWith(first.slice(0, first.indexOf(history) + history.length))
})

test('an over-budget Script drops the oldest source and keeps its receipt', () => {
  const earlierSources = [1, 2, 3].map(cell => ({ cell, source: `// cell ${cell}\n` + 'é'.repeat(400_000) }))
  const earlierCells = [{ cell: 1, children: [{ tool: 'Bash', line: 1, outcome: 'completed' as const }] }]
  const source = 'await inspectFixture();'
  const evidence = packet([latest], undefined, { cellId: 'cell', generation: 'fixture', cell: 4,
    source, earlierSources, earlierCells })
  expect(evidence?.action.script).toMatchObject({
    cell: 4, source, earlierSources: earlierSources.slice(1), earlierSourcesOmitted: 1, earlierCells,
  })
  expect(evidence?.conversation).toEqual([latest])
})

test('an over-budget current source cannot fit even after dropping all earlier cells', () => {
  const source = 'é'.repeat(1_000_000)
  expect(packet([], undefined, { cellId: 'cell', generation: 'fixture', cell: 2,
    source, earlierSources: [{ cell: 1, source: 'const value = 1;' }] })).toBeUndefined()
})
