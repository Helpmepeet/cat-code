import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { CatCodeBridge, ServerFrame } from '../../shared/protocol.js'
import type { InlineCommandRequest, InlineCommandRun, InlineCommandSource } from '../../shared/inlineCommand.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { InlineCommandProvider } from './InlineCommandProvider.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from './transcriptProjector.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import type { SDKMessage } from '../../shared/engine-types.snapshot.js'
import { encodeInlineCommandResult } from '../../shared/inlineCommand.js'

let harness: DomTestHarness
let listener: (frames: ServerFrame[]) => void = () => {}
let starts: { sessionId: string; source: InlineCommandSource; requestId: string; generation: string }[] = []
let stops: string[] = []
let queries = 0
let submissions: { sessionId: string; prompt: unknown }[] = []
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); starts = []; stops = []; queries = 0; submissions = [] })
afterAll(async () => { await harness.teardown() })

function bridge() {
  const stub: Pick<CatCodeBridge, 'getInlineCommands' | 'subscribe' | 'startInlineCommand' | 'stopInlineCommand' | 'submit'> = {
    submit: (sessionId, prompt) => { submissions.push({ sessionId, prompt }) },
    getInlineCommands: () => { queries++; return true },
    subscribe: fn => { listener = fn; return () => { listener = () => {} } },
    startInlineCommand: (sessionId, input) => { starts.push({ sessionId, ...input }); return true },
    stopInlineCommand: (_id, input) => { stops.push(input.runId); return true },
  }
  window.catcode = stub as unknown as CatCodeBridge
}
const origin = { messageUuid: 'canonical-uuid', contentBlockIndex: 3 }
const source: InlineCommandSource = { engineSessionId: 'engine', ...origin, fenceOrdinal: 0 }
const row = (content: string): Extract<NestedTranscriptRow, { kind: 'assistant-text' }> => ({ kind: 'assistant-text', role: 'assistant', id: 'row', sessionId: 'app', messageId: 'api-message', frameId: 'canonical-uuid', blockIndex: 17, parentToolUseId: null, content, inlineCommandOrigin: origin, children: [] })
const run: InlineCommandRun = { runId: 'run', source, command: 'echo hi', cwd: '/tmp', status: 'running', output: '<img src=x onerror=evil()>', exitCode: null }
function view(sessionId: string, rows: NestedTranscriptRow[], runs: InlineCommandRun[] = [], generation = 'g1', requests?: InlineCommandRequest[]) {
  return createElement(InlineCommandProvider, { sessionId, engineSessionId: 'engine', snapshot: { generation, runs, requests }, children: createElement(TranscriptRowsView, { rows }) })
}
function buttons(container: HTMLElement, label: string) { return [...container.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === label) }

test('transcript-only edit keeps retained and new fences runnable without replaying Start or removed output', async () => {
  bridge()
  const sessionId = 'edit-dom-test'
  const base = { protocolVersion: PROTOCOL_VERSION, sessionId }
  let state = createTranscriptState()
  const project = (frame: ServerFrame) => { state = projectServerFrame(state, frame) }
  project({ ...base, kind: 'ready', engineSessionId: 'engine', payload: {
    type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
    abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  } })
  project({ ...base, kind: 'inline-command.snapshot', generation: 'live', runs: [] })
  const assistant = (uuid: string): ServerFrame => ({ ...base, kind: 'event', event: { type: 'message', message: {
    type: 'assistant', uuid, session_id: 'engine', parent_tool_use_id: null,
    message: { id: uuid, role: 'assistant', content: [{ type: 'text', text: '```sh\necho hi\n```' }] },
  } as SDKMessage } })
  const retainedAssistant = assistant('11111111-1111-4111-8111-111111111111')
  project(retainedAssistant)
  project({ ...base, kind: 'event', event: { type: 'message', message: {
    type: 'user', uuid: '22222222-2222-4222-8222-222222222222', session_id: 'engine',
    parent_tool_use_id: null, isSynthetic: true,
    message: { role: 'user', content: encodeInlineCommandResult({ ...run, source: { ...source, messageUuid: '11111111-1111-4111-8111-111111111111', contentBlockIndex: 0 }, status: 'success', exitCode: 0, output: 'removed-output' }) },
  } as SDKMessage } })
  const render = () => {
    const session = state.sessions[sessionId]!
    return createElement(InlineCommandProvider, {
      sessionId, engineSessionId: session.engineSessionId, snapshot: session.inlineCommands,
      results: session.inlineCommandResults,
      children: createElement(TranscriptRowsView, { rows: selectNestedTranscriptRows(state, sessionId) }),
    })
  }
  const tree = await harness.mount(render())
  expect(tree.container.textContent).toContain('removed-output')
  const reset: ServerFrame = { ...base, kind: 'transcript.reset' }
  await act(async () => listener([reset]))
  expect(queries).toBe(2)
  project(reset)
  project(retainedAssistant)
  project({ ...base, kind: 'inline-command.snapshot', generation: 'live', runs: [] })
  project(assistant('33333333-3333-4333-8333-333333333333'))
  await tree.render(render())
  expect(tree.container.textContent).not.toContain('removed-output')
  expect(buttons(tree.container, 'Run')).toHaveLength(2)
  expect(buttons(tree.container, 'Run').every(button => !button.disabled)).toBe(true)
  expect(starts).toEqual([])
  await act(async () => buttons(tree.container, 'Run')[1]!.click())
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ generation: 'live', source: { engineSessionId: 'engine', messageUuid: '33333333-3333-4333-8333-333333333333' } })
})

test('pane waits for the Run handshake before querying execution state', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(createElement(InlineCommandProvider, {
    sessionId: 'handshake-test', engineSessionId: 'engine',
    children: createElement(TranscriptRowsView, { rows }),
  }))
  expect(queries).toBe(0)
  expect(buttons(tree.container, 'Run')[0]!.getAttribute('aria-disabled')).toBe('true')
  await tree.render(view('handshake-test', rows))
  expect(queries).toBe(1)
  expect(buttons(tree.container, 'Run')[0]!.getAttribute('aria-disabled')).toBe('false')
})

test('identical full fences use distinct canonical identities; pending rejects repeated clicks and correlated error releases it', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```\n\n```sh\necho hi\n```')]
  const tree = await harness.mount(view('pending-test', rows))
  expect(buttons(tree.container, 'Run').length).toBe(2)
  await act(async () => { buttons(tree.container, 'Run')[1]!.click(); buttons(tree.container, 'Run')[1]?.click() })
  expect(starts).toHaveLength(1)
  expect(starts[0]!.source).toEqual({ ...source, fenceOrdinal: 1 })
  expect(buttons(tree.container, 'Starting')[0]!.getAttribute('aria-disabled')).toBe('true')
  await act(async () => listener([{ kind: 'error', sessionId: 'pending-test', protocolVersion: 4, requestId: starts[0]!.requestId, message: 'Permission denied', code: 'unauthorized', retryable: false }]))
  expect(tree.container.textContent).toContain('Permission denied')
  expect(buttons(tree.container, 'Starting')).toHaveLength(0)
  await act(async () => buttons(tree.container, 'Run again')[0]!.click())
  expect(starts).toHaveLength(2)
  expect(starts[0]!.requestId).not.toBe(starts[1]!.requestId)
})

test('running output is escaped, Stop is scoped, and remount never resends Start', async () => {
  bridge()
  const rows = [row('```bash\necho hi\n```')]
  const tree = await harness.mount(view('active-test', rows, [run]))
  expect(tree.container.querySelector('img')).toBeNull()
  expect(tree.container.textContent).toContain(run.output)
  expect(tree.container.querySelector('.inline-command-explain')).toBeNull()
  await act(async () => buttons(tree.container, 'Stop')[0]!.click())
  expect(stops).toEqual(['run'])
  await tree.unmount()
  const restored = await harness.mount(view('active-test', rows, [{ ...run, status: 'failed', exitCode: 2 }]))
  expect(starts).toHaveLength(0)
  expect(queries).toBe(2)
  expect(restored.container.textContent).toContain('Exit 2')
  expect(buttons(restored.container, 'Run again')).toHaveLength(1)
})

test('windowed fence uses whole-source offsets and keeps one Run action', async () => {
  bridge()
  const text = '```txt\nunsupported\n```\n\n> ```bash\n' + Array.from({ length: 650 }, (_, index) => `> echo ${index}`).join('\n') + '\n> ```'
  const tree = await harness.mount(view('windowed-test', [row(text)]))
  expect(buttons(tree.container, 'Run')).toHaveLength(1)
  expect(tree.container.querySelector('.inline-command-language')?.textContent).toBe('bash')
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  expect(starts[0]!.source).toEqual({ ...source, fenceOrdinal: 1 })
})

test('no Run on user, reasoning, streaming open fences, or a settings CodeBlock without origin', async () => {
  bridge()
  const assistant = row('```bash\necho no')
  const user: NestedTranscriptRow = { ...row('```bash\necho user\n```'), kind: 'user-text', role: 'user', isReplay: false }
  const thinking: NestedTranscriptRow = { ...row('```bash\necho reasoning\n```'), kind: 'thinking' }
  const noOrigin = row('```bash\necho no\n```')
  if (noOrigin.kind === 'assistant-text') delete noOrigin.inlineCommandOrigin
  const tree = await harness.mount(view('ineligible-test', [assistant, { ...user, id: 'user' }, { ...thinking, id: 'thinking' }, { ...noOrigin, id: 'no-origin' }]))
  expect(buttons(tree.container, 'Run')).toHaveLength(0)
})

test('replacement generation clears pending with uncertain-outcome warning and never resends', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(view('generation-test', rows))
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  await tree.render(view('generation-test', rows, [], 'g2'))
  expect(starts).toHaveLength(1)
  expect(buttons(tree.container, 'Starting')).toHaveLength(0)
  expect(tree.container.textContent).toContain('Outcome unknown')
})

test('an unmounted pane cannot remain pending after its refusal was missed', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(view('missed-main-refusal', rows, [], 'g1', []))
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  const requestId = starts[0]!.requestId
  await tree.unmount()
  listener([{
    kind: 'error', sessionId: 'missed-main-refusal', protocolVersion: 4,
    requestId, code: 'bad_request', retryable: true, message: 'Workspace change in progress.',
  }])
  const restored = await harness.mount(view('missed-main-refusal', rows, [], 'g1', []))
  expect(buttons(restored.container, 'Starting')).toHaveLength(0)
  expect(restored.container.textContent).toContain('Outcome unknown')
  expect(buttons(restored.container, 'Run again')).toHaveLength(1)
  expect(starts).toHaveLength(1)
})

test('query settles lost rejection and later successful request does not revive its error', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(view('lost-rejection', rows, [], 'g1', []))
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  const rejected: InlineCommandRequest = { requestId: starts[0]!.requestId, source, status: 'rejected', error: 'Source unavailable.' }
  await tree.unmount()
  const restored = await harness.mount(view('lost-rejection', rows, [], 'g1', [rejected]))
  expect(buttons(restored.container, 'Starting')).toHaveLength(0)
  expect(restored.container.textContent).toContain('Source unavailable.')
  expect(starts).toHaveLength(1)
  await act(async () => buttons(restored.container, 'Run again')[0]!.click())
  const second = starts[1]!.requestId
  await restored.render(view('lost-rejection', rows, [], 'g1', [rejected]))
  expect(restored.container.textContent).not.toContain('Source unavailable.')
  expect(buttons(restored.container, 'Starting')).toHaveLength(1)
  // The completed preview was retired, but its exact request outcome remains.
  await restored.render(view('lost-rejection', rows, [], 'g1', [
    rejected, { requestId: second, source, status: 'completed', runId: 'retired' },
  ]))
  expect(buttons(restored.container, 'Starting')).toHaveLength(0)
  expect(restored.container.textContent).not.toContain('Source unavailable.')
  expect(starts).toHaveLength(2)
})

test('post-completion operation rejection is visible at its source', async () => {
  bridge()
  const tree = await harness.mount(view('response-failure', [row('```sh\necho hi\n```')], [{ ...run, status: 'success', exitCode: 0 }], 'g1', [
    { requestId: 'completed-operation', source, runId: run.runId, status: 'rejected', error: 'Agent response failed.' },
  ]))
  expect(tree.container.textContent).toContain('Agent response failed.')
})

test('older ledger rejection cannot replace a newer correlated failure after pending clears', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(view('latest-failure', rows, [], 'g1', []))
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  const rejected: InlineCommandRequest = { requestId: starts[0]!.requestId, source, status: 'rejected', error: 'Old rejection' }
  await tree.render(view('latest-failure', rows, [], 'g1', [rejected]))
  await act(async () => buttons(tree.container, 'Run again')[0]!.click())
  await act(async () => listener([{ kind: 'error', protocolVersion: 4, sessionId: 'latest-failure', requestId: starts[1]!.requestId, message: 'New failure', code: 'unauthorized', retryable: false }]))
  await tree.render(view('latest-failure', rows, [], 'g1', [{ ...rejected }]))
  expect(tree.container.textContent).toContain('New failure')
  expect(tree.container.textContent).not.toContain('Old rejection')
})

for (const generation of ['g1', 'g2']) {
  test(`disconnected uncertainty reconciles only its own generation: ${generation}`, async () => {
    bridge()
    const sessionId = `uncertain-${generation}`
    const rows = [row('```sh\necho hi\n```')]
    const tree = await harness.mount(view(sessionId, rows, [], 'g1', []))
    await act(async () => buttons(tree.container, 'Run')[0]!.click())
    await act(async () => listener([{ kind: 'lifecycle', protocolVersion: 4, sessionId, status: 'disconnected' }]))
    expect(tree.container.textContent).toContain('Outcome unknown')
    const requests: InlineCommandRequest[] = [{ requestId: starts[0]!.requestId, source, status: 'completed', runId: 'evicted' }]
    await tree.render(view(sessionId, rows, [], generation, requests))
    expect(tree.container.textContent?.includes('Outcome unknown')).toBe(generation !== 'g1')
    await tree.unmount()
    const restored = await harness.mount(view(sessionId, rows, [], generation, requests))
    expect(restored.container.textContent?.includes('Outcome unknown')).toBe(generation !== 'g1')
    expect(buttons(restored.container, 'Run again')).toHaveLength(1)
    expect(starts).toHaveLength(1)
  })
}

test('completed request without retained run offers Run again and honest unavailable output', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const tree = await harness.mount(view('evicted-preview', rows, [], 'g1', []))
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  await tree.render(view('evicted-preview', rows, [], 'g1', [
    { requestId: starts[0]!.requestId, source, status: 'completed', runId: 'evicted' },
  ]))
  expect(buttons(tree.container, 'Starting')).toHaveLength(0)
  expect(buttons(tree.container, 'Run again')).toHaveLength(1)
  expect(tree.container.textContent).toContain('Command output is no longer retained.')
  expect(tree.container.textContent).not.toContain('Exit 0')
  expect(starts).toHaveLength(1)
})

test('runnable controls share a language header, while plain fences keep floating Copy', async () => {
  bridge()
  const tree = await harness.mount(view('headers', [row('```bash\necho hi\n```\n\n```ts\nconst n = 1\n```')]))
  expect(tree.container.querySelectorAll('.inline-command-header')).toHaveLength(1)
  expect(tree.container.querySelector('.inline-command-language')?.textContent).toBe('bash')
  const runButton = buttons(tree.container, 'Run')[0]!
  expect(runButton.closest('.inline-command-header')).not.toBeNull()
  expect(runButton.closest('pre')).toBeNull()
  expect(tree.container.querySelectorAll('pre button')).toHaveLength(0)
  expect(buttons(tree.container, 'Copy code')).toHaveLength(2)
})

test('busy availability is focusable, described, and recovers after the turn', async () => {
  bridge()
  const render = (blockedReason?: string) => createElement(InlineCommandProvider, {
    sessionId: 'busy-availability', engineSessionId: 'engine', snapshot: { generation: 'g1', runs: [] },
    blockedReason, children: createElement(TranscriptRowsView, { rows: [row('```sh\necho hi\n```')] }),
  })
  const tree = await harness.mount(render('Wait for the current turn to finish.'))
  const button = buttons(tree.container, 'Run')[0]!
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(tree.container.querySelector(`[id="${button.getAttribute('aria-describedby')}"]`)?.textContent).toBe('Wait for the current turn to finish.')
  await act(async () => button.click())
  expect(starts).toHaveLength(0)
  await tree.render(render())
  await act(async () => buttons(tree.container, 'Run')[0]!.click())
  expect(starts).toHaveLength(1)
  await act(async () => listener([{ kind: 'error', protocolVersion: 4, sessionId: 'busy-availability', requestId: starts[0]!.requestId, message: 'Session is busy.', code: 'unauthorized', retryable: false }]))
  expect(tree.container.querySelector('[role="alert"]')?.textContent).toBe('Session is busy.')
})

test('interactive guard blocks only new runs and preserves Stop', async () => {
  bridge()
  const rows = [row('```sh\ntop -o cpu\n```')]
  const tree = await harness.mount(view('interactive', rows))
  const button = buttons(tree.container, 'Run')[0]!
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.disabled).toBe(false)
  expect(button.title).toBe('This command needs an interactive terminal.')
  await act(async () => button.click())
  expect(starts).toHaveLength(0)
  await tree.render(view('interactive', rows, [{ ...run, command: 'top -o cpu' }]))
  expect(buttons(tree.container, 'Stop')[0]!.getAttribute('aria-disabled')).toBe('false')
  await act(async () => buttons(tree.container, 'Stop')[0]!.click())
  expect(stops).toEqual(['run'])
})

test('engine gap separates real head and tail without invented line numbers', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const result: InlineCommandRun = { ...run, status: 'failed', exitCode: 2, output: 'HEAD', outputTail: 'UNIQUE_END', omittedBytes: 25_000, durationMs: 1250, startedAt: 1 }
  const tree = await harness.mount(view('head-tail', rows, [result]))
  const output = tree.container.querySelector('[aria-label="Command output"]')!
  expect(output.textContent).toContain('25.0 KB omitted')
  expect(output.textContent!.indexOf('HEAD')).toBeLessThan(output.textContent!.indexOf('25.0 KB omitted'))
  expect(output.textContent!.indexOf('25.0 KB omitted')).toBeLessThan(output.textContent!.indexOf('UNIQUE_END'))
  const end = [...output.querySelectorAll('div')].find(element => element.textContent === 'UNIQUE_END')!
  expect(end.querySelector('span')?.textContent).toBe('')
  expect(output.textContent).toContain('1.3s')
  expect(output.textContent).toContain('Exit 2')
  await tree.render(view('head-tail', rows, [{ ...result, totalLines: 900 }]))
  expect(output.textContent).toContain('900UNIQUE_END')
})

for (const [status, output, error, expected] of [
  ['success', 'visible output', undefined, ''],
  ['success', '', undefined, 'No output'],
  ['failed', '', undefined, 'Failed'],
  ['failed', 'failure details', undefined, 'Failed'],
  ['stopped', '', undefined, 'Stopped'],
  ['interrupted', '', undefined, 'Interrupted'],
  ['failed', '', 'Permission denied', 'Failed'],
] as const) {
  test(`finished output ${status} ${output || error || 'empty'} stays legible and announces its outcome`, async () => {
    bridge()
    const tree = await harness.mount(view(`outcome-${status}-${output}-${error}`, [row('```sh\necho hi\n```')], [{ ...run, status, output, error, exitCode: status === 'failed' ? 1 : 0 }]))
    const section = tree.container.querySelector('[aria-label="Command output"]')!
    expect(section.querySelector('.inline-command-status')?.textContent).toContain(expected)
    expect(section.querySelector('[role="status"]')?.textContent).toBe(expected || 'Command succeeded')
    expect(section.textContent).not.toContain('Exit 0')
    if (output) expect(section.textContent).toContain(output)
    if (error) expect(section.textContent).toContain(error)
  })
}

test('cwd is shown only when different and legacy text remains intact', async () => {
  bridge()
  const legacy = 'Exit code 2\n<persisted-output>old text</persisted-output>'
  const render = (cwd: string) => createElement(InlineCommandProvider, {
    sessionId: 'legacy', engineSessionId: 'engine',
    snapshot: { generation: 'g1', runs: [{ ...run, status: 'failed', output: legacy }] },
    children: createElement(TranscriptRowsView, { cwd, rows: [row('```sh\necho hi\n```')] }),
  })
  const tree = await harness.mount(render('/tmp'))
  expect(tree.container.querySelector('.inline-command-cwd')).toBeNull()
  expect(tree.container.textContent).toContain('Exit code 2')
  expect(tree.container.textContent).toContain('<persisted-output>old text</persisted-output>')
  await tree.render(render('/other'))
  expect(tree.container.querySelector('.inline-command-cwd')?.getAttribute('title')).toBe('/tmp')
})

test('Explain output submits the exact selected run through ordinary submit and obeys availability', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const render = (blockedReason?: string) => createElement(InlineCommandProvider, {
    sessionId: 'explain', engineSessionId: 'engine', blockedReason,
    snapshot: { generation: 'g1', runs: [{ ...run, runId: 'first', status: 'success' }, { ...run, runId: 'second-exact-run', status: 'failed' }] },
    children: createElement(TranscriptRowsView, { rows }),
  })
  const tree = await harness.mount(render('Wait for the current turn to finish.'))
  const explain = () => tree.container.querySelector<HTMLButtonElement>('.inline-command-explain button')!
  expect(explain().getAttribute('aria-disabled')).toBe('true')
  await act(async () => explain().click())
  expect(submissions).toEqual([])
  await tree.render(render())
  await act(async () => explain().click())
  expect(submissions).toEqual([{ sessionId: 'explain', prompt: 'Explain the output of inline command run second-exact-run.' }])
  expect(starts).toEqual([])
})

test('running elapsed time and output updates do not enter the completion live region', async () => {
  bridge()
  const rows = [row('```sh\necho hi\n```')]
  const active = { ...run, startedAt: Date.now() - 2000, output: 'first chunk' }
  const tree = await harness.mount(view('live-outcome', rows, [active]))
  const live = () => tree.container.querySelector('[aria-label="Command output"] [role="status"]')!
  expect(live().textContent).toBe('')
  expect(tree.container.querySelector('.inline-command-status')?.textContent).toMatch(/\d+\.\ds/)
  await tree.render(view('live-outcome', rows, [{ ...active, output: 'second chunk' }]))
  expect(live().textContent).toBe('')
  await tree.render(view('live-outcome', rows, [{ ...active, status: 'success', durationMs: 2500, output: 'last chunk' }]))
  expect(live().textContent).toBe('Command succeeded')
  expect(tree.container.querySelector('.inline-command-status')?.textContent).toContain('2.5s')
  await tree.render(view('live-outcome', rows, [{ ...active, status: 'success', durationMs: 2500, output: 'last chunk plus retained text' }]))
  expect(live().textContent).toBe('Command succeeded')
})
