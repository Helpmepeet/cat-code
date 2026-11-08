import { expect, test } from 'bun:test'
import { selectComputerStep, selectComputerSteps } from './computerPaneModel.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

const computerFixture = (id: string, image = true): Extract<NestedTranscriptRow, { kind: 'tool-use' }> => ({
  id, sessionId: 'test', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null,
  kind: 'tool-use', toolUseId: id, toolName: 'mcp__codex-computer-use__js', toolFamily: 'computer',
  input: { code: 'secret raw code', title: `Capture ${id}` }, status: image ? 'success' : 'pending', agentCompletion: null,
  result: image ? { content: '', isError: false, diff: null, images: [{ mediaType: 'image/png', data: 'first' }, { mediaType: 'image/png', data: 'last' }] } : null,
  children: [],
})

test('nested computer steps retain stable IDs and titles, deduplicate, and use last capture', () => {
  const first = computerFixture('one')
  const pending = computerFixture('two', false)
  const parent = { ...computerFixture('parent'), toolFamily: 'agent' as const, children: [first, pending] }
  const steps = selectComputerSteps([parent, first, { ...computerFixture('mcp'), toolFamily: 'mcp' }])
  expect(steps.map(step => step.id)).toEqual(['one', 'two'])
  expect(steps[0]?.title).toBe('Capture one')
  expect(steps[0]?.image?.data).toBe('last')
  expect(selectComputerStep(steps, null)?.id).toBe('one')
  expect(selectComputerStep(steps, 'removed')?.id).toBe('one')
  expect(selectComputerStep(steps, 'two')?.id).toBe('two')
  expect(first.children).toEqual([])
})

test('empty and screenshotless histories are safe', () => {
  expect(selectComputerStep([], null)).toBeNull()
  expect(selectComputerStep(selectComputerSteps([computerFixture('pending', false)]), null)?.id).toBe('pending')
})
