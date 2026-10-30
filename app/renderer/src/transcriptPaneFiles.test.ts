import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'
import { latestPaneFileCards, newestPaneFilePath } from './transcriptPaneFiles.js'
import { mergeMountedMarkdownLeaves, planMarkdownLeaves, renderMarkdownTree } from './markdownRenderPlan.js'

function prose(id: string, content: string): NestedTranscriptRow {
  return { id, sessionId: 's', frameId: id, messageId: id, blockIndex: 0, parentToolUseId: null,
    kind: 'assistant-text', role: 'assistant', content, children: [] }
}
function edit(id: string, path: string): NestedToolUseRow {
  return { id, sessionId: 's', frameId: id, messageId: id, blockIndex: 0, parentToolUseId: null,
    kind: 'tool-use', toolUseId: id, toolName: 'Edit', toolFamily: 'edit', input: { file_path: path },
    status: 'pending', agentCompletion: null, result: null, children: [] }
}

test('reopen discovery follows rendered reply forms and ignores fenced code and outside links', () => {
  for (const content of ['[Report](notes.MD:12)', 'See notes.MD:12', '`notes.MD:12`', '[Report][n]\n\n[n]: notes.MD:12']) {
    expect(newestPaneFilePath([prose('reply', content)])).toBe('notes.MD:12')
  }
  expect(newestPaneFilePath([prose('reply', 'See first.html\n\n```\nignore.md\n```\n\n[Outside](https://example.com/later.md)')])).toBe('first.html')
  expect(newestPaneFilePath([prose('reply', '`script.ts` [Outside](https://example.com)')])).toBeNull()
})

test('newest cards and reopen candidates use original arrival order across nested worker rows', () => {
  const late = edit('late-worker', '/repo/report.md')
  const early = edit('early-parent', 'report.md')
  const worker = { ...edit('agent', 'ignored.ts'), toolName: 'Agent', toolFamily: 'agent' as const,
    children: [late, prose('worker-reply', 'worker-last.svg')] }
  const rows = [worker, early, prose('parent-reply', 'parent.html')]
  const arrival = ['agent', 'early-parent', 'parent-reply', 'late-worker', 'worker-reply']
  expect(latestPaneFileCards(rows, '/repo', arrival).get('/repo/report.md')).toBe('late-worker')
  expect(newestPaneFilePath(rows, arrival)).toBe('worker-last.svg')
})

test('safe filename source locations survive Markdown URL normalization while executable schemes stay inert', () => {
  const source = '[Notes](notes.md:12:3) [JS](javascript:12) [JS file](javascript:evil.md:12) [Data](data:text/html,bad)'
  const leaves = planMarkdownLeaves('paths', source)
  const html = mergeMountedMarkdownLeaves(leaves, 0, leaves.length)
    .map(leaf => renderToStaticMarkup(renderMarkdownTree(leaf.tree))).join('')
  expect(html).toContain('href="./notes.md:12:3"')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('href="data:')
  expect(html.match(/href=""/g)).toHaveLength(3)
})
