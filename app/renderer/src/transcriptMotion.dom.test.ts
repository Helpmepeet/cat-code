import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import type { SDKMessage } from '@cat-code/engine/session-events'
import type { ServerFrame } from '../../shared/protocol.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView, ToolInspectorOverlay } from './TranscriptView.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
  type NestedTranscriptRow,
} from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const sessionId = 'motion-session'
const ready: ServerFrame = {
  kind: 'ready', protocolVersion: 2, sessionId, engineSessionId: 'engine-motion',
  payload: {
    type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
    abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
  },
}
const frame = (message: SDKMessage): ServerFrame => ({
  kind: 'event', protocolVersion: 2, sessionId, event: { type: 'message', message },
})
type Uuid = `${string}-${string}-${string}-${string}-${string}`
const assistant = (uuid: Uuid, toolId: string, name: string, input: Record<string, unknown>): SDKMessage => ({
  type: 'assistant', uuid, parent_tool_use_id: null, session_id: 'engine-motion',
  message: { id: uuid, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name, input }] },
})
const result = (uuid: Uuid, toolId: string, content: string, isError = false): SDKMessage => ({
  type: 'user', uuid, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }] },
})
const a = '00000000-0000-4000-8000-000000000001'
const b = '00000000-0000-4000-8000-000000000002'
const c = '00000000-0000-4000-8000-000000000003'
const d = '00000000-0000-4000-8000-000000000004'
const e = '00000000-0000-4000-8000-000000000005'
const f = '00000000-0000-4000-8000-000000000006'
const g = '00000000-0000-4000-8000-000000000007'
const project = (state: ReturnType<typeof createTranscriptState>, message: SDKMessage) =>
  projectServerFrame(state, frame(message))
const rows = (state: ReturnType<typeof createTranscriptState>) =>
  selectNestedTranscriptRows(state, sessionId)
const view = (state: ReturnType<typeof createTranscriptState>, restorePhase: 'preview' | null = null) =>
  createElement(TranscriptRowsView, { rows: rows(state), restorePhase })
test('a split-commit regroup alone does not animate result bodies; the pending member resolving does', async () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = project(state, assistant(b, 'read-1', 'Read', { file_path: '/repo/one.ts' }))
  const tree = await harness.mount(view(state))
  state = project(state, assistant(c, 'read-2', 'Read', { file_path: '/repo/two.ts' }))
  await tree.render(view(state))
  expect(tree.container.querySelector('[data-row-key^="read-run:"]')).not.toBeNull()
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()

  state = project(state, result(d, 'read-1', 'File not found', true))
  await tree.render(view(state))
  expect(tree.container.querySelector('.animate-arrive')).not.toBeNull()
  await tree.unmount()
  const remount = await harness.mount(view(state))
  expect(remount.container.querySelector('.animate-arrive')).toBeNull()
})

test('projected pending tool result fades its new peek or expanded error body only while mounted', async () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = project(state, assistant(a, 'bash-1', 'Bash', { command: 'echo hello' }))
  const tree = await harness.mount(view(state))
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()

  state = project(state, result(b, 'bash-1', 'hello'))
  await tree.render(view(state))
  expect(tree.container.querySelector('.animate-arrive')).not.toBeNull()
  await tree.unmount()
  const settled = await harness.mount(view(state))
  expect(settled.container.querySelector('.animate-arrive')).toBeNull()

  let failed = projectServerFrame(createTranscriptState(), ready)
  failed = project(failed, assistant(c, 'bash-2', 'Bash', { command: 'exit 1' }))
  await settled.render(view(failed))
  failed = project(failed, result(d, 'bash-2', 'failed', true))
  await settled.render(view(failed))
  expect(settled.container.querySelector('.animate-arrive')).not.toBeNull()
})

test('result replay during restore stays still', async () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = project(state, assistant(e, 'bash-restore', 'Bash', { command: 'echo restored' }))
  const tree = await harness.mount(view(state, 'preview'))
  state = project(state, result(f, 'bash-restore', 'restored'))
  await tree.render(view(state, 'preview'))
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()
  await tree.render(view(state))
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()
})

test('generated image body fades on a mounted pending result and stays still after remount', async () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = project(state, assistant(e, 'image-1', 'GenerateImage', { prompt: 'a cat' }))
  const pending = rows(state)
  const tree = await harness.mount(createElement(TranscriptRowsView, { rows: pending }))
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()
  const done: NestedTranscriptRow[] = pending.map(row => row.kind === 'tool-use'
    ? {
        ...row,
        status: 'success',
        result: {
          isError: false, content: 'saved', diff: null,
          generatedImage: {
            filePath: '/tmp/cat.png', model: 'gpt-image-2', size: '1024x1024',
            outputFormat: 'png', bytes: 4,
            preview: { mediaType: 'image/png', data: 'AAAA' },
          },
        },
      }
    : row)
  await tree.render(createElement(TranscriptRowsView, { rows: done }))
  expect(tree.container.querySelector('img[alt="Generated image"]')).not.toBeNull()
  expect(tree.container.querySelector('img[alt="Generated image"]')?.parentElement?.classList.contains('animate-arrive')).toBe(true)
  await tree.unmount()
  const remount = await harness.mount(createElement(TranscriptRowsView, { rows: done }))
  expect(remount.container.querySelector('.animate-arrive')).toBeNull()
})

test('an added reasoning step fades while its existing head stays instant', async () => {
  const source: NestedTranscriptRow = {
    id: 'thinking-1', sessionId, messageId: 'reasoning', frameId: a,
    blockIndex: 0, parentToolUseId: null, kind: 'thinking', content: 'Inspecting files', children: [],
  }
  const tree = await harness.mount(createElement(TranscriptRowsView, { rows: [source] }))
  expect(tree.container.querySelector('.animate-arrive')).toBeNull()
  await tree.render(createElement(TranscriptRowsView, {
    rows: [{ ...source, content: 'Inspecting files\n\nChecking output' }],
  }))
  expect(tree.container.querySelectorAll('li.animate-arrive')).toHaveLength(1)
  expect(tree.container.querySelector('button.animate-arrive')).toBeNull()
  await tree.unmount()
  const remount = await harness.mount(createElement(TranscriptRowsView, {
    rows: [{ ...source, content: 'Inspecting files\n\nChecking output' }],
  }))
  expect(remount.container.querySelector('.animate-arrive')).toBeNull()
  await remount.render(createElement(TranscriptRowsView, {
    rows: [{ ...source, content: 'Inspecting files\n\nChecking output\n\nRestored step' }],
    restorePhase: 'preview',
  }))
  expect(remount.container.querySelector('.animate-arrive')).toBeNull()
})

test('inspector animates an open action, not a pre-opened mount or remount', async () => {
  let state = projectServerFrame(createTranscriptState(), ready)
  state = project(state, assistant(f, 'bash-3', 'Bash', { command: 'echo detail' }))
  state = project(state, result(g, 'bash-3', 'detail'))
  const row = rows(state).find(row => row.kind === 'tool-use')
  if (!row || row.kind !== 'tool-use') throw new Error('projector lost tool card')
  const closed = await harness.mount(createElement(ToolInspectorOverlay, { row: null, onClose: () => {} }))
  await closed.render(createElement(ToolInspectorOverlay, { row, onClose: () => {} }))
  expect(closed.container.querySelector('.animate-scrim-in')).not.toBeNull()
  expect(closed.container.querySelector('.animate-drawer-in')).not.toBeNull()
  await closed.unmount()
  const remount = await harness.mount(createElement(ToolInspectorOverlay, { row, onClose: () => {} }))
  expect(remount.container.querySelector('.animate-scrim-in')).toBeNull()
  expect(remount.container.querySelector('.animate-drawer-in')).toBeNull()
})
