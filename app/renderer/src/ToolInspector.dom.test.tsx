import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { ToolInspector } from './ToolInspector.js'
import { TranscriptRowsView } from './TranscriptView.js'
import type { ToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function toolRow(overrides: Partial<ToolUseRow> = {}): ToolUseRow {
  return {
    id: 's:m:0:t', sessionId: 's', frameId: 'f', messageId: 'm',
    blockIndex: 0, parentToolUseId: null, kind: 'tool-use', toolUseId: 't',
    toolName: 'Bash', toolFamily: 'bash', input: { command: 'table' },
    status: 'success', agentCompletion: null,
    result: { content: 'output', isError: false, diff: null },
    ...overrides,
  }
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
    const tree = await harness.mount(<TranscriptRowsView rows={[row]} />)
    expect(tree.container.textContent).not.toContain('new-tail')
    const open = [...tree.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Open full output')
    expect(open).toBeDefined()
    await act(async () => { open!.click() })
    const dialog = tree.container.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).not.toContain('new-tail')
    const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search output"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'new-tail')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
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
