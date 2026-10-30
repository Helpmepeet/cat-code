import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { SubagentSidePanel } from './SubagentSidePanel.js'
import { selectSubagentPanelRowForCard } from './subagentPanelState.js'
import { FilePaneContext } from './filePaneContext.js'
import { ToolCardStyleContext, type ToolCardStyle } from './toolCardStyle.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { ToastContext } from './toastContext.js'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })
const source = { sessionId: 'localhost-session', frameId: 'f', messageId: 'm', blockIndex: 0, parentToolUseId: null, children: [] }
function prose(content: string, streaming = false): NestedTranscriptRow {
  return { ...source, id: 'reply', kind: 'assistant-text', role: 'assistant', content, isStreaming: streaming ? true : undefined }
}
function bash(id: string, output: string | null): NestedToolUseRow {
  return { ...source, id, toolUseId: id, kind: 'tool-use', toolName: 'Bash', toolFamily: 'bash', input: { command: 'bun run dev' },
    status: output === null ? 'pending' : 'success', agentCompletion: null,
    result: output === null ? null : { content: output, isError: false, diff: null } }
}
function surface(rows: NestedTranscriptRow[], worker: boolean) {
  if (!worker) return <TranscriptRowsView rows={rows} cwd="/repo" />
  const agent = { ...bash('agent', null), toolName: 'Agent', toolFamily: 'agent' as const,
    input: { description: 'Preview worker', subagent_type: 'general-purpose' }, children: rows }
  const selected = selectSubagentPanelRowForCard(agent, [])
  return <SubagentSidePanel worker={selected} workers={[selected]} agent={agent} steps={rows} incomplete={false}
    cwd="/repo" onSwitch={() => {}} onClose={() => {}} />
}
function buttons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open http://"]')]
}

test('local HTTP links in parent and actual worker transcripts forward clicks and modifiers while other URLs remain outside', async () => {
  for (const worker of [false, true]) {
    const calls: Array<{ sessionId: string; target: string; external: boolean }> = []
    const opener = async (sessionId: string, target: string, options?: { external?: boolean }) => {
      calls.push({ sessionId, target, external: options?.external === true }); return { ok: true as const }
    }
    const content = '[App](http://localhost:4000/start) http://127.0.0.1:4001/ http://[::1]:4002/settings `http://localhost:4003/`\n\n' +
      '[Outside](https://example.com) [Other HTTP](http://example.com) [Alias](http://127.1:4000/) [Spoof](http://localhost.evil:4000/)'
    const tree = await harness.mount(<FilePaneContext.Provider value={opener}>{surface([prose(content)], worker)}</FilePaneContext.Provider>)
    expect(calls).toEqual([])
    const local = buttons(tree.container)
    expect(local.map(button => button.getAttribute('aria-label'))).toEqual([
      'Open http://localhost:4000/start', 'Open http://127.0.0.1:4001/', 'Open http://[::1]:4002/settings', 'Open http://localhost:4003/',
    ])
    for (const button of local) await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    expect(calls.map(call => [call.sessionId, call.target, call.external])).toEqual(local.map(button => [source.sessionId, button.getAttribute('aria-label')!.slice(5), true]))
    expect([...tree.container.querySelectorAll<HTMLAnchorElement>('a')].map(link => [link.getAttribute('href'), link.target])).toEqual([
      ['https://example.com', '_blank'], ['http://example.com', '_blank'], ['http://127.1:4000/', '_blank'], ['http://localhost.evil:4000/', '_blank'],
    ])
    await tree.unmount()
  }
})

test('a streamed local link stays inert until complete and a standalone transcript retains external anchors', async () => {
  const targets: string[] = []
  const opener = async (_sessionId: string, target: string) => { targets.push(target); return { ok: true as const } }
  const draw = (complete: boolean) => <FilePaneContext.Provider value={opener}><TranscriptRowsView rows={[prose(complete ? '[App](http://localhost:4000/)' : '[App](http://localhost:4000/', !complete)]} /></FilePaneContext.Provider>
  const tree = await harness.mount(draw(false))
  const pending = tree.container.querySelector<HTMLButtonElement>('.md-prose button')!
  expect(pending.disabled).toBe(true)
  await act(async () => { pending.click() })
  expect(targets).toEqual([])
  await tree.render(draw(true))
  await act(async () => { buttons(tree.container)[0]!.click() })
  expect(targets).toEqual(['http://localhost:4000/'])
  await tree.render(<TranscriptRowsView rows={[prose('[App](http://localhost:4000/) http://[::1]:4001/')]} />)
  expect(buttons(tree.container)).toHaveLength(0)
  expect([...tree.container.querySelectorAll<HTMLAnchorElement>('a')].map(link => [link.getAttribute('href'), link.target])).toEqual([
    ['http://localhost:4000/', '_blank'], ['http://[::1]:4001/', '_blank'],
  ])
})

test('Bash Open follows reported output without opening automatically, stays outside disclosure buttons, and does not deduplicate cards', async () => {
  for (const style of ['cards', 'lines'] as ToolCardStyle[]) {
    const targets: string[] = []
    const opener = async (_id: string, target: string) => { targets.push(target); return { ok: true as const } }
    const draw = (rows: NestedTranscriptRow[]) => <FilePaneContext.Provider value={opener}>
      <ToolCardStyleContext.Provider value={{ style, setStyle() {} }}>{surface(rows, true)}</ToolCardStyleContext.Provider>
    </FilePaneContext.Provider>
    const tree = await harness.mount(draw([bash('server', null)]))
    expect(buttons(tree.container)).toHaveLength(0)
    const output = 'Docs http://example.com/ and numeric alias http://127.1:6000/\n' +
      '\u001b[32mLocal: \u001b]8;;http://localhost:9999/hidden\u001b\\http://localhost:4000/preview?theme=dark\u001b]8;;\u001b\\\u001b[0m\nAlso http://127.0.0.1:4001/'
    await tree.render(draw([bash('server', output), bash('another-server', output)]))
    expect(targets).toEqual([])
    expect(buttons(tree.container)).toHaveLength(2)
    for (const button of buttons(tree.container)) expect(button.parentElement?.closest('button')).toBeNull()
    const header = tree.container.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { buttons(tree.container)[0]!.click() })
    expect(targets).toEqual(['http://localhost:4000/preview?theme=dark'])
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await tree.render(draw([bash('server', 'http://localhost.evil:4000/ http://127.1:4000/ https://localhost:4000/')]))
    expect(buttons(tree.container)).toHaveLength(0)
    await tree.unmount()
  }
})

test('Focused Bash remains folded until expanded and reports the exact localhost refusal from its opener', async () => {
  const toasts: string[] = []
  const calls: string[] = []
  const tree = await harness.mount(<ToastContext.Provider value={message => { toasts.push(message) }}>
    <FilePaneContext.Provider value={async (_id, target) => { calls.push(target); return { ok: false, message: 'Nothing is running at localhost:4000' } }}>
      <TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
        <ToolsExpandedContext.Provider value={{ expanded: true, setExpanded() {} }}>
          <TranscriptRowsView rows={[bash('server', 'Listening at http://localhost:4000/')]} />
        </ToolsExpandedContext.Provider>
      </TranscriptModeContext.Provider>
    </FilePaneContext.Provider>
  </ToastContext.Provider>)
  expect(buttons(tree.container)).toHaveLength(0)
  const step = tree.container.querySelector<HTMLButtonElement>('.focused-step-head')
  if (step?.getAttribute('aria-expanded') === 'false') await act(async () => { step.click() })
  const header = tree.container.querySelector<HTMLButtonElement>('[data-tool-row] button[aria-expanded]')!
  expect(header.getAttribute('aria-expanded')).toBe('false')
  await act(async () => { header.click() })
  expect(buttons(tree.container)).toHaveLength(1)
  expect(calls).toEqual([])
  await act(async () => { buttons(tree.container)[0]!.click() })
  expect(calls).toEqual(['http://localhost:4000/'])
  expect(toasts).toEqual(['Nothing is running at localhost:4000'])
})
