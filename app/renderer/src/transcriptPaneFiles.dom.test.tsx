import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { FilePaneContext } from './filePaneContext.js'
import { LatestPaneFileCardContext, latestPaneFileCards } from './transcriptPaneFiles.js'
import { ToolCardStyleContext, type ToolCardStyle } from './toolCardStyle.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
let oldBridge: PropertyDescriptor | undefined
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  window.getSelection()?.removeAllRanges()
  if (oldBridge) Object.defineProperty(window, 'catcode', oldBridge)
  else Reflect.deleteProperty(window, 'catcode')
})
afterAll(async () => { await harness.teardown() })

const base = { sessionId: 'pane-entry-session', frameId: 'f', messageId: 'm', blockIndex: 0, parentToolUseId: null, children: [] }
function prose(content: string): NestedTranscriptRow {
  return { ...base, id: 'reply', kind: 'assistant-text', role: 'assistant', content }
}
function fileCard(id: string, family: 'write' | 'edit', path: string): NestedToolUseRow {
  return { ...base, id, toolUseId: id, kind: 'tool-use', toolName: family === 'write' ? 'Write' : 'Edit',
    toolFamily: family, input: { file_path: path, content: 'body' }, status: 'pending', agentCompletion: null, result: null }
}
function installBridge(external: string[]) {
  oldBridge = Object.getOwnPropertyDescriptor(window, 'catcode')
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    openWorkspaceFile: async (_id: string, path: string) => { external.push(path); return true },
    getWorkspaceFileAvailability: async () => true,
  } })
}
function openButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]')]
}

test('all reply path forms send modifier intent to the pane while other file types retain their existing opener', async () => {
  const external: string[] = []
  installBridge(external)
  const requests: Array<{ sessionId: string; path: string; external: boolean }> = []
  const opener = async (sessionId: string, path: string, options?: { external?: boolean }) => {
    requests.push({ sessionId, path, external: options?.external === true }); return { ok: true as const }
  }
  const cases = [
    ['[Notes](notes.md:12)', './notes.md:12'],
    ['See notes.md:12', 'notes.md:12'],
    ['`notes.md:12`', 'notes.md:12'],
  ]
  for (const [content, expected] of cases) {
    const tree = await harness.mount(<FilePaneContext.Provider value={opener}><TranscriptRowsView rows={[prose(content)]} /></FilePaneContext.Provider>)
    const button = openButtons(tree.container)[0]!
    expect(button).toBeDefined()
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    expect(requests.at(-1)).toEqual({ sessionId: base.sessionId, path: expected, external: true })
    await tree.unmount()
  }
  const tree = await harness.mount(<FilePaneContext.Provider value={opener}><TranscriptRowsView rows={[prose('`source.ts:12`')]} /></FilePaneContext.Provider>)
  await act(async () => { openButtons(tree.container)[0]!.click() })
  expect(external).toEqual(['source.ts:12'])
  expect(requests).toHaveLength(3)
})

test('selected path text keeps the normal text menu and an unselected path keeps file actions', async () => {
  installBridge([])
  const tree = await harness.mount(<TranscriptRowsView rows={[prose('`notes.md`')]} cwd="/repo" />)
  const path = openButtons(tree.container)[0]!
  const range = document.createRange()
  range.selectNodeContents(path.querySelector('code')!)
  window.getSelection()!.addRange(range)
  const selectedMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => { path.dispatchEvent(selectedMenu) })
  expect(selectedMenu.defaultPrevented).toBe(false)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  window.getSelection()!.removeAllRanges()
  const fileMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => { path.dispatchEvent(fileMenu) })
  expect(fileMenu.defaultPrevented).toBe(true)
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Copy')
})

test('new relative HTML links after a move open in their recorded project in every reply form', async () => {
  installBridge([])
  const requests: Array<{ path: string; external: boolean }> = []
  const relative = 'docs/design-html/2026-10-31-project-trust-for-workspace-jump.html'
  const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
  for (const content of [
    `The file is new and untracked: \`${relative}\`.`,
    `The file is new and untracked: ${relative}.`,
    `[Open the design](${relative})`,
  ]) {
    const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path, options) => {
      requests.push({ path, external: options?.external === true }); return { ok: true }
    }}>
      <TranscriptRowsView rows={[boundary, prose(content)]} cwd="/Users/pt/cat-code"
        contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/Users/pt/cat-code', binding: { kind: 'project' } }]} />
    </FilePaneContext.Provider>)
    const button = openButtons(tree.container)[0]!
    await act(async () => { button.click() })
    expect(requests.at(-1)).toEqual({ path: `/Users/pt/cat-code/${relative}`, external: false })
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    expect(requests.at(-1)).toEqual({ path: `/Users/pt/cat-code/${relative}`, external: true })
    await tree.unmount()
  }
})

test('a relative link menu uses the same recorded workspace as its click', async () => {
  installBridge([])
  const checked: string[] = []
  window.catcode.getWorkspaceFileAvailability = async (_id, path) => { checked.push(path); return true }
  const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
  const tree = await harness.mount(<TranscriptRowsView rows={[boundary, prose('`docs/report.html`')]} cwd="/repo"
    contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/repo', binding: { kind: 'project' } }]} />)
  await act(async () => { openButtons(tree.container)[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  expect(checked).toEqual(['/repo/docs/report.html'])
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Open in')
})

test('older replies are not resolved against a later workspace, even when filenames match', async () => {
  installBridge([])
  const requests: string[] = []
  const rows = [
    { ...prose('`report.html`'), id: 'before', frameId: 'before' },
    { ...prose('First move'), id: 'first', frameId: 'first' },
    { ...prose('`report.html`'), id: 'middle', frameId: 'middle' },
    { ...prose('Second move'), id: 'second', frameId: 'second' },
    { ...prose('`report.html`'), id: 'after', frameId: 'after' },
  ]
  const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path) => {
    requests.push(path); return { ok: true }
  }}>
    <TranscriptRowsView rows={rows} cwd="/two" contextTransitions={[
      { id: 'one', afterFrameId: 'first', cwd: '/one', binding: { kind: 'project' } },
      { id: 'two', afterFrameId: 'second', cwd: '/two', binding: { kind: 'project' } },
    ]} />
  </FilePaneContext.Provider>)
  for (const button of openButtons(tree.container)) await act(async () => { button.click() })
  expect(requests).toEqual(['report.html', '/one/report.html', '/two/report.html'])
})

test('only the newest Write or Edit has a sibling Open action in both card styles, including pending edits', async () => {
  installBridge([])
  for (const style of ['cards', 'lines'] as ToolCardStyle[]) {
    for (const grouped of [false, true]) {
    const requests: string[] = []
    const rows = [fileCard('old-write', grouped ? 'edit' : 'write', '/repo/notes.md'), fileCard('new-edit', 'edit', '/repo/notes.md')]
    const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path) => { requests.push(path); return { ok: true as const } }}>
      <ToolCardStyleContext.Provider value={{ style, setStyle() {} }}>
        <TranscriptRowsView rows={rows} cwd="/repo" />
      </ToolCardStyleContext.Provider>
    </FilePaneContext.Provider>)
    const buttons = openButtons(tree.container)
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.parentElement?.closest('button')).toBeNull()
    const headers = [...tree.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
    expect(headers.map(button => button.getAttribute('aria-expanded'))).toEqual(headers.map(() => 'false'))
    await act(async () => { buttons[0]!.click() })
    expect(requests).toEqual(['/repo/notes.md'])
    expect(headers.map(button => button.getAttribute('aria-expanded'))).toEqual(headers.map(() => 'false'))
    if (grouped) {
      await act(async () => { headers[0]!.click() })
      expect(openButtons(tree.container)).toHaveLength(1)
    }
    await tree.unmount()
    }
  }
})

test('relative Write and Edit preview actions use the recorded workspace after a move', async () => {
  installBridge([])
  const requests: string[] = []
  for (const family of ['write', 'edit'] as const) {
    const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
    const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path) => {
      requests.push(path); return { ok: true }
    }}>
      <TranscriptRowsView rows={[boundary, fileCard('file', family, 'docs/report.html')]} cwd="/repo"
        contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/repo', binding: { kind: 'project' } }]} />
    </FilePaneContext.Provider>)
    await act(async () => { openButtons(tree.container)[0]!.click() })
    expect(requests.at(-1)).toBe('/repo/docs/report.html')
    await tree.unmount()
  }
})

test('Focused file cards remain folded and reveal one Open after expansion, including grouped edits', async () => {
  installBridge([])
  for (const style of ['cards', 'lines'] as ToolCardStyle[]) {
    for (const grouped of [false, true]) {
      const rows = grouped ? [fileCard('edit-a', 'edit', '/repo/notes.md'), fileCard('edit-b', 'edit', '/repo/notes.md')]
        : [fileCard('write-a', 'write', '/repo/notes.md')]
      const tree = await harness.mount(<FilePaneContext.Provider value={async () => ({ ok: true })}>
        <ToolCardStyleContext.Provider value={{ style, setStyle() {} }}>
          <TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
            <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}>
              <TranscriptRowsView rows={rows} cwd="/repo" />
            </ToolsExpandedContext.Provider>
          </TranscriptModeContext.Provider>
        </ToolCardStyleContext.Provider>
      </FilePaneContext.Provider>)
      expect(openButtons(tree.container)).toHaveLength(0)
      const step = tree.container.querySelector<HTMLButtonElement>('.focused-step-head')
      if (step?.getAttribute('aria-expanded') === 'false') await act(async () => { step.click() })
      const header = tree.container.querySelector('[data-file-actions]')?.closest<HTMLButtonElement>('button')!
      expect(header).not.toBeNull()
      expect(header.getAttribute('aria-expanded')).toBe('false')
      await act(async () => { header.click() })
      expect(openButtons(tree.container)).toHaveLength(1)
      await tree.unmount()
    }
  }
})

test('a session-level newest-card map also applies inside a worker transcript view', async () => {
  installBridge([])
  const oldParent = fileCard('parent-edit', 'edit', '/repo/notes.md')
  const newWorker = { ...fileCard('worker-edit', 'edit', 'notes.md'), parentToolUseId: 'agent' }
  const latest = latestPaneFileCards([oldParent, newWorker], '/repo', ['parent-edit', 'worker-edit'])
  const tree = await harness.mount(<FilePaneContext.Provider value={async () => ({ ok: true })}>
    <LatestPaneFileCardContext.Provider value={latest}>
      <TranscriptRowsView rows={[oldParent]} cwd="/repo" />
      <div aria-label="Worker transcript"><TranscriptRowsView rows={[newWorker]} cwd="/repo" /></div>
    </LatestPaneFileCardContext.Provider>
  </FilePaneContext.Provider>)
  expect(openButtons(tree.container)).toHaveLength(1)
  expect(tree.container.querySelector('[aria-label="Worker transcript"]')?.contains(openButtons(tree.container)[0]!)).toBe(true)
})
