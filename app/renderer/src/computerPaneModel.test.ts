import { expect, test } from 'bun:test'
import { groupComputerSteps, selectComputerScreen, selectComputerStep, selectComputerSteps, selectCurrentComputerStepId } from './computerPaneModel.js'
import type { ComputerWindowCapture } from '../../shared/computerWindowCapture.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

const computerFixture = (id: string, image = true): Extract<NestedTranscriptRow, { kind: 'tool-use' }> => ({
  id, sessionId: 'test', messageId: id, frameId: id, blockIndex: 0, parentToolUseId: null,
  kind: 'tool-use', toolUseId: id, toolName: 'mcp__codex-computer-use__js', toolFamily: 'computer',
  input: { code: 'secret raw code', title: `Capture ${id}` }, status: image ? 'success' : 'pending', agentCompletion: null,
  result: image ? { content: '', isError: false, diff: null, images: [{ mediaType: 'image/png', data: 'first' }, { mediaType: 'image/png', data: 'last' }] } : null,
  children: [],
})

test('housekeeping calls are neither steps nor current activity', () => {
  const call = (name: string) => ({ ...computerFixture(name, false), toolName: `mcp__codex-computer-use__${name}` })
  const rows = ['js', 'js_complete', 'computer_use_status', 'js_reset'].map(call)
  expect(selectComputerSteps(rows).map(step => step.id)).toEqual(['js', 'js_complete'])
  expect(selectCurrentComputerStepId(rows)).toBe('js_complete')
  expect(selectCurrentComputerStepId(rows.slice(2))).toBeNull()
})

test('targets carry forward until a hidden browser result, and can be restored by app observation', () => {
  const call = (id: string, code = '', content = '') => ({
    ...computerFixture(id), input: { code }, result: { content, isError: false, diff: null },
  })
  expect(selectComputerSteps([
    call('a', 'const app = cua.getApp("/System/Applications/System Settings.app")'),
    call('b'),
    call('c', '', 'Browser tab: 12, Title: "Drive"'),
    call('d'),
    call('e', '', 'Window: "", App: Finder.\n42 button'),
  ]).map(step => step.app)).toEqual(['System Settings', 'System Settings', null, null, 'Finder'])
})

test('same-screen captures share a thumbnail, but changed screens start a new group', () => {
  const steps = selectComputerSteps(['a', 'b', 'c', 'd'].map(id => computerFixture(id, false)))
  const captures = new Map<string, ComputerWindowCapture>()
  for (const [id, sample] of [['a', 1], ['b', 3], ['d', 23]] as const) {
    captures.set(id, { status: 'captured', dataUrl: id, fingerprint: [sample] })
  }
  const groups = groupComputerSteps(steps, captures)
  expect(groups.map(group => group.steps.map(step => step.id))).toEqual([['a', 'b', 'c'], ['d']])
  expect(groups.map(group => group.picture?.stepId)).toEqual(['b', 'd'])
})

test('System Settings loading and populated values group, while page-wide changes split', () => {
  const steps = selectComputerSteps(['loading', 'refresh', 'values', 'general', 'brighter'].map(id =>
    ({ ...computerFixture(id, false), input: { code: 'cua.getApp("System Settings")' } })))
  const loading = Array.from({ length: 16 * 12 }, (_, i) => i % 16 < 5 ? 92 : 160)
  const refresh = loading.map((value, i) => i >= 120 && i < 124 ? value + 7 : value)
  const values = refresh.map((value, i) => i >= 120 && i < 132 ? value - 55 : value)
  // A different page updates 32 samples; its mean delta is under 8,
  // so the large-change count is what separates it.
  const general = values.map((value, i) => i >= 16 && i < 80 && i % 16 >= 8 ? value - 30 : value)
  // A broad but lower contrast change is caught by the mean alone.
  const brighter = general.map(value => value + 9)
  const captures = new Map<string, ComputerWindowCapture>()
  for (const [index, fingerprint] of [loading, refresh, values, general, brighter].entries()) {
    const { id } = steps[index]!
    captures.set(id, { status: 'captured', dataUrl: id, fingerprint })
  }
  expect(groupComputerSteps(steps, captures).map(group => group.steps.map(step => step.id)))
    .toEqual([['loading', 'refresh', 'values'], ['general'], ['brighter']])
})

test('nested computer steps retain stable IDs and titles, deduplicate, and use last capture', () => {
  const first = computerFixture('one')
  const pending = computerFixture('two', false)
  const parent = { ...computerFixture('parent'), toolFamily: 'agent' as const, children: [first, pending] }
  const steps = selectComputerSteps([parent, first, { ...computerFixture('mcp'), toolFamily: 'mcp' }])
  expect(steps.map(step => step.id)).toEqual(['one', 'two'])
  expect(steps[0]?.title).toBe('Capture one')
  expect(steps.every(step => step.nested)).toBe(true)
  expect(selectComputerSteps([first])[0]?.nested).toBe(false)
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

test('text observations are preserved verbatim and latest follows text after an older image', () => {
  const capture = computerFixture('capture')
  const observation = 'Browser tab: 12, Title: "Drive"\n+ 42 button Share\n- 18 text Loading...\n<script>not markup</script>'
  const text = { ...computerFixture('text', false), status: 'success' as const, result: { content: observation, isError: false, diff: null } }
  const pending = computerFixture('pending', false)
  const steps = selectComputerSteps([capture, text, pending])
  expect(steps[1]?.observation).toBe(observation)
  expect(steps[2]?.observation).toBe('')
  expect(selectComputerStep(steps, null)?.id).toBe('text')
  expect(selectComputerStep(steps, 'removed')?.id).toBe('text')
  expect(selectComputerStep(steps, 'capture')?.id).toBe('capture')
  expect(selectComputerScreen(steps, steps[1]!)).toEqual({ step: steps[0], index: 0 })
  const empty = { ...text, id: 'empty', result: { ...text.result, content: ' \n ' } }
  expect(selectComputerStep(selectComputerSteps([text, empty]), null)?.id).toBe('text')
})

test('screen selection carries only the latest capture at or before the selected step', () => {
  const steps = selectComputerSteps([computerFixture('zero', false), computerFixture('one'), computerFixture('two', false), computerFixture('three')])
  expect(selectComputerScreen(steps, steps[0]!)).toBeNull()
  expect(selectComputerScreen(steps, steps[1]!)).toEqual({ step: steps[1], index: 1 })
  expect(selectComputerScreen(steps, steps[2]!)).toEqual({ step: steps[1], index: 1 })
  expect(selectComputerScreen(steps, steps[3]!)).toEqual({ step: steps[3], index: 3 })
  expect(selectComputerScreen(steps, null)).toBeNull()
  expect(selectComputerScreen([], null)).toBeNull()
})

test('an interrupted computer call in an older operator turn is not current activity', () => {
  const old = computerFixture('old', false)
  const boundary: NestedTranscriptRow = {
    id: 'user', sessionId: 'test', messageId: 'user', frameId: 'user', blockIndex: 0,
    parentToolUseId: null, kind: 'user-text', role: 'user', content: 'Continue', isReplay: false, children: [],
  }
  expect(selectCurrentComputerStepId([old])).toBe('old')
  expect(selectCurrentComputerStepId([old, boundary])).toBeNull()
  expect(selectCurrentComputerStepId([old, boundary, computerFixture('new', false)])).toBe('new')
})
