import { describe, expect, test } from 'bun:test'
import type { TasksSnapshot } from '../../shared/protocol.js'
import { backgroundAgentState, focusedCallLine, focusedCallPhase, type FocusedCallContext } from './focusedCallText.js'
import type { FocusedCall } from './focusedLive.js'
import { deriveToolFamily, type NestedTranscriptRow, type ToolResultProjection } from './transcriptProjector.js'
import { deriveTarget, patchFilePaths, toolCardFilePath } from './transcriptToolTarget.js'

const base = (id: string) => ({ id, frameId: id, sessionId: 's', messageId: id, blockIndex: 0, parentToolUseId: null, children: [] })
const DECLINED = 'User declined to answer questions'
const result = (extra: Partial<ToolResultProjection> = {}): ToolResultProjection => ({ isError: false, content: '', diff: null, ...extra })
function call(toolName: string, input: Record<string, unknown> = {}, extra: Partial<FocusedCall> = {}): FocusedCall {
  return { ...base(toolName), kind: 'tool-use', toolUseId: `${toolName}-id`, toolName, toolFamily: deriveToolFamily(toolName), input,
    status: 'success', result: result(), agentCompletion: null, ...extra }
}
const pending = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<FocusedCall> = {}) =>
  call(toolName, input, { status: 'pending', result: null, ...extra })
const ctx = (extra: Partial<FocusedCallContext> = {}): FocusedCallContext => ({ signalled: false, cwd: null, tasks: null, turnRows: [], ...extra })
const executing = { type: 'tool.activity', toolUseId: 'x', phase: 'executing', startedAt: 0 } as const
const words = (line: ReturnType<typeof focusedCallLine>) => [line.verb, line.target, line.detail]

describe('focused call phase', () => {
  test('maps status, review, approval and activity to one phase', () => {
    expect(focusedCallPhase(pending('Bash', {}, { preparing: true }), true)).toBe('preparing')
    expect(focusedCallPhase(call('Bash'), true)).toBe('done')
    expect(focusedCallPhase(call('Bash', {}, { status: 'error' }), true)).toBe('failed')
    expect(focusedCallPhase(call('Bash', {}, { status: 'cancelled' }), true)).toBe('stopped')
    const review = { type: 'tool.review', toolUseId: 'x', attemptId: 'a', startedAt: 0, outcome: 'blocked' } as const
    expect(focusedCallPhase(call('Bash', {}, { status: 'error', autoModeReview: review }), true)).toBe('blocked')
    expect(focusedCallPhase(pending('Bash', {}, { awaitingApproval: true }), true)).toBe('approval')
    expect(focusedCallPhase(pending('Bash', {}, { activity: { ...executing, phase: 'reviewing' } }), true)).toBe('reviewing')
    expect(focusedCallPhase(pending('Bash', {}, { activity: executing }), true)).toBe('running')
    expect(focusedCallPhase(pending('Bash'), false)).toBe('running')
    expect(focusedCallPhase(pending('Bash'), true)).toBe('queued')
  })
})

describe('focused call line', () => {
  test('core tools use their verbs and trim the project folder', () => {
    const run = pending('Bash', { command: 'bun test' }, { activity: executing })
    expect(focusedCallLine(run, ctx({ signalled: true }))).toMatchObject({ phase: 'running', verb: 'Running', verbTone: 'live', target: 'bun test', targetFace: 'mono', mark: '$' })
    expect(focusedCallLine(call('Bash', { command: 'bun test' }), ctx()).verb).toBe('Ran')
    const read = call('Read', { file_path: '/repo/app/a.ts' })
    expect(words(focusedCallLine(read, ctx({ cwd: '/repo' })))).toEqual(['Read', 'app/a.ts', null])
    expect(focusedCallLine(call('Write', { file_path: '/a' }), ctx())).toMatchObject({ verb: 'Wrote', mark: '±' })
    expect(words(focusedCallLine(call('Grep', { pattern: 'needle' }), ctx()))).toEqual(['Searched', 'needle', null])
    expect(words(focusedCallLine(call('WebFetch', { url: 'https://x.dev' }), ctx()))).toEqual(['Fetched', 'https://x.dev', null])
    expect(words(focusedCallLine(call('NotebookEdit', { notebook_path: 'n.ipynb' }), ctx()))).toEqual(['Edited', 'n.ipynb', null])
    expect(words(focusedCallLine(call('Mystery', {}), ctx()))).toEqual(['Used', 'Mystery', null])
  })
  test('phases override the verb and carry their tone', () => {
    const input = { command: 'ls' }
    expect(focusedCallLine(pending('Bash', input, { preparing: true }), ctx())).toMatchObject({ verb: 'Preparing', verbTone: 'live' })
    expect(focusedCallLine(pending('Bash', input), ctx({ signalled: true }))).toMatchObject({ verb: 'Queued', verbTone: 'queued' })
    expect(focusedCallLine(pending('Bash', input, { activity: { ...executing, phase: 'reviewing' } }), ctx({ signalled: true }))).toMatchObject({ verb: 'Reviewing', verbTone: 'live' })
    expect(focusedCallLine(pending('Bash', input, { awaitingApproval: true }), ctx())).toMatchObject({ verb: 'Waiting for approval', verbTone: 'warn' })
    expect(focusedCallLine(call('Bash', input, { status: 'cancelled' }), ctx())).toMatchObject({ verb: 'Stopped', verbTone: null })
    expect(focusedCallLine(call('Bash', input, { status: 'error' }), ctx())).toMatchObject({ phase: 'failed', verb: 'Ran' })
    const blocked = { type: 'tool.review', toolUseId: 'x', attemptId: 'a', startedAt: 0, outcome: 'blocked' } as const
    expect(focusedCallLine(call('Bash', input, { status: 'error', autoModeReview: blocked }), ctx()).verb).toBe('Blocked')
  })
  test('web search names the query', () => {
    expect(words(focusedCallLine(call('WebSearch', { query: 'bun docs' }), ctx()))).toEqual(['Searched the web for', 'bun docs', null])
    expect(focusedCallLine(pending('web_search', { query: 'q' }), ctx()).verb).toBe('Searching the web for')
  })
  test('agents show the worker name only when one is known', () => {
    const input = { description: 'Audit the cache' }
    expect(words(focusedCallLine(call('Agent', input), ctx()))).toEqual(['Delegated', 'Audit the cache', null])
    const named = call('Agent', input, { result: result({ agentName: 'Ada' }) })
    expect(words(focusedCallLine(named, ctx()))).toEqual(['Delegated', 'Audit the cache', 'Ada'])
    expect(focusedCallLine(pending('Task', input, { activity: executing }), ctx()).verb).toBe('Delegating')
  })
  test('agent control tools name the agent without @', () => {
    expect(words(focusedCallLine(call('ResumeAgent', { agentId: '@ada', prompt: 'carry on' }), ctx()))).toEqual(['Resumed', 'ada', 'carry on'])
    expect(focusedCallLine(call('ResumeAgent', { agentId: 'ada' }), ctx()).targetFace).toBe('sans')
    expect(words(focusedCallLine(call('SendMessage', { to: '@ada', summary: 'ping' }), ctx()))).toEqual(['Messaged', 'ada', 'ping'])
    expect(words(focusedCallLine(call('SendMessage', { to: 'ada', summary: ' ' }), ctx()))).toEqual(['Messaged', 'ada', null])
    expect(focusedCallLine(pending('SendMessage', { to: 'ada' }), ctx()).verb).toBe('Messaging')
  })
  test('ToolSearch loads tools with the search mark', () => {
    const line = focusedCallLine(call('ToolSearch', { query: 'select:Read,Edit' }), ctx())
    expect(words(line)).toEqual(['Loaded', 'Read, Edit', null])
    expect(line.mark).toBe('⌕')
    expect(focusedCallLine(pending('ToolSearch', { query: 'x' }, { activity: executing }), ctx()).verb).toBe('Loading')
  })
  test('background task tools resolve the task label in order', () => {
    const tasks = { focusedBashJobs: [{ id: 'job', toolUseId: 'b', label: 'bun dev', status: 'running', startTime: 0 }],
      items: [{ id: 'item', type: 'local_agent', status: 'running', label: 'Audit', startTime: 0 }] } as unknown as TasksSnapshot
    const started = call('Bash', { command: 'sleep 9', run_in_background: true }, { result: result({ content: 'Command running in background with ID: b77. Output is being written to: x' }) })
    const agent = call('Agent', { description: 'Review' }, { toolUseId: 'a', result: result({ agentId: 'ag1' }) })
    const turnRows: NestedTranscriptRow[] = [started, agent]
    const output = (id: string, extra: Partial<FocusedCall> = {}) => call('TaskOutput', { task_id: id }, extra)
    expect(words(focusedCallLine(output('job'), ctx({ tasks })))).toEqual(['Checked on', 'bun dev', null])
    expect(focusedCallLine(output('item'), ctx({ tasks })).target).toBe('Audit')
    expect(focusedCallLine(output('b77'), ctx({ turnRows })).target).toBe('sleep 9')
    expect(focusedCallLine(output('b7'), ctx({ turnRows })).target).toBe('a background task')
    expect(focusedCallLine(output('ag1'), ctx({ turnRows })).target).toBe('Review')
    const described = output('zz', { result: result({ taskOutput: { retrievalStatus: 'success', taskId: 'zz', taskType: 'local_bash', status: 'completed', description: 'Seeded', output: null, exitCode: 0, error: null } }) })
    expect(focusedCallLine(described, ctx()).target).toBe('Seeded')
    expect(focusedCallLine(output('none'), ctx())).toMatchObject({ target: 'a background task', targetFace: 'sans' })
    expect(focusedCallLine(pending('TaskOutput', { task_id: 'job' }, { activity: executing }), ctx({ tasks })).verb).toBe('Waiting on')
    expect(words(focusedCallLine(call('TaskStop', { task_id: 'job' }), ctx({ tasks })))).toEqual(['Stopped', 'bun dev', null])
    expect(focusedCallLine(pending('TaskStop', { task_id: 'job' }), ctx({ tasks })).verb).toBe('Stopping')
  })
  test('peer tools read as sessions', () => {
    expect(words(focusedCallLine(call('Announce', { doing: 'Fixing the cache' }), ctx()))).toEqual(['Posted notice', 'Fixing the cache', null])
    expect(focusedCallLine(pending('Announce', { doing: 'x' }), ctx()).verb).toBe('Posting notice')
    const roster = JSON.stringify({ peers: [{ name: 'Basalt', status: 'live', presence: 'running' }, { name: 'Flint', status: 'live', presence: 'idle' }] })
    const listed = focusedCallLine(call('ListPeers', {}, { result: result({ content: roster }) }), ctx())
    expect(words(listed)).toEqual(['Listed peers', 'Basalt, Flint', null])
    expect(listed.markClass).toBe('text-peer')
    expect(focusedCallLine(call('ListPeers', {}, { result: result({ content: JSON.stringify({ peers: [] }) }) }), ctx()).target).toBe('no open sessions')
    // What the tool really sends for an empty roster.
    expect(focusedCallLine(call('ListPeers', {}, { result: result({ content: 'No other sessions in this workspace.' }) }), ctx()).target).toBe('no open sessions')
    expect(focusedCallLine(call('ListPeers', {}, { result: result({ content: 'nope' }) }), ctx()).target).toBe('')
    expect(focusedCallLine(pending('ListPeers'), ctx()).target).toBe('')
    expect(words(focusedCallLine(call('ReadPeer', { peer: 'Basalt', query: ' cache ' }), ctx()))).toEqual(['Read', 'Basalt', 'cache'])
    expect(words(focusedCallLine(call('ReadPeer', { peer: 'Basalt', query: ' ' }), ctx()))).toEqual(['Read', 'Basalt', null])
    expect(focusedCallLine(call('ReadPeer', { peer: 'Basalt' }), ctx()).mark).toBe('≡')
    expect(words(focusedCallLine(pending('CreatePeer', { prompt: 'Port the tests' }, { activity: executing }), ctx()))).toEqual(['Creating a session', 'Port the tests', null])
    const created = call('CreatePeer', { prompt: 'Port the tests' }, { result: result({ createdPeer: { name: 'Flint', appSessionId: 'app' as never } }) })
    expect(words(focusedCallLine(created, ctx()))).toEqual(['Created', 'Flint', 'Port the tests'])
    expect(words(focusedCallLine(call('CreatePeer', { prompt: 'Port the tests' }), ctx()))).toEqual(['Created a session', 'Port the tests', null])
  })
  test('image generation and MCP calls', () => {
    expect(words(focusedCallLine(call('GenerateImage', { prompt: 'a cat' }), ctx()))).toEqual(['Generated image', 'a cat', null])
    expect(focusedCallLine(pending('GenerateImage', { prompt: 'a cat' }, { activity: executing }), ctx()).verb).toBe('Generating image')
    const mcp = focusedCallLine(call('mcp__cua-driver__get_window_state', {}), ctx())
    expect(words(mcp)).toEqual(['Used', 'cua-driver · get window state', null])
    expect(mcp.mark).toBe('⧉')
    expect(deriveTarget(call('mcp__cua-driver__get_window_state', {}))).toBe('cua-driver › get_window_state')
  })
  test('computer steps speak for themselves except in phases that say more', () => {
    const input = { title: 'Opening the Safari page' }
    const done = focusedCallLine(call('mcp__codex-computer-use__js', input), ctx())
    expect(done).toMatchObject({ verb: '', target: 'Opening the Safari page', targetFace: 'sans', mark: '⌖' })
    expect(focusedCallLine(pending('mcp__codex-computer-use__js', input, { activity: executing }), ctx()).verb).toBe('')
    expect(focusedCallLine(call('mcp__codex-computer-use__js', input, { status: 'error' }), ctx()).verb).toBe('')
    expect(focusedCallLine(pending('mcp__codex-computer-use__js', input, { preparing: true }), ctx()).verb).toBe('Preparing')
    expect(focusedCallLine(pending('mcp__codex-computer-use__js', input), ctx({ signalled: true })).verb).toBe('Queued')
  })
  test('questions wait on the user and report the answer', () => {
    const questions = [{ question: 'Which port?', header: 'Port', options: [{ label: '1', description: 'a' }, { label: '2', description: 'b' }], multiSelect: false }]
    const waiting = focusedCallLine(pending('AskUserQuestion', { questions }, { activity: executing }), ctx())
    expect(waiting).toMatchObject({ verb: 'Waiting for your answer', verbTone: 'queued', target: 'Which port?', targetFace: 'sans', mark: '?', markClass: 'text-accent' })
    // A blocking question arrives through the permission queue; it still waits on an answer.
    expect(focusedCallLine(pending('AskUserQuestion', { questions }, { awaitingApproval: true }), ctx())).toMatchObject({ verb: 'Waiting for your answer', verbTone: 'queued' })
    expect(focusedCallLine(pending('AskUserQuestion', { questions }, { preparing: true }), ctx()).verb).toBe('Preparing')
    const answered = call('AskUserQuestion', { questions }, { result: result({ askUserQuestion: { answers: { 'Which port?': '2' }, notesByQuestion: {} } }) })
    expect(words(focusedCallLine(answered, ctx()))).toEqual(['Asked', 'Which port?', '2'])
    expect(words(focusedCallLine(call('AskUserQuestion', { questions }), ctx()))).toEqual(['Asked', 'Which port?', null])

    const declined = call('AskUserQuestion', { questions }, { status: 'error', result: result({ isError: true, content: DECLINED }) })
    expect(focusedCallLine(declined, ctx())).toMatchObject({ phase: 'done', verb: 'Declined', target: 'Which port?' })
  })
  test('other family keeps the muted bullet', () => {
    expect(focusedCallLine(call('Mystery'), ctx())).toMatchObject({ mark: '•', markClass: 'text-text-muted' })
  })
  test('background launches report their lifecycle', () => {
    const running = pending('Bash', { command: 'dev', run_in_background: true }, { toolUseId: 'b' })
    const withJob = (status: 'running' | 'completed' | 'failed' | 'killed') =>
      ctx({ tasks: { items: [], focusedBashJobs: [{ id: 'j', toolUseId: 'b', label: 'dev', status, startTime: 0 }] } as TasksSnapshot })
    expect(focusedCallLine(running, withJob('running')).background).toEqual({ state: 'running' })
    expect(focusedCallLine(running, withJob('failed')).background).toEqual({ state: 'failed' })
    expect(focusedCallLine(running, withJob('killed')).background).toEqual({ state: 'stopped' })
    expect(focusedCallLine(running, withJob('completed')).background).toBeNull()
    expect(focusedCallLine(running, ctx()).background).toBeNull()
    const agent = (extra: Partial<FocusedCall>) => call('Agent', { description: 'd', run_in_background: true }, extra)
    expect(backgroundAgentState(agent({ status: 'pending', result: null }))).toBe('running')
    expect(backgroundAgentState(agent({}))).toBe('running')
    expect(backgroundAgentState(agent({ agentCompletion: { status: 'failed', summary: null, result: null, usage: null } }))).toBe('failed')
    expect(backgroundAgentState(agent({ agentCompletion: { status: 'killed', summary: null, result: null, usage: null } }))).toBe('stopped')
    expect(backgroundAgentState(agent({ agentCompletion: { status: 'completed', summary: null, result: null, usage: null } }))).toBeNull()
    expect(backgroundAgentState(call('Agent', { description: 'd' }))).toBeNull()
    expect(focusedCallLine(agent({}), ctx()).background).toEqual({ state: 'running' })
  })
})

describe('patch file paths', () => {
  const patch = (...paths: string[]) => ['*** Begin Patch', ...paths.flatMap((path, i) =>
    [`*** ${['Update', 'Add', 'Delete'][i % 3]} File: ${path}`, '@@', '+x']), '*** End Patch'].join('\n')
  test('reads headers in order without duplicates and only for patch tools', () => {
    const row = call('apply_patch', { input: patch('/a.ts', '/b.ts', '/c.ts') + '\n*** Update File: /a.ts' })
    expect(patchFilePaths(row)).toEqual(['/a.ts', '/b.ts', '/c.ts'])
    expect(patchFilePaths(call('Apply_patch', { input: patch('/a.ts') }))).toEqual(['/a.ts'])
    expect(patchFilePaths(call('Edit', { input: patch('/a.ts') }))).toEqual([])
    expect(patchFilePaths(call('apply_patch', { input: 3 }))).toEqual([])
  })
  test('a single header names the line but is not a file the call is known to have written', () => {
    expect(deriveTarget(call('apply_patch', { input: patch('/a.ts') }))).toBe('/a.ts')
    expect(toolCardFilePath(call('apply_patch', { input: patch('/a.ts') }))).toBeNull()
    const diff = { filePath: '/z.ts', hunks: [] }
    expect(toolCardFilePath(call('apply_patch', { input: patch('/a.ts') }, { result: result({ diff }) }))).toBe('/z.ts')
    expect(deriveTarget(call('apply_patch', { input: patch('/a.ts') }, { result: result({ diff }) }))).toBe('/z.ts')
  })
  test('finished files that share a name are spelled out', () => {
    expect(deriveTarget(call('apply_patch', { input: patch('/repo/a/index.ts', '/repo/b/index.ts') }), '/repo')).toBe('a/index.ts, b/index.ts')
  })
  test('a multi-file call reads as a count while pending and as basenames once finished', () => {
    const input = { input: patch('/repo/src/a.ts', '/repo/src/b.ts') }
    expect(deriveTarget(pending('apply_patch', input))).toBe('2 files')
    expect(deriveTarget(call('apply_patch', input))).toBe('a.ts, b.ts')
    const fileDiffs = ['/repo/x/one.ts', '/repo/x/two.ts', '/repo/x/three.ts'].map(filePath => ({ filePath, hunks: [] }))
    expect(deriveTarget(call('apply_patch', input, { result: result({ fileDiffs }) }))).toBe('one.ts, two.ts, three.ts')
    expect(deriveTarget(pending('Edit', { file_path: '/repo/a.ts' }), '/repo')).toBe('a.ts')
    expect(deriveTarget(call('apply_patch', { input: patch('/repo/a.ts') }), '/repo')).toBe('a.ts')
  })
})

test('focused email calls name the service and action without claiming a failed send succeeded', () => {
  const gmail = focusedCallLine(call('mcp__gmail__gmail_search'), ctx())
  expect(gmail).toMatchObject({ target: 'Gmail', detail: 'Search messages', targetFace: 'sans' })
  expect(focusedCallLine(call('mcp__outlook__list-accounts'), ctx())).toMatchObject({ target: 'Outlook', detail: 'List accounts' })
  const failed = focusedCallLine(call('mcp__gmail__gmail_send_message', {}, { status: 'error' }), ctx())
  expect(failed.target).toBe('Gmail')
  expect(failed.verb).not.toBe('Sent')
})

test('focused email-only discovery stays readable, while mixed discovery retains its tools', () => {
  const matches = ['mcp__gmail__gmail_search', 'mcp__outlook__list-accounts']
  const query = `select:${matches.join(',')}`
  expect(focusedCallLine(call('ToolSearch', { query }, { result: result({ toolSearch: { matches } }) }), ctx())).toMatchObject({ target: 'email tools', targetFace: 'sans' })
  expect(focusedCallLine(pending('ToolSearch', { query }), ctx())).toMatchObject({ target: 'email tools', targetFace: 'sans' })
  const mixed = focusedCallLine(call('ToolSearch', { query: 'email search' }, { result: result({ toolSearch: { matches: [matches[0]!, 'WebSearch'] } }) }), ctx())
  expect(mixed.target).toBe('email search')
})
