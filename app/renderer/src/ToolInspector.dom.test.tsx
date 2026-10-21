import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { SubagentWorkspace } from './SubagentWorkspace.js'
import { ToolInspector } from './ToolInspector.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { TOOL_OUTPUT_WIDTH_STORAGE_KEY } from './toolOutputPanel.js'
import type { DerivedSubagentDock, SubagentDockRow } from './subagentDockState.js'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll(); window.localStorage.clear() })
afterAll(async () => { await harness.teardown() })

function toolRow(overrides: Partial<NestedToolUseRow> = {}): NestedToolUseRow {
  return {
    id: 's:m:0:t', sessionId: 's', frameId: 'f', messageId: 'm',
    blockIndex: 0, parentToolUseId: null, kind: 'tool-use', toolUseId: 't',
    toolName: 'Bash', toolFamily: 'bash', input: { command: 'table' },
    status: 'success', agentCompletion: null,
    result: { content: 'output', isError: false, diff: null },
    children: [],
    ...overrides,
  }
}

/** A Bash row whose output is long enough for the card to band it. */
function longBash(id: string, command: string, lines = 900, prefix = 'out line'): NestedToolUseRow {
  return toolRow({
    id, toolUseId: id, input: { command },
    result: { content: Array.from({ length: lines }, (_, index) => `${prefix} ${index + 1}`).join('\n'), isError: false, diff: null },
  })
}

function worker(patch: Partial<SubagentDockRow> = {}): SubagentDockRow {
  return {
    agentId: 'a', runKey: 'launch-a', toolUseId: 'launch-a', name: 'worker-a', task: 'Task a', type: 'explore',
    state: 'running', model: 'claude-sonnet-4-5', rowModel: null, recordedAccount: null, account: null, usageLabel: null,
    verdict: null, resultSummary: null, blockReason: null, launchOrder: 0, terminalAt: null, resumedAt: null,
    lastSeenAt: 0, missingSince: null, settleUntil: null, stateWord: '', stripLines: [null, null], chipLines: [null, null], settling: false, runToolUseIds: [], ...patch,
  }
}

/** The real slot: the parent transcript inside the workspace that docks the panel. */
function workspace(rows: NestedTranscriptRow[], active: SubagentDockRow[] = []) {
  const dock: DerivedSubagentDock = { active, finished: [], chipFaces: active, nextUpdateAt: null }
  return (
    <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded: () => {} }}>
      <SubagentWorkspace dock={dock} collapsed={false} onCollapsedChange={() => {}} onClearFinished={() => {}}
        onDetailsVisibleChange={() => {}} onFallback={() => {}} onOpenWorkers={() => {}} rows={rows} cwd="/repo">
        <main className="session-pane"><TranscriptRowsView rows={rows} cwd="/repo" /></main>
      </SubagentWorkspace>
    </ToolsExpandedContext.Provider>
  )
}

function openButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent?.includes('Open full output'))
}

function outputPanel(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('aside[aria-label="Full output"]')
}

async function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}

async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function withClipboard(check: (writes: string[]) => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writes: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => { writes.push(text) } },
  })
  try { await check(writes) } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
}

test('full output preserves tabular non-Read bytes and strips only Read prefixes', async () => {
  const text = '81\tfirst\n82\tsecond'
  await withClipboard(async writes => {
    for (const toolFamily of ['bash', 'mcp', 'write', 'read'] as const) {
      const tree = await harness.mount(<ToolInspector row={toolRow({
        toolFamily,
        input: toolFamily === 'write' ? { content: text } : {},
        result: { content: text, isError: false, diff: null },
      })} />)
      await act(async () => {
        tree.container.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click()
      })
      expect(writes.at(-1)).toBe(toolFamily === 'read' ? 'first\nsecond' : text)
      await tree.unmount()
    }
  })
})

test('workspace Markdown links decode filenames once and preserve literal location suffixes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'catcode')
  const opens: string[] = []
  Object.defineProperty(window, 'catcode', { configurable: true, value: {
    openWorkspaceFile: async (_session: string, path: string) => { opens.push(path); return true },
  } })
  try {
    const cases = [
      ['</repo/My Report.md>', '/repo/My Report.md'],
      ['</repo/ไทย.md>', '/repo/ไทย.md'],
      ['</repo/file%23name.md>', '/repo/file#name.md'],
      ['</repo/bad%ZZ.md>', '/repo/bad%ZZ.md'],
      ['</repo/My Report%ZZ.md>', '/repo/My Report%ZZ.md'],
      ['</repo/bad%FF.md>', '/repo/bad%FF.md'],
      ['</repo/literal.md:123>', '/repo/literal.md:123'],
      ['<./report.md:12>', './report.md:12'],
      ['</repo/literal%2520name.md>', '/repo/literal%20name.md'],
    ]
    for (const [href, expected] of cases) {
      const row: NestedTranscriptRow = {
        id: 'prose', sessionId: 's', frameId: 'f', messageId: 'm', blockIndex: 0,
        parentToolUseId: null, kind: 'assistant-text', role: 'assistant',
        content: `[Report](${href})`, children: [],
      }
      const tree = await harness.mount(<TranscriptRowsView rows={[row]} />)
      await act(async () => {
        tree.container.querySelector<HTMLButtonElement>('[aria-label^="Open "]')!.click()
      })
      expect(opens.at(-1)).toBe(expected)
      await tree.unmount()
    }
  } finally {
    if (descriptor) Object.defineProperty(window, 'catcode', descriptor)
    else Reflect.deleteProperty(window, 'catcode')
  }
})

test('a long diff opens bounded searchable output and copies its complete patch', async () => {
  const oldLine = `${'x'.repeat(8_000)}old-tail`
  const newLine = `${'x'.repeat(8_000)}new-tail`
  const patch = `-${oldLine}\n+${newLine}`
  const row: NestedTranscriptRow = { ...toolRow({
    toolName: 'Edit', toolFamily: 'edit', status: 'error',
    input: { file_path: '/repo/min.js' },
    result: { content: '', isError: true, diff: {
      filePath: '/repo/min.js', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [`-${oldLine}`, `+${newLine}`] }],
    } },
  }), children: [] }
  await withClipboard(async writes => {
    const tree = await harness.mount(workspace([row]))
    expect(tree.container.textContent).not.toContain('new-tail')
    const open = [...tree.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Open full output')
    expect(open).toBeDefined()
    await act(async () => { open!.click() })
    const dialog = outputPanel(tree.container)!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).not.toContain('new-tail')
    const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search output"]')!
    await setInput(search, 'new-tail')
    expect(dialog.textContent).toContain('new-tail')
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('[aria-label="Copy output"]')!.click()
    })
    expect(writes).toEqual([patch])
  })
})

test('Next match reaches a later occurrence on the same bounded output line', async () => {
  const text = `needle-first${'x'.repeat(8_000)}needle-last`
  const tree = await harness.mount(<ToolInspector row={toolRow({
    result: { content: text, isError: false, diff: null },
  })} />)
  const search = tree.container.querySelector<HTMLInputElement>('[aria-label="Search output"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'needle')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(tree.container.textContent).toContain('1/2')
  expect(tree.container.textContent).not.toContain('needle-last')
  await act(async () => {
    tree.container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click()
  })
  expect(tree.container.textContent).toContain('2/2')
  expect(tree.container.textContent).toContain('needle-last')
  await act(async () => {
    tree.container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click()
  })
  expect(tree.container.textContent).toContain('1/2')
  expect(tree.container.textContent).toContain('needle-first')
})

test('Open full output docks beside the transcript, swaps in place, and Escape returns focus to the card', async () => {
  const rows = [longBash('one', 'cmd-one'), longBash('two', 'cmd-two', 900, 'second')]
  const tree = await harness.mount(workspace(rows))
  expect(openButtons(tree.container)).toHaveLength(2)

  const first = openButtons(tree.container)[0]
  first.focus()
  await act(async () => { first.click() })
  const panel = outputPanel(tree.container)!
  expect(panel).not.toBeNull()
  // A column of the workspace layout, beside the transcript, never a modal.
  expect(panel.parentElement?.className).toBe('subagent-workspace-layout')
  expect(panel.previousElementSibling?.contains(tree.container.querySelector('main')!)).toBe(true)
  expect(tree.container.querySelector('[aria-modal], .bg-scrim')).toBeNull()
  expect(panel.querySelector('.tool-output-target')?.textContent).toBe('cmd-one')
  expect(panel.querySelector('.tool-output-facts')?.textContent).toBe('900 lines')
  // Focus lands in the body, so the keyboard scrolls and searches it at once.
  expect(document.activeElement).toBe(panel.querySelector('[role="region"][aria-label="Output"]'))
  // The transcript is still there to use: the second card opens in the same slot.
  const second = openButtons(tree.container)[1]
  second.focus()
  await act(async () => { second.click() })
  expect(tree.container.querySelectorAll('aside[aria-label="Full output"]')).toHaveLength(1)
  expect(outputPanel(tree.container)?.querySelector('.tool-output-target')?.textContent).toBe('cmd-two')
  // Happy DOM measures every row at 0px, so which slice mounts is not a fact
  // about the product; the body's text is.
  expect(outputPanel(tree.container)?.querySelector('[role="region"]')?.textContent).toContain('second 9')
  expect(outputPanel(tree.container)?.textContent).not.toContain('out line')

  await press(document.activeElement!, 'Escape')
  await act(async () => { await harness.nextFrame() })
  expect(outputPanel(tree.container)).toBeNull()
  expect(document.activeElement).toBe(second)
})

test('keyboard search: Cmd+F focuses the field, Enter steps, and Escape clears before it closes', async () => {
  const tree = await harness.mount(workspace([longBash('one', 'cmd-one')]))
  await act(async () => { openButtons(tree.container)[0].click() })
  const panel = outputPanel(tree.container)!
  const search = panel.querySelector<HTMLInputElement>('input[aria-label="Search output"]')!
  await press(panel.querySelector('[role="region"]')!, 'f', { metaKey: true })
  expect(document.activeElement).toBe(search)

  // out line 89, and 890 through 899.
  await setInput(search, 'line 89')
  expect(panel.querySelector('.tool-output-count')?.textContent).toBe('1/11')
  await press(search, 'Enter')
  expect(panel.querySelector('.tool-output-count')?.textContent).toBe('2/11')
  await press(search, 'Enter', { shiftKey: true })
  expect(panel.querySelector('.tool-output-count')?.textContent).toBe('1/11')

  await press(search, 'Escape')
  expect(search.value).toBe('')
  expect(outputPanel(tree.container)).not.toBeNull()
  await press(search, 'Escape')
  expect(outputPanel(tree.container)).toBeNull()
})

test('the open panel follows the live row: a later result updates it and a vanished row closes it', async () => {
  const before = longBash('one', 'cmd-one', 900, 'early')
  const tree = await harness.mount(workspace([before]))
  await act(async () => { openButtons(tree.container)[0].click() })
  expect(outputPanel(tree.container)?.textContent).toContain('early 9')

  await tree.render(workspace([longBash('one', 'cmd-one', 950, 'late')]))
  expect(outputPanel(tree.container)?.textContent).toContain('late 9')
  expect(outputPanel(tree.container)?.textContent).not.toContain('early')
  expect(outputPanel(tree.container)?.querySelector('.tool-output-facts')?.textContent).toBe('950 lines')

  await tree.render(workspace([]))
  expect(outputPanel(tree.container)).toBeNull()
})

test('output opened from a worker panel takes its slot; Back returns to the same worker, and close dismisses both', async () => {
  const agent = toolRow({
    id: 'agent-a', toolUseId: 'launch-a', toolName: 'Agent', toolFamily: 'agent', status: 'pending', result: null,
    input: { description: 'Task a', subagent_type: 'explore' },
    children: [{ ...longBash('inner', 'cmd-inner'), parentToolUseId: 'launch-a' }],
  })
  const tree = await harness.mount(workspace([agent], [worker()]))
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[data-dock-row="a"]')!.click() })
  const slot = tree.container.querySelector<HTMLElement>('.subagent-side-slot')!
  const workerBody = slot.querySelector<HTMLElement>('.subagent-side-body')!
  expect(workerBody).not.toBeNull()

  await act(async () => { openButtons(slot)[0].click() })
  const panel = outputPanel(tree.container)!
  expect(panel.querySelector('.tool-output-target')?.textContent).toBe('cmd-inner')
  // The worker stays mounted underneath, so returning to it loses nothing.
  expect(slot.hidden).toBe(true)
  expect(slot.querySelector('.subagent-side-body')).toBe(workerBody)

  await act(async () => { panel.querySelector<HTMLButtonElement>('[aria-label="Back to worker-a"]')!.click() })
  await act(async () => { await harness.nextFrame() })
  expect(outputPanel(tree.container)).toBeNull()
  expect(slot.hidden).toBe(false)
  expect(slot.querySelector('.subagent-side-body')).toBe(workerBody)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close subagent panel')

  await act(async () => { openButtons(slot)[0].click() })
  await act(async () => { outputPanel(tree.container)!.querySelector<HTMLButtonElement>('[aria-label="Close full output"]')!.click() })
  expect(outputPanel(tree.container)).toBeNull()
  expect(tree.container.querySelector('.subagent-side-slot')).toBeNull()
})

test('the panel width is the one last chosen, and the keyboard can change it', async () => {
  window.localStorage.setItem(TOOL_OUTPUT_WIDTH_STORAGE_KEY, JSON.stringify({ version: 1, width: 700 }))
  const tree = await harness.mount(workspace([longBash('one', 'cmd-one')]))
  await act(async () => { openButtons(tree.container)[0].click() })
  const panel = outputPanel(tree.container)!
  expect(panel.style.getPropertyValue('--tool-output-width')).toBe('700px')

  const handle = panel.querySelector<HTMLElement>('[role="separator"][aria-label="Resize output panel"]')!
  await press(handle, 'ArrowLeft')
  expect(handle.getAttribute('aria-valuenow')).toBe('732')
  expect(panel.style.getPropertyValue('--tool-output-width')).toBe('732px')
  expect(JSON.parse(window.localStorage.getItem(TOOL_OUTPUT_WIDTH_STORAGE_KEY)!)).toEqual({ version: 1, width: 732 })
  // Escape on the handle still closes: it is part of the panel.
  await press(handle, 'Escape')
  expect(outputPanel(tree.container)).toBeNull()
})

test('a stored width outside the panel range is ignored', async () => {
  window.localStorage.setItem(TOOL_OUTPUT_WIDTH_STORAGE_KEY, JSON.stringify({ version: 1, width: 12 }))
  const tree = await harness.mount(<ToolInspector row={longBash('one', 'cmd-one')} />)
  expect(outputPanel(tree.container)?.style.getPropertyValue('--tool-output-width')).toBe('560px')
})
