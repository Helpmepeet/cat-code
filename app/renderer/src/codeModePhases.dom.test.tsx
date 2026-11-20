import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { createTranscriptState, projectServerFrames, selectFocusedLiveState, selectNestedTranscriptRows, selectTranscriptRows } from './transcriptProjector.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { TranscriptModeContext } from './transcriptMode.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await act(async () => { await harness.nextFrame() }); await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
function fixture(sessionId: string) {
  let sequence = 0
  const code = 'await tools.call({name:"Read",input:{file_path:"/repo/a"}})'
  let state = projectServerFrames(createTranscriptState(), [{ kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: 'phase-engine', payload: { type: 'app.ready', protocolVersion: 1, activeTurn: false, inputEnabled: true, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } } as unknown as ServerFrame])
  const event = (event: Record<string, unknown>) => { state = projectServerFrames(state, [{ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId, event } as unknown as ServerFrame]) }
  const message = (value: Record<string, unknown>) => event({ type: 'message', message: { session_id: 'phase-engine', uuid: `${sessionId}:${sequence++}`, parent_tool_use_id: null, ...value } })
  message({ type: 'user', message: { role: 'user', content: 'Inspect phases' } })
  return {
    event,
    writing() {
      for (const entry of [{ type: 'message_start', message: { id: 'phase-message', role: 'assistant', content: [] } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'script', name: 'REPL', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"description":"Inspect phases","code":"await tools.call(' } }]) message({ type: 'stream_event', event: entry })
    },
    submitted(toolUseId = 'script') { message({ type: 'assistant', message: { id: toolUseId === 'script' ? 'phase-message' : `phase-message:${toolUseId}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'REPL', input: { code, description: 'Inspect phases' } }] } }) },
    activity(phase: 'reviewing' | 'executing', toolUseId = 'script', startedAt = 1000) { event({ type: 'tool.activity', toolUseId, phase, startedAt }) },
    review(toolUseId = 'script', outcome: 'reviewing' | 'allowed' = 'reviewing') { event({ type: 'tool.review', toolUseId, attemptId: `phase-review:${toolUseId}`, outcome, startedAt: 1000, ...(outcome === 'allowed' ? { completedAt: 2000 } : {}) }) },
    approval(toolUseId = 'script') { event({ type: 'permission.requested', request: { requestId: `approval-${toolUseId}`, request: { subtype: 'can_use_tool', tool_use_id: toolUseId, tool_name: toolUseId === 'script' ? 'REPL' : 'Read', input: toolUseId === 'script' ? { code } : { file_path: '/repo/a' } } } }) },
    child(toolUseId = 'inner', line = 1) { message({ type: 'assistant', isVirtual: true, code_mode: { cellId: 'script', generation: 'phase-generation', line }, message: { id: `phase-child:${toolUseId}`, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/repo/a' } }] } }) },
    receipt(status: 'running' | 'completed' | 'failed' | 'unknown', taskId?: string, toolUseId = 'script', notification = false) {
      const tool_use_result = { kind: 'code-mode', cellId: toolUseId, generation: 'phase-generation', code, description: 'Inspect phases', status, calls: [], changedFiles: [], output: '', ...(taskId ? { taskId } : {}), ...(status === 'failed' ? { error: 'SyntaxError: invalid script' } : {}) }
      message(notification
        ? { type: 'user', tool_use_result, isSynthetic: true, origin: { kind: 'task-notification', taskType: 'code_mode', toolUseId, taskId }, message: { role: 'user', content: 'Selected output' } }
        : { type: 'user', tool_use_result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Selected output' }] } })
    },
    finishTurn() { message({ type: 'result', subtype: 'success', is_error: false, errors: [], duration_ms: 100 }) },
    rows: () => selectNestedTranscriptRows(state, sessionId),
    raw: () => state.sessions[sessionId]!.rows,
    selected: () => selectTranscriptRows(state, sessionId),
    live: () => selectFocusedLiveState(state, sessionId),
  }
}
function view(data: ReturnType<typeof fixture>, mode: 'full' | 'focused' = 'full', turnLive = true) {
  return <TranscriptModeContext.Provider value={{ mode, setMode() {} }}><TranscriptRowsView rows={data.rows()} focusedLiveState={data.live()} turnLive={turnLive} /></TranscriptModeContext.Provider>
}
const label = (root: ParentNode) => root.querySelector('.code-mode-header .code-mode-status')?.textContent

test('Full Script phases follow projected writing, outer review, approval and actual execution metadata', async () => {
  const data = fixture('full-phase-contract')
  data.writing()
  const tree = await harness.mount(view(data))
  expect(label(tree.container)).toBe('Writing')
  expect(data.raw().some(row => row.kind === 'tool-use')).toBe(false)
  data.submitted()
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Waiting')
  data.review()
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Reviewing')
  data.activity('reviewing')
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Reviewing')
  data.approval()
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Waiting for approval')
  data.activity('executing')
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Running')
  const selected = data.selected().find(row => row.kind === 'tool-use')!
  expect(data.raw().find(row => row.kind === 'tool-use')).not.toHaveProperty('activity')
  expect(selected).toHaveProperty('activity.phase', 'executing')
})

test('outer and child approvals can pause a running receipt, but terminal host status wins stale phase evidence', async () => {
  const data = fixture('approval-phase-contract')
  data.submitted()
  data.activity('reviewing')
  data.receipt('running')
  const tree = await harness.mount(view(data))
  expect(label(tree.container)).toBe('Running')
  data.approval()
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Waiting for approval')
  data.activity('executing')
  data.child()
  data.approval('inner')
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Waiting for approval')
  data.activity('executing', 'inner')
  await tree.render(view(data))
  expect(label(tree.container)).toBe('Running')
  data.approval('inner')
  data.receipt('failed')
  await tree.render(view(data))
  expect(label(tree.container)).toBe('failed')
  expect(tree.container.textContent).toContain('SyntaxError: invalid script')
})

test('Focused Script uses common writing, reviewing and outer approval phases', async () => {
  const data = fixture('focused-phase-contract')
  data.writing()
  const tree = await harness.mount(view(data, 'focused'))
  const head = () => tree.container.querySelector('.focused-step-text > span:last-child')?.textContent ?? ''
  expect(head()).toContain('Writing script')
  data.submitted()
  data.review()
  await tree.render(view(data, 'focused'))
  expect(head()).toContain('Reviewing')
  data.approval()
  await tree.render(view(data, 'focused'))
  expect(head()).toContain('Waiting for approval')
  data.activity('executing')
  await tree.render(view(data, 'focused'))
  expect(head()).toContain('Running script')
  data.receipt('running')
  data.child()
  data.approval('inner')
  await tree.render(view(data, 'focused'))
  expect(head()).toContain('Waiting for approval')
  data.activity('executing', 'inner')
  await tree.render(view(data, 'focused'))
  expect(head()).toContain('Running script')
})

for (const mode of ['full', 'focused'] as const) {
  test(`${mode} Script shows child Auto review before the child executes`, async () => {
    const data = fixture(`child-review-${mode}`)
    data.submitted()
    data.activity('executing')
    if (mode === 'focused') data.receipt('running')
    data.child()
    const tree = await harness.mount(view(data, mode))
    const headline = () => mode === 'full' ? label(tree.container)
      : tree.container.querySelector('.focused-step-text > span:last-child')?.textContent
    const childLabel = () => tree.container.querySelector('.code-mode-member-status')?.textContent
    expect(headline()).toContain('Running')
    data.activity('reviewing', 'inner', Date.now())
    await tree.render(view(data, mode))
    expect(headline()).toContain('Reviewing')
    if (mode === 'full') expect(childLabel()).toBe('Reviewing')
    else expect(tree.container.querySelector('.focused-step-head .focused-meta')).toBeNull()
    data.activity('executing', 'inner')
    await tree.render(view(data, mode))
    expect(headline()).toContain('Running')

    data.child('deep')
    data.activity('reviewing', 'deep')
    data.review('deep')
    await tree.render(view(data, mode))
    expect(headline()).toContain('Reviewing')
    data.review('deep', 'allowed')
    await tree.render(view(data, mode))
    expect(headline()).toContain('Running')
    data.activity('executing', 'deep')
    data.child('manual')
    data.activity('reviewing', 'manual')
    data.approval('manual')
    await tree.render(view(data, mode))
    expect(headline()).toContain('Waiting for approval')
    data.receipt('failed')
    await tree.render(view(data, mode))
    expect(headline()).not.toContain('Reviewing')
    expect(headline()).not.toContain('Waiting for approval')
  })
}

test('Focused keeps a detached Script running after its launch turn finishes', async () => {
  const data = fixture('focused-detached-script')
  data.submitted()
  data.receipt('running', 'detached-task')
  data.finishTurn()
  const tree = await harness.mount(view(data, 'focused', false))
  const turn = tree.container.querySelector<HTMLButtonElement>('.focused-fold-head')!
  if (turn.getAttribute('aria-expanded') === 'false') await act(async () => { turn.click() })
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.textContent).toContain('Running script')
  expect(step.textContent).toContain('Inspect phases')
  expect(step.textContent).not.toContain('Stopped')
})

test('the collapsed Focused group shows both detached Scripts still running after the turn ends', async () => {
  const data = fixture('focused-detached-group')
  data.submitted()
  data.receipt('running', 'first-task')
  data.submitted('second-script')
  data.receipt('running', 'second-task', 'second-script')
  data.finishTurn()
  const tree = await harness.mount(view(data, 'focused', false))
  const turn = tree.container.querySelector<HTMLButtonElement>('.focused-fold-head')!
  expect(turn.textContent).toContain('2 scripts running')
  if (turn.getAttribute('aria-expanded') === 'false') await act(async () => { turn.click() })
  const step = tree.container.querySelector('.focused-step-head')!
  expect(step.getAttribute('aria-expanded')).toBe('false')
  expect(step.textContent).toContain('2 scripts running')

  data.child()
  data.activity('reviewing', 'inner')
  await tree.render(view(data, 'focused', false))
  expect(turn.textContent).toContain('1 script reviewing · 1 script running')
  expect(step.textContent).toContain('1 script reviewing · 1 script running')
  data.activity('executing', 'inner')
  data.receipt('completed', 'second-task', 'second-script')
  await tree.render(view(data, 'focused', false))
  expect(turn.textContent).toContain('1 script running')
  expect(step.textContent).toContain('1 script running')
})

test('a historical launch shows an unknown outcome until a matching terminal receipt is available', async () => {
  const data = fixture('historical-script')
  data.submitted()
  data.receipt('unknown', 'historical-task')
  data.finishTurn()
  const tree = await harness.mount(view(data, 'full', false))
  expect(label(tree.container)).toBe('Outcome unknown')
  data.receipt('completed', 'different-task', 'script', true)
  await tree.render(view(data, 'full', false))
  expect(label(tree.container)).toBe('Outcome unknown')
  await tree.render(view(data, 'focused', false))
  expect(tree.container.querySelector('.focused-fold-head')?.textContent).toContain('unknown outcome for 1 script')
  data.receipt('completed', 'historical-task', 'script', true)
  await tree.render(view(data, 'full', false))
  expect(label(tree.container)).toBe('completed')
})

test('foreground Script card and its source show child calls before the final receipt', async () => {
  const data = fixture('foreground-inspector')
  data.submitted()
  const inspectorView = () => {
    const script = data.rows().find(row => row.kind === 'tool-use' && row.toolName === 'REPL')
    if (script?.kind !== 'tool-use') throw new Error('Missing Script row')
    return view(data)
  }
  const tree = await harness.mount(inspectorView())
  const fold = tree.container.querySelector('.code-mode-script .code-mode-fold-head')!
  if (fold.getAttribute('aria-expanded') === 'false') await act(async () => { fold.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(tree.container.querySelector('button[aria-label="Select line 1, executed"]')).toBeNull()
  data.child()
  await tree.render(inspectorView())
  expect(tree.container.querySelector('.code-mode-member')?.textContent).toContain('/repo/a')
  expect(tree.container.querySelector<HTMLButtonElement>('button[aria-label="Select line 1, executed"]')?.title).toContain('running')
})

test('phase evidence invalidates only the Script row and leaves ordinary activity outside the row graph', () => {
  const data = fixture('phase-identity')
  data.submitted()
  data.event({ type: 'message', message: { type: 'assistant', session_id: 'phase-engine', uuid: 'unrelated-frame', parent_tool_use_id: null, message: { id: 'unrelated-message', role: 'assistant', content: [{ type: 'tool_use', id: 'unrelated', name: 'Read', input: { file_path: '/repo/other' } }] } } })
  const before = data.rows()
  const sibling = before.find(row => row.kind === 'tool-use' && row.toolUseId === 'unrelated')
  data.activity('executing', 'unrelated')
  expect(data.rows()).toBe(before)
  data.activity('reviewing')
  const reviewing = data.rows()
  expect(reviewing.find(row => row.kind === 'tool-use' && row.toolUseId === 'unrelated')).toBe(sibling)
  expect(reviewing.find(row => row.kind === 'tool-use' && row.toolUseId === 'script')).toHaveProperty('activity.phase', 'reviewing')
  data.activity('executing')
  expect(data.rows().find(row => row.kind === 'tool-use' && row.toolUseId === 'unrelated')).toBe(sibling)
  data.child()
  data.activity('reviewing', 'inner')
  expect(data.rows().find(row => row.kind === 'tool-use' && row.toolUseId === 'unrelated')).toBe(sibling)
  data.activity('executing', 'inner')
  const executing = data.rows()
  data.event({ type: 'tool.activity', toolUseId: 'inner', phase: 'executing', startedAt: 1000, output: 'More output', totalLines: 1 })
  expect(data.rows()).toBe(executing)
})
