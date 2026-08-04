/**
 * Render transcript rows to a real page, with the real built CSS, so a renderer
 * change can be LOOKED AT.
 *
 * Why this exists. The renderer suite renders to static markup, so it can prove
 * a class name is present and nothing else — not that the class produces a rule,
 * not that the rule is reachable in the state a user actually sees, not that two
 * columns line up. On 2026-08-04 a run of transcript colour work was verified
 * that way, passed every gate, and changed nothing on screen: the fixes were all
 * in a tool card's EXPANDED body while a successful card shows a collapsed peek.
 * The tests could not have caught it — every one of them forced the card open to
 * reach the body at all. One look at this page shows it immediately, and the
 * first run of it also caught a column-alignment bug no assertion had.
 *
 * This is a LOOKING tool, not a gate: it asserts nothing and is not wired into
 * any battery. Run it, open the file, look.
 *
 *   bun run --cwd app preview:transcript
 *
 * Output goes to `renderer/dist/` (gitignored), and takes whichever CSS the last
 * `renderer:build` produced — so build first, or the page renders against a
 * stale stylesheet. Rows are the FIXTURES BELOW; edit them to preview whatever
 * you are working on. Both code themes are rendered, because the transcript's
 * syntax colours follow the operator's Settings pick and a change can look right
 * under one palette and wrong under another.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { TranscriptRowsView } from '../renderer/src/TranscriptView.js'
import { ToolsExpandedContext } from '../renderer/src/toolsExpanded.js'
import type { NestedTranscriptRow } from '../renderer/src/transcriptProjector.js'

const base = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}

let seq = 0
function tool(fields: {
  toolName: string
  toolFamily: string
  input?: Record<string, unknown>
  status?: string
  content?: string
  isError?: boolean
}): NestedTranscriptRow {
  seq += 1
  return {
    ...base,
    id: `s:m:${seq}`,
    kind: 'tool-use',
    toolUseId: `toolu_${seq}`,
    toolName: fields.toolName,
    toolFamily: fields.toolFamily,
    agentCompletion: null,
    input: fields.input ?? {},
    status: fields.status ?? 'success',
    result: {
      isError: fields.isError ?? false,
      content: fields.content ?? '',
      diff: null,
    },
    children: [],
  } as unknown as NestedTranscriptRow
}

/**
 * VERBATIM real `bun test` output, pasted from a terminal — do NOT hand-write
 * fixtures here. The first version of this file was invented, and every line in
 * it happened to match a tint rule (`✓ 118 pass`, `WARNING:`, `ERROR:`), so the
 * page looked colourful while the real thing rendered flat grey: actual output
 * says ` 18 pass` / ` 0 fail`, which matched nothing. A preview fed agreeable
 * data is worse than no preview, because it manufactures confidence.
 */
const BASH_OUT = [
  'bun test v1.3.11 (af24e281)',
  '',
  ' 18 pass',
  ' 0 fail',
  ' 28 expect() calls',
  'Ran 18 tests across 1 file. [355.00ms]',
].join('\n')

/** Real output from a FAILING run, same source, same rule. */
const BASH_FAIL_OUT = [
  'bun test v1.3.11 (af24e281)',
  '',
  '# Unhandled error between tests',
  'error: Cannot find package \'react\'',
  '',
  ' 2 pass',
  ' 3 fail',
  'Ran 5 tests across 1 file. [412.00ms]',
].join('\n')

const GREP_OUT = [
  'src/app-runtime/AppSessionController.test.ts-25-function createResultMessage(result: string): SDKMessage {',
  'src/app-runtime/AppSessionController.test.ts-26-  return {',
  "src/app-runtime/AppSessionController.test.ts:27:    type: 'result',",
  'src/app-runtime/AppSessionController.test.ts:29:    is_error: false,',
  '--',
  'app/sidecar/sidecarServer.ts:812:  const isError = frame.kind === "error"',
].join('\n')

const rows: NestedTranscriptRow[] = [
  tool({ toolName: 'Bash', toolFamily: 'bash', input: { command: 'bun test app/' }, content: BASH_OUT }),
  tool({ toolName: 'Bash', toolFamily: 'bash', input: { command: 'bun test app/' }, status: 'error', content: BASH_FAIL_OUT }),
  tool({ toolName: 'Grep', toolFamily: 'grep', input: { pattern: 'isError' }, status: 'error', content: GREP_OUT }),
  tool({
    toolName: 'Write',
    toolFamily: 'write',
    input: {
      file_path: '/w/greet.ts',
      content:
        'export function greet(name: string): string {\n  // a comment\n  return `hi ${name}`\n}',
    },
    status: 'error',
    content: 'File created successfully at: /w/greet.ts',
  }),
]

/** Collapsed AND expanded, because the default state is the one that hides. */
function panel(expanded: boolean): string {
  return renderToStaticMarkup(
    <ToolsExpandedContext.Provider value={{ expanded, setExpanded: () => {} }}>
      <TranscriptRowsView rows={rows} />
    </ToolsExpandedContext.Provider>,
  )
}

const dist = new URL('../renderer/dist/assets/', import.meta.url).pathname
const cssName = readdirSync(dist)
  .filter(file => file.endsWith('.css'))
  .sort()
  .pop()
if (cssName === undefined) {
  throw new Error('no built CSS found — run `bun run --cwd app renderer:build` first')
}
const css = readFileSync(`${dist}${cssName}`, 'utf8')

const label = (text: string) =>
  `<div style="color:#71717a;font:600 12px system-ui;padding:10px 40px 2px">${text}</div>`

const html = `<!doctype html><html><head><meta charset="utf-8"><title>transcript preview</title>
<style>${css}</style><style>body{background:#09090b;margin:0;padding:16px 0}</style></head>
<body>
${label('default state &middot; code theme: dracula')}<div>${panel(false)}</div>
${label('tools open by default &middot; code theme: dracula')}<div>${panel(true)}</div>
${label('tools open by default &middot; code theme: github')}<div data-code-theme="github">${panel(true)}</div>
</body></html>`

const out = new URL('../renderer/dist/preview.html', import.meta.url).pathname
writeFileSync(out, html)
console.log(`wrote ${out}\nstyled by ${cssName}`)
