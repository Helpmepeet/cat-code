import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppState.js'
import { KeybindingProvider } from '../../keybindings/KeybindingContext.js'
import { parseBindings } from '../../keybindings/parser.js'
import { CodeModeTask, registerCodeModeTask, type CodeModeTaskState } from '../../tasks/CodeModeTask.js'
import { cleanupTaskOutput } from '../../utils/task/diskOutput.js'
import { BackgroundTasksDialog } from './BackgroundTasksDialog.js'
import { CodeModeDetailDialog } from './CodeModeDetailDialog.js'
import { useBackgroundTaskNavigation } from '../../hooks/useBackgroundTaskNavigation.js'

function cell(extra: Partial<CodeModeTaskState> = {}): CodeModeTaskState {
  return {
    id: 'code-ui', type: 'code_mode', description: 'Code job', status: 'running',
    startTime: 3, outputFile: '', outputOffset: 0, notified: false,
    owner: { sessionId: 'test-session' }, cellId: 'cell', generation: 'generation',
    cancellationRequested: false, settled: false, delivery: 'pending',
    receipt: { kind: 'code-mode', cellId: 'cell', generation: 'generation', description: 'Code job',
      code: 'PRIVATE_SOURCE', status: 'running', output: 'Selected UI output',
      calls: [{ toolUseId: 'private-call', name: 'Read', status: 'completed', input: 'PRIVATE_INPUT', result: 'PRIVATE_RESULT' }], changedFiles: [] },
    ...extra,
  }
}
const bindings = parseBindings([{ context: 'Confirmation', bindings: { down: 'confirm:next', up: 'confirm:previous', enter: 'confirm:yes', escape: 'confirm:no' } }])
const flush = () => new Promise(resolve => setTimeout(resolve, 35))
async function mount(node: React.ReactNode, tasks: AppState['tasks']) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  Object.assign(stdout, { columns: 140, rows: 60 })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream
  const instance = await render(<ThemeProvider><AppStateProvider initialState={{ ...getDefaultAppState(), tasks }}>
    <KeybindingProvider bindings={bindings} pendingChordRef={{ current: null }} pendingChord={null} setPendingChord={() => {}}
      activeContexts={new Set(['Confirmation'])} registerActiveContext={() => {}} unregisterActiveContext={() => {}} handlerRegistryRef={{ current: new Map() }}>
      {node}
    </KeybindingProvider>
  </AppStateProvider></ThemeProvider>, { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false })
  await flush()
  return { text: () => stripAnsi(output), clear: () => { output = '' },
    async key(key: string) { (stdin as unknown as PassThrough).write(key); await flush() },
    close: () => instance.unmount() }
}

test('Code Mode alone opens real detail, shows selected output and distinguishes cancellation request from settlement', async () => {
  const task = cell({ cancellationRequested: true })
  const ui = await mount(<BackgroundTasksDialog toolUseContext={{} as never} onDone={() => {}} />, { [task.id]: task })
  try {
    expect(ui.text()).toContain('Code Mode task')
    expect(ui.text()).toContain('Selected UI output')
    expect(ui.text()).toContain('Cancellation requested. Waiting for execution to settle.')
    expect(ui.text()).not.toContain('PRIVATE_')
    expect(ui.text()).not.toContain('killed')
  } finally { ui.close() }
})

test('mixed task dialog preserves group order, navigates into Code Mode detail and dispatches both stop shortcuts', async () => {
  const task = cell()
  const shell = { id: 'shell-ui', type: 'local_bash', status: 'running', description: 'Shell job', command: 'echo shell', startTime: 1, isBackgrounded: true, outputFile: '', shellCommand: null } as never
  const agent = { id: 'agent-ui', type: 'local_agent', status: 'running', description: 'Agent job', agentId: 'agent-ui', agentType: 'Explore', startTime: 2, isBackgrounded: true, pendingMessages: [], lastReportedToolCount: 0, lastReportedTokenCount: 0 } as never
  const stop = spyOn(CodeModeTask, 'kill').mockResolvedValue(undefined)
  const ui = await mount(<BackgroundTasksDialog toolUseContext={{} as never} onDone={() => {}} />, { [task.id]: task, 'shell-ui': shell, 'agent-ui': agent })
  try {
    expect(ui.text()).toContain('Background tasks')
    expect(ui.text()).toContain('Code Mode')
    expect(ui.text().indexOf('echo shell')).toBeLessThan(ui.text().indexOf('Explore'))
    expect(ui.text().indexOf('Explore')).toBeLessThan(ui.text().indexOf('Code job'))
    await ui.key('\x1b[B')
    await ui.key('\x1b[B')
    await ui.key('x')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop.mock.calls[0]![0]).toBe(task.id)
    ui.clear()
    await ui.key('\r')
    expect(ui.text()).toContain('Code Mode task')
    expect(ui.text()).toContain('Selected UI output')
    await ui.key('x')
    expect(stop).toHaveBeenCalledTimes(2)
    expect(stop.mock.calls[1]![0]).toBe(task.id)
    ui.clear()
    await ui.key('\x1b[D')
    expect(ui.text()).toContain('Background tasks')
  } finally { ui.close(); stop.mockRestore() }
})

test('compact delivered detail loads verified selected artifact without full receipt', async () => {
  let state = getDefaultAppState()
  const result = { ...cell().receipt!, status: 'completed' as const }
  const handle = registerCodeModeTask({ owner: { sessionId: 'ui-archive-test' }, cellId: result.cellId, generation: result.generation,
    description: 'Archived Code job', completion: Promise.resolve({ result, value: null }), cancel: () => {}, setAppState: update => { state = update(state) } })
  try {
    await handle.deliver(async () => {})
    const task = state.tasks[handle.taskId] as CodeModeTaskState
    expect(task.receipt).toBeUndefined()
    const ui = await mount(<BackgroundTasksDialog toolUseContext={{} as never} onDone={() => {}} initialDetailTaskId={task.id} />, { [task.id]: task })
    try {
      expect(ui.text()).toContain('Selected UI output')
      expect(ui.text()).not.toContain('PRIVATE_')
      expect(ui.text()).not.toContain('unavailable')
    } finally { ui.close() }
  } finally { await cleanupTaskOutput(handle.taskId) }
})

test('compact detail fails closed when selected artifact is unavailable', async () => {
  const task = cell({ receipt: undefined, settled: true, status: 'completed', outputArchived: true, delivery: 'delivered' })
  const ui = await mount(<CodeModeDetailDialog task={task} onDone={() => {}} onStop={async () => { throw new Error('must not stop') }} />, { [task.id]: task })
  try { expect(ui.text()).toContain('Archived Code Mode output is unavailable.') } finally { ui.close() }
})

test('terminal Code Mode summary remains reachable through normal background navigation', async () => {
  let opened = 0
  function Navigation() { useBackgroundTaskNavigation({ onOpenBackgroundTasks: () => { opened++ } }); return null }
  const task = cell({ receipt: undefined, settled: true, status: 'completed', delivery: 'delivered' })
  const ui = await mount(<Navigation />, { [task.id]: task })
  try {
    await ui.key('\x1b[1;2B')
    expect(opened).toBe(1)
  } finally { ui.close() }
})
