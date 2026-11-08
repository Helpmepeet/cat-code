import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { FilePaneContext } from './filePaneContext.js'
import { disposeWorkspaceFileAvailability } from './workspaceFileAvailabilityQueue.js'
import { LatestPaneFileCardContext, latestPaneFileCards } from './transcriptPaneFiles.js'
import { ToolCardStyleContext, type ToolCardStyle } from './toolCardStyle.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToastContext } from './toastContext.js'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
let oldBridge: PropertyDescriptor | undefined
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => {
  await harness.unmountAll()
  disposeWorkspaceFileAvailability(base.sessionId)
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
    checkWorkspaceFileAvailability: async () => 'available',
  } })
}
function openButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]')]
}

test('all reply path forms and source files send modifier intent to the pane', async () => {
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
  expect(external).toEqual([])
  expect(requests).toHaveLength(4)
  expect(requests.at(-1)).toEqual({ sessionId: base.sessionId, path: 'source.ts:12', external: false })
})

test('a missing non-joiner-prefixed Source link quietly retries its absolute path after a workspace move', async () => {
  installBridge([])
  const requests: string[] = []
  const toasts: string[] = []
  const path = '/repo/src/memoryTypes.ts:43'
  const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
  const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
    <FilePaneContext.Provider value={async (_id, target) => {
      requests.push(target)
      return target === path ? { ok: true } : { ok: false, reason: 'missing', message: 'Could not find memoryTypes.ts' }
    }}>
      <TranscriptRowsView rows={[boundary, prose(`[Source](\u200c${path})`)]} cwd="/other-project"
        contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/other-project', binding: { kind: 'project' } }]} />
    </FilePaneContext.Provider>
  </ToastContext.Provider>)
  expect(requests).toEqual([])
  const button = openButtons(tree.container)[0]!
  expect(button.textContent).toBe('Source')
  await act(async () => { button.click() })
  expect(requests).toEqual([`/other-project/\u200c${path}`, path])
  expect(toasts).toEqual([])
})

test('file link recovery preserves successful literal filenames and does not retry preview refusals', async () => {
  installBridge([])
  const path = '\u200c/repo/file.ts:12'
  for (const result of [
    { ok: true as const },
    { ok: false as const, reason: 'refused', message: 'Could not open this file' },
    { ok: false as const, reason: 'busy', message: 'Could not open this file' },
  ]) {
    const requests: string[] = []
    const toasts: string[] = []
    const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
      <FilePaneContext.Provider value={async (_id, target) => { requests.push(target); return result }}>
        <TranscriptRowsView rows={[prose(`[File](${path})`)]} />
      </FilePaneContext.Provider>
    </ToastContext.Provider>)
    await act(async () => { openButtons(tree.container)[0]!.click() })
    expect(requests).toEqual([path])
    expect(toasts).toEqual(result.ok ? [] : [result.message])
    await tree.unmount()
  }
})

test('an unsuccessful cleaned file link still reports one failure', async () => {
  installBridge([])
  const requests: string[] = []
  const toasts: string[] = []
  const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
    <FilePaneContext.Provider value={async (_id, path) => {
      requests.push(path); return { ok: false, reason: 'missing', message: 'Could not find missing.ts' }
    }}>
      <TranscriptRowsView rows={[prose('[File](%E2%80%8C/repo/missing.ts)')]} />
    </FilePaneContext.Provider>
  </ToastContext.Provider>)
  await act(async () => { openButtons(tree.container)[0]!.click() })
  expect(requests).toEqual(['\u200c/repo/missing.ts', '/repo/missing.ts'])
  expect(toasts).toEqual(['Could not find missing.ts'])
})

test('file links without a preview opener also try the literal path before recovery', async () => {
  installBridge([])
  const requests: string[] = []
  const toasts: string[] = []
  window.catcode.checkWorkspaceFileAvailability = async () => 'missing'
  window.catcode.openWorkspaceFile = async (_id, path) => { requests.push(path); return path === '/repo/file.ts:12' }
  const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
    <TranscriptRowsView rows={[prose('[File](\u200c/repo/file.ts:12)')]} />
  </ToastContext.Provider>)
  await act(async () => { openButtons(tree.container)[0]!.click() })
  expect(requests).toEqual(['\u200c/repo/file.ts:12', '/repo/file.ts:12'])
  expect(toasts).toEqual([])
})

test('external recovery preserves modifier intent and does not reinterpret available or busy literal files', async () => {
  installBridge([])
  for (const availability of ['missing', 'available', 'busy'] as const) {
    const requests: Array<{ path: string; external: boolean }> = []
    const toasts: string[] = []
    window.catcode.checkWorkspaceFileAvailability = async () => availability
    const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
      <FilePaneContext.Provider value={async (_id, path, options) => {
        requests.push({ path, external: options?.external === true })
        return path === '/repo/file.ts' ? { ok: true } : { ok: false, message: 'Could not open this file' }
      }}>
        <TranscriptRowsView rows={[prose('[File](\u200c/repo/file.ts)')]} />
      </FilePaneContext.Provider>
    </ToastContext.Provider>)
    await act(async () => { openButtons(tree.container)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    expect(requests).toEqual([
      { path: '\u200c/repo/file.ts', external: true },
      ...(availability === 'missing' ? [{ path: '/repo/file.ts', external: true }] : []),
    ])
    expect(toasts).toEqual(availability === 'missing' ? [] : ['Could not open this file'])
    await tree.unmount()
  }
})

test('main transcript uses the same shortened, width-bounded file labels as worker replies', async () => {
  installBridge([])
  const path = '/repo/app/renderer/src/SessionPane.tsx:42'
  const tree = await harness.mount(<TranscriptRowsView rows={[prose(`See ${path} and \`${path}\` and [${path}](${path}).`)]} cwd="/repo" />)
  const buttons = openButtons(tree.container)
  expect(buttons).toHaveLength(3)
  for (const button of buttons) {
    expect(button.textContent).toBe('app/renderer/src/SessionPane.tsx:42')
    expect(button.title).toBe(path)
    expect(button.getAttribute('aria-label')).toBe(`Open ${path}`)
    expect(button.querySelector('.transcript-file-link-label')).not.toBeNull()
  }
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
  window.catcode.checkWorkspaceFileAvailability = async (_id, path) => { checked.push(path); return 'available' }
  const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
  const tree = await harness.mount(<TranscriptRowsView rows={[boundary, prose('`docs/report.html`')]} cwd="/repo"
    contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/repo', binding: { kind: 'project' } }]} />)
  await act(async () => { openButtons(tree.container)[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  expect(checked).toEqual(['/repo/docs/report.html'])
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Open in')
})

test('single and grouped tool filename menus use their originating row workspace', async () => {
  installBridge([])
  const checked: string[] = []
  window.catcode.checkWorkspaceFileAvailability = async (_id, path) => { checked.push(path); return 'available' }
  const boundary = { ...prose('Moving'), id: 'move', frameId: 'move-frame' }
  const read = (id: string): NestedToolUseRow => ({
    ...fileCard(id, 'write', `docs/${id}.html`), toolName: 'Read', toolFamily: 'read',
  })
  for (const files of [
    [fileCard('write', 'write', 'docs/write.html')],
    [fileCard('edit', 'edit', 'docs/edit.html')],
    [read('read')],
    [read('first'), read('second')],
    [fileCard('edit-first', 'edit', 'docs/report.html'), fileCard('edit-second', 'edit', 'docs/report.html')],
  ]) {
    const tree = await harness.mount(<TranscriptRowsView rows={[boundary, ...files]} cwd="/repo"
      contextTransitions={[{ id: 'move', afterFrameId: 'move-frame', cwd: '/repo', binding: { kind: 'project' } }]} />)
    if (!tree.container.querySelector('[data-file-actions]')) {
      await act(async () => { tree.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click() })
    }
    const target = tree.container.querySelector<HTMLElement>('[data-file-actions]')!
    expect(target).not.toBeNull()
    await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(checked.at(-1)).toBe(`/repo/${files[0]!.input.file_path}`)
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Open in')
    await tree.unmount()
  }
})

test('local file URL chips and links open one decoded absolute path in preview and external actions', async () => {
  installBridge([])
  const requests: Array<{ path: string; external: boolean }> = []
  for (const content of [
    '[Report](file:///repo/report%2520final.html)',
    '`file:///repo/report%2520final.html`',
    'See file:///repo/report%2520final.html',
  ]) {
    const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path, options) => {
      requests.push({ path, external: options?.external === true }); return { ok: true }
    }}><TranscriptRowsView rows={[prose(content)]} cwd="/different-project" /></FilePaneContext.Provider>)
    const button = openButtons(tree.container)[0]!
    expect(button).toBeDefined()
    await act(async () => { button.click() })
    expect(requests.at(-1)).toEqual({ path: '/repo/report%20final.html', external: false })
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    expect(requests.at(-1)).toEqual({ path: '/repo/report%20final.html', external: true })
    await tree.unmount()
  }
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

test('weak prose waits for settlement and confirmation, then a write retries a missing name', async () => {
  installBridge([])
  const checked: string[] = []
  let exists = false
  window.catcode.checkWorkspaceFileAvailability = async (_id, path) => {
    checked.push(path)
    return path === '/repo/README.md' || exists ? 'available' : 'missing'
  }
  const reply = prose('Node.js README.md object.property and `Makefile`, `.env`, `src/a.ts`.')
  const tree = await harness.mount(<TranscriptRowsView rows={[{ ...reply, isStreaming: true } as NestedTranscriptRow]} cwd="/repo" />)
  expect(checked).toEqual([])
  expect(openButtons(tree.container).some(button => button.title === 'Node.js')).toBe(false)
  const env = openButtons(tree.container).find(button => button.title === '.env')!
  expect(env.textContent).toBe('.env↗')
  expect(env.querySelector('svg')).toBeNull()
  await tree.render(<TranscriptRowsView rows={[reply]} cwd="/repo" />)
  expect(checked.sort()).toEqual(['/repo/Node.js', '/repo/README.md'])
  expect(openButtons(tree.container).some(button => button.title === 'README.md')).toBe(true)
  expect(openButtons(tree.container).some(button => button.title === 'Node.js')).toBe(false)
  exists = true
  const write = fileCard('node-write', 'write', '/repo/Node.js')
  await tree.render(<TranscriptRowsView rows={[reply, write]} cwd="/repo" />)
  expect(openButtons(tree.container).some(button => button.title === 'Node.js')).toBe(true)
  expect(checked.filter(path => path === '/repo/Node.js')).toHaveLength(2)
})

test('weak names in moved history use a proven origin and leave unknown origins unlinked', async () => {
  installBridge([])
  const checked: string[] = []
  window.catcode.checkWorkspaceFileAvailability = async (_id, path) => { checked.push(path); return 'available' }
  const before = { ...prose('Node.js'), id: 'before', frameId: 'before' }
  const after = { ...prose('Node.js'), id: 'after', frameId: 'after' }
  const tree = await harness.mount(<TranscriptRowsView rows={[before, after]} cwd="/current"
    contextTransitions={[{ id: 'move', afterFrameId: 'before', cwd: '/original', binding: { kind: 'project' } }]} />)
  expect(checked).toEqual(['/original/Node.js'])
  expect(openButtons(tree.container).filter(button => button.title === 'Node.js')).toHaveLength(1)
})

test('newest edit Open lands on the first changed line after hunk context', async () => {
  installBridge([])
  const requests: string[] = []
  const edit = { ...fileCard('changed-line', 'edit', '/repo/source.ts'), status: 'success' as const,
    result: { content: '', isError: false, diff: { filePath: '/repo/source.ts', hunks: [
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' same', ' same', '-old', '+new'] },
    ] } },
  }
  const tree = await harness.mount(<FilePaneContext.Provider value={async (_id, path) => { requests.push(path); return { ok: true } }}>
    <TranscriptRowsView rows={[edit]} cwd="/repo" />
  </FilePaneContext.Provider>)
  await act(async () => { openButtons(tree.container)[0]!.click() })
  expect(requests).toEqual(['/repo/source.ts:12'])
})
