import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { FocusedTranscript } from './FocusedTranscript.js'
import { deriveFocusedTranscript, type FocusedTurnItem } from './focusedTranscriptLayout.js'
import { MAX_MOUNTED_COMPOSITE_CHILDREN } from './compositeChildWindow.js'
import { AgentRevealContext, type AgentRevealRequest } from './transcriptAgentReveal.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const source = (id: string) => ({ id, sessionId: 'window', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const prose = (index: number): Extract<NestedTranscriptRow, { kind: 'assistant-text' }> => ({ ...source(`update-${index}`), kind: 'assistant-text', role: 'assistant', content: `Update ${index}` })
const rows = Array.from({ length: 1200 }, (_, index) => prose(index))
function turn(source: NestedTranscriptRow[]): FocusedTurnItem {
  return deriveFocusedTranscript(source, true).find((item): item is FocusedTurnItem => item.kind === 'focused-turn')!
}
const renderRows = (items: readonly NestedTranscriptRow[]) => <>{items.map(item => <span key={item.id}>{item.id}</span>)}</>
const renderReasoning = () => null

test('a long single turn bounds segment mounts while retaining the live tail and complete model', async () => {
  const model = turn(rows)
  let callbacks = 0
  const render = (items: readonly NestedTranscriptRow[]) => { callbacks++; return renderRows(items) }
  const tree = await harness.mount(<FocusedTranscript turn={model} renderRows={render} renderReasoning={renderReasoning} />)
  expect(model.segments).toHaveLength(1200)
  expect(tree.container.querySelectorAll('.focused-segment').length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  expect(callbacks).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
  expect(tree.container.querySelector('[data-focused-update][data-latest]')?.textContent).toBe('update-1199')
  expect(tree.container.querySelector('.focused-segment-following')).not.toBeNull()
  expect(tree.container.querySelector('.focused-turn-body > [data-transcript-child]')).not.toBeNull()
  const next = turn([...rows.slice(0, -1), { ...prose(1199), content: 'more streaming text' }])
  await tree.render(<FocusedTranscript turn={next} renderRows={render} renderReasoning={renderReasoning} />)
  expect(tree.container.querySelectorAll('.focused-segment').length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
})

test('an agent reveal mounts a distant virtual segment and preserves the segment cap', async () => {
  const agent: NestedTranscriptRow = { ...source('agent'), kind: 'tool-use', toolUseId: 'agent-call', toolName: 'Agent', toolFamily: 'agent', input: { description: 'Inspect history' }, status: 'success', result: null, agentCompletion: null }
  const model = turn([...rows.slice(0, 10), agent, ...rows.slice(10)])
  const render = (reveal: AgentRevealRequest | null) => <AgentRevealContext.Provider value={reveal}>
    <FocusedTranscript turn={model} renderRows={renderRows} renderReasoning={renderReasoning} />
  </AgentRevealContext.Provider>
  const tree = await harness.mount(render(null))
  expect(tree.container.textContent).not.toContain('agent-call')
  await tree.render(render({ toolUseId: 'agent-call', sequence: 1 }))
  await act(async () => {
    await harness.nextFrame()
    await harness.nextFrame()
    await harness.nextFrame()
  })
  expect(tree.container.textContent).toContain('agent')
  expect(tree.container.querySelector('.focused-step-head')?.getAttribute('aria-expanded')).toBe('true')
  expect(tree.container.querySelectorAll('.focused-segment').length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
})

test('virtual navigation preserves a focused control without exceeding the segment cap', async () => {
  const agent: NestedTranscriptRow = { ...source('focus-agent'), kind: 'tool-use', toolUseId: 'focus-agent-call', toolName: 'Agent', toolFamily: 'agent', input: { description: 'Inspect history' }, status: 'success', result: null, agentCompletion: null }
  const model = turn([...rows.slice(0, 10), agent, ...rows.slice(10)])
  const controls = (items: readonly NestedTranscriptRow[]) => <>{items.map(item => <button key={item.id} data-focus-row={item.id}>{item.id}</button>)}</>
  const render = (reveal: AgentRevealRequest | null) => <AgentRevealContext.Provider value={reveal}>
    <FocusedTranscript turn={model} renderRows={controls} renderReasoning={renderReasoning} />
  </AgentRevealContext.Provider>
  const tree = await harness.mount(render(null))
  const focused = tree.container.querySelector<HTMLButtonElement>('[data-focus-row="update-1199"]')!
  expect(focused).not.toBeNull()
  await act(async () => { focused.focus() })
  await tree.render(render({ toolUseId: 'focus-agent-call', sequence: 2 }))
  await act(async () => { await harness.nextFrame(); await harness.nextFrame(); await harness.nextFrame() })
  expect(document.activeElement).toBe(focused)
  expect(focused.isConnected).toBe(true)
  expect(tree.container.querySelectorAll('.focused-segment').length).toBeLessThanOrEqual(MAX_MOUNTED_COMPOSITE_CHILDREN)
})
