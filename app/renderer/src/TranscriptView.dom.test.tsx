import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'

import { createDomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { WorkspaceMoveDisplay } from '../../shared/hostApi.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const content = [
  'Copy this **raw source**.',
  '',
  '```ts',
  'const answer = 42',
  '```',
].join('\n')

const row: NestedTranscriptRow = {
  sessionId: 'session-42',
  messageId: 'message-42',
  frameId: 'frame-42',
  blockIndex: 0,
  parentToolUseId: null,
  id: 'session-42:message-42:0:user-text',
  kind: 'user-text',
  role: 'user',
  content,
  isReplay: false,
  children: [],
}

test('Copy message writes the original raw Markdown source', async () => {
  const writes: string[] = []
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'clipboard',
  )
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        writes.push(value)
      },
    },
  })

  try {
    const tree = await harness.mount(
      <TranscriptRowsView rows={[row]} onMessageAction={() => {}} />,
    )
    const copyMessage = tree.container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy message"]',
    )
    const copyCode = tree.container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy code"]',
    )
    expect(copyCode).not.toBeNull()
    expect(copyMessage).not.toBeNull()

    await act(async () => {
      copyMessage?.click()
    })

    expect(writes).toEqual([content])
  } finally {
    if (descriptor === undefined) {
      delete (globalThis.navigator as Navigator & { clipboard?: unknown }).clipboard
    } else {
      Object.defineProperty(globalThis.navigator, 'clipboard', descriptor)
    }
  }
})

test('Edit and Branch report the row session, verb, and frame id', async () => {
  const actions: Array<[string, string, string]> = []
  const tree = await harness.mount(
    <TranscriptRowsView
      rows={[row]}
      onMessageAction={(sessionId, action, messageId) => {
        actions.push([sessionId, action, messageId])
      }}
    />,
  )

  const edit = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Edit from here"]',
  )
  const branch = tree.container.querySelector<HTMLButtonElement>(
    '[aria-label="Branch from here"]',
  )
  expect(edit).not.toBeNull()
  expect(branch).not.toBeNull()

  await act(async () => {
    edit?.click()
    branch?.click()
  })

  expect(actions).toEqual([
    ['session-42', 'edit', 'frame-42'],
    ['session-42', 'branch', 'frame-42'],
  ])
})

test('workspace moves replace tool cards in place and animate only a live arrival', async () => {
  const target = { kind: 'project' as const, name: 'cat-code', path: '/projects/cat-code', displayPath: '~/cat-code' }
  const source = { ...row, id: 'before', frameId: 'before', content: 'Before move' }
  const tool = (toolName: string): NestedTranscriptRow => ({
    ...row, id: toolName, frameId: 'jump-frame', kind: 'tool-use', toolName,
    toolUseId: toolName, toolFamily: 'other', input: { destination: 'opaque-handle' },
    status: 'pending', result: null, children: [],
  })
  let rows = [source, tool('ListWorkspaces'), tool('JumpWorkspace')]
  const move = { id: 'move', phase: 'moving' as const, target }
  const arrived = { ...move, phase: 'arrived' as const, transitionId: 'seam', afterFrameId: 'jump-frame' }
  const seam = { id: 'seam', afterFrameId: 'jump-frame', cwd: target.path, binding: { kind: 'project' as const } }
  let seamCommitted = false
  const draw = (workspaceMove: WorkspaceMoveDisplay | null, restored = false) => (
    <TranscriptRowsView rows={rows} workspaceMove={workspaceMove} cwd={target.path}
      contextTransitions={seamCommitted ? [seam] : []}
      restorePhase={restored ? 'preview' : null} onMoveBack={() => {}} />
  )
  const tree = await harness.mount(draw(null))
  expect(tree.container.textContent).not.toContain('ListWorkspaces')
  expect(tree.container.textContent).not.toContain('JumpWorkspace')
  await tree.render(draw(move))
  const divider = tree.container.querySelector('[data-workspace-move="move"]')
  expect(divider?.textContent).toContain('Moving to cat-code ~/cat-code')
  expect(divider?.querySelector('.animate-pulse')).not.toBeNull()
  seamCommitted = true
  await tree.render(draw({ ...move, transitionId: 'seam', afterFrameId: 'jump-frame' }))
  expect(tree.container.querySelectorAll('.chat-project-divider')).toHaveLength(1)
  expect(tree.container.querySelector('[data-workspace-move="move"]')).toBe(divider)
  expect(divider?.textContent).toContain('Moving to cat-code')
  rows = [...rows, { ...source, id: 'reply', frameId: 'reply', content: 'After move' }]
  await tree.render(draw(arrived))
  expect(tree.container.querySelector('[data-workspace-move="move"]')).toBe(divider)
  expect(divider?.textContent).toContain('Working in cat-code')
  expect(divider?.textContent).not.toContain('~/cat-code')
  expect(divider?.querySelector('[aria-label="Move back"]')).not.toBeNull()
  expect(tree.container.querySelectorAll('.chat-project-divider')).toHaveLength(1)
  expect(divider?.nextElementSibling?.textContent).toContain('After move')
  expect(divider?.querySelector('.workspace-arrival-wash')).not.toBeNull()
  await tree.render(draw(arrived))
  expect(tree.container.querySelector('[data-workspace-move="move"]')).toBe(divider)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1850)) })
  await tree.render(draw({ ...arrived }))
  expect(divider?.querySelector('.workspace-arrival-wash')).toBeNull()
  await tree.render(<TranscriptRowsView rows={rows} contextTransitions={[seam]}
    workspaceMove={{ id: 'return', phase: 'moving', target: { kind: 'chat', name: 'Chat', path: null } }} />)
  const returnDivider = tree.container.querySelector('[data-workspace-move="return"]')
  expect(returnDivider?.previousElementSibling?.textContent).toContain('After move')
  expect(returnDivider?.textContent).toBe('Moving to Chat')
  await tree.unmount()
  const restored = await harness.mount(draw(arrived, true))
  expect(restored.container.querySelector('.workspace-arrival-wash')).toBeNull()
  await restored.render(draw(arrived))
  expect(restored.container.querySelector('.workspace-arrival-wash')).toBeNull()
})

test('failed and stopped moves use the same neutral seam; Chat has no folder or path', async () => {
  const target = { kind: 'chat' as const, name: 'Chat', path: null }
  const move = { id: 'manual', phase: 'moving' as const, target }
  const tree = await harness.mount(<TranscriptRowsView rows={[row]} workspaceMove={move} />)
  const divider = tree.container.querySelector('[data-workspace-move="manual"]')
  for (const [phase, caption] of [['failed', 'Could not move to'], ['stopped', 'Stopped moving to'], ['arrived', 'Working in']] as const) {
    await tree.render(<TranscriptRowsView rows={[row]} workspaceMove={{ ...move, phase }} />)
    expect(tree.container.querySelector('[data-workspace-move="manual"]')).toBe(divider)
    expect(divider?.textContent).toBe(caption + ' Chat')
    expect(divider?.querySelector('svg')).toBeNull()
    expect(divider?.querySelector('.workspace-move-path')).toBeNull()
    expect(divider?.querySelector('.workspace-move-dot')).toBeNull()
  }
})

test('reduced motion rests immediately, while uncertain arrival retains its action notice', async () => {
  const original = window.matchMedia
  window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' } as MediaQueryList)
  try {
    const target = { kind: 'project' as const, name: 'cat-code', path: '/projects/cat-code' }
    const moving = { id: 'reduced', phase: 'moving' as const, target }
    const notice: NestedTranscriptRow = {
      ...row, id: 'notice', frameId: 'notice', kind: 'system-notice', noticeType: 'local_command_output',
      content: 'The workspace changed, but completion could not be confirmed. Some work may have started. Send a message to review what happened.',
    }
    const tree = await harness.mount(<TranscriptRowsView rows={[row]} />)
    await tree.render(<TranscriptRowsView rows={[row]} workspaceMove={moving} />)
    await tree.render(<TranscriptRowsView rows={[row, notice]} workspaceMove={{ ...moving, phase: 'arrived' }} />)
    expect(tree.container.textContent).toContain('Working in cat-code')
    expect(tree.container.textContent).toContain(notice.content)
    expect(tree.container.querySelector('.workspace-arrival-wash')).toBeNull()
    // Main's authoritative outcome metadata names exactly which notice the
    // stopped/failed divider replaces, rather than classifying output prose.
    const failure = { ...notice, content: 'The workspace change could not finish. Work did not continue. Send a message when you are ready to continue.' }
    await tree.render(<TranscriptRowsView rows={[row, failure]} workspaceMove={{ ...moving, phase: 'failed', replacedNotice: failure.content }} />)
    expect(tree.container.textContent).toContain('Could not move to cat-code')
    expect(tree.container.textContent).not.toContain(failure.content)
  } finally {
    window.matchMedia = original
  }
})

test('an empty Chat arrival does not restart when its first message replaces Welcome', async () => {
  const target = { kind: 'chat' as const, name: 'Chat', path: null }
  const tree = await harness.mount(<TranscriptRowsView rows={[]} />)
  await tree.render(<TranscriptRowsView rows={[]} workspaceMove={{ id: 'empty', phase: 'moving', target }} />)
  await tree.render(<TranscriptRowsView rows={[]} workspaceMove={{ id: 'empty', phase: 'arrived', target }} />)
  const divider = tree.container.querySelector('[data-workspace-move="empty"]')
  expect(divider?.querySelector('.workspace-arrival-wash')).not.toBeNull()
  await tree.render(<TranscriptRowsView rows={[row]} workspaceMove={{ id: 'empty', phase: 'arrived', target }} />)
  const nextDivider = tree.container.querySelector('[data-workspace-move="empty"]')
  expect(nextDivider).not.toBe(divider)
  expect(nextDivider?.textContent).toBe('Working in Chat')
  expect(nextDivider?.querySelector('.workspace-arrival-wash')).toBeNull()
})
