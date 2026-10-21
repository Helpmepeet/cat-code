import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolInspector } from './ToolInspector.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

function mkToolRow(overrides: Partial<NestedToolUseRow>): NestedToolUseRow {
  return {
    id: 's:m:0:toolu_1',
    sessionId: 's',
    frameId: 'f',
    messageId: 'm',
    blockIndex: 0,
    parentToolUseId: null,
    kind: 'tool-use',
    toolUseId: 'toolu_1',
    toolName: 'Read',
    toolFamily: 'read',
    input: {},
    status: 'pending',
    agentCompletion: null,
    result: null,
    children: [],
    ...overrides,
  }
}

test('frames the target the way the card does, cwd-relative', () => {
  const row = mkToolRow({ input: { file_path: '/etc/hosts' } })
  expect(describeToolForInspector(row).target).toBe('/etc/hosts')
  expect(describeToolForInspector(row, '/etc').target).toBe('hosts')
})

test('a resolved Bash card surfaces its target + output', () => {
  const model = describeToolForInspector(
    mkToolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'echo hi' },
      status: 'success',
      result: { isError: false, content: 'hi\n', diff: null },
    }),
  )
  expect(model.target).toBe('echo hi')
  expect(model.output).toBe('hi\n')
  expect(model.outputLanguage).toBeNull()
})

test('a FileEdit result exposes the narrowed diff', () => {
  const model = describeToolForInspector(
    mkToolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/app/x.ts' },
      status: 'success',
      result: {
        isError: false,
        content: 'ok',
        diff: {
          filePath: '/app/x.ts',
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-old', '+new'],
            },
          ],
        },
      },
    }),
  )
  expect(model.diffs[0]?.filePath).toBe('/app/x.ts')
  expect(model.diffs[0]?.hunks[0].lines).toEqual(['-old', '+new'])
})

test('narrows tolerantly: empty input names the tool, a non-record input degrades to {}', () => {
  expect(describeToolForInspector(mkToolRow({ input: {} })).target).toBe('Read')
  // A junk input shape (defensive — the wire is unknown) must not crash: it
  // degrades to `{}`, which names the tool the way an empty input does.
  const junk = mkToolRow({ input: 42 as unknown as Record<string, unknown> })
  expect(describeToolForInspector(junk).target).toBe('Read')
})

test('an MCP target reads as server and tool, as on the card', () => {
  const model = describeToolForInspector(
    mkToolRow({ toolName: 'mcp__github__get_issue', toolFamily: 'mcp', input: { number: 7 } }),
  )
  expect(model.target).toBe('github › get_issue')
})

test('a read or a written file is coloured as its source; a failed write is not', () => {
  const read = describeToolForInspector(mkToolRow({
    input: { file_path: '/w/a.ts' },
    result: { isError: false, content: '1\tconst x = 1', diff: null },
  }))
  expect(read.outputLanguage).not.toBeNull()
  const written = describeToolForInspector(mkToolRow({
    toolName: 'Write', toolFamily: 'write',
    input: { file_path: '/w/a.ts', content: 'const x = 1' },
    result: { isError: false, content: 'File created', diff: null },
  }))
  expect(written.outputLanguage).toBe(read.outputLanguage)
  const failed = describeToolForInspector(mkToolRow({
    toolName: 'Write', toolFamily: 'write',
    input: { file_path: '/w/a.ts', content: 'const x = 1' },
    result: { isError: true, content: 'EACCES', diff: null },
  }))
  expect(failed.outputLanguage).toBeNull()
  expect(failed.failed).toBe(true)
})

test('renders the panel over a real row (diff lines, row named in the header)', () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      row={mkToolRow({
        toolName: 'Edit',
        toolFamily: 'edit',
        input: { file_path: '/app/x.ts' },
        status: 'success',
        result: {
          isError: false,
          content: 'ok',
          diff: {
            filePath: '/app/x.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-old', '+new'],
              },
            ],
          },
        },
      })}
    />,
  )
  // The header names the row in the card's grammar, and the generic title
  // above it is gone with the rest of the metadata stack.
  expect(html).toContain('/app/x.ts')
  expect(html).toContain('>Edit</span>')
  expect(html).not.toContain('Tool inspector')
  // Diff signs in the card's tones, and the row washes with them.
  expect(html).toContain('text-tone-success')
  expect(html).toContain('text-tone-danger')
  expect(html).toContain('bg-[#22c55e]/10')
  // Changes and a text result are two tabs, not two stacked toolbars.
  expect(html).toContain('>Changes</button>')
  expect(html).toContain('>Result</button>')
  expect(html.split('aria-label="Search output"').length - 1).toBe(1)
})

test('the panel opens on the output, not on a restatement of the card', () => {
  // 2026-08-13 (`docs/reports/2026-08-12-tool-inspector-ux-review.md`): the
  // Tool / Summary / Status / raw-Input stack that used to sit above the output
  // repeated the expanded card the user reached this from. All four are gone.
  const html = renderToStaticMarkup(
    <ToolInspector
      row={mkToolRow({
        toolName: 'Bash',
        toolFamily: 'bash',
        input: { command: 'ls', description: 'list the files' },
        status: 'success',
        result: { isError: false, content: 'a\nb\n', diff: null },
      })}
    />,
  )

  expect(html).toContain('aria-label="Output"') // the body, and nothing above it
  expect(html).not.toContain('>Tool<')
  expect(html).not.toContain('>Summary<')
  expect(html).not.toContain('>Status<')
  expect(html).not.toContain('>Input<')
  // The raw structured input went with them: no JSON keys reach the panel.
  expect(html).not.toContain('description')
})

test('renders a Diff section for a real Apply_patch row (E1 — edit-family, files[] envelope)', () => {
  // Older projected rows carry only the primary diff; these remain inspectable
  // under the legacy tool name as well as current multi-file patch rows.
  const html = renderToStaticMarkup(
    <ToolInspector
      row={mkToolRow({
        toolName: 'Apply_patch',
        toolFamily: 'edit',
        input: { input: '*** Begin Patch\n*** Update File: /app/y.ts\n@@\n-a\n+b\n*** End Patch' },
        status: 'success',
        result: {
          isError: false,
          content: 'Applied patch to 1 file: /app/y.ts',
          diff: {
            filePath: '/app/y.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ['-a', '+b'],
              },
            ],
          },
        },
      })}
    />,
  )
  // The patched path names the row, and the panel opens on its changes.
  expect(html).toContain('/app/y.ts')
  expect(html).toContain('aria-selected="true" tabindex="0">Changes</button>')
  // Add/remove diff-line tones present (proves hunk lines rendered).
  expect(html).toContain('text-tone-success')
  expect(html).toContain('text-tone-danger')
})

test('a diff-less Bash row has no Changes tab (contrast to Apply_patch)', () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      row={mkToolRow({
        toolName: 'Bash',
        toolFamily: 'bash',
        input: { command: 'ls' },
        status: 'success',
        result: { isError: false, content: 'a\nb\n', diff: null },
      })}
    />,
  )
  expect(html).not.toContain('role="tablist"')
  expect(html).not.toContain('Changes')
})

test('renders nothing when there is no row', () => {
  expect(renderToStaticMarkup(<ToolInspector row={null} />)).toBe('')
})

function bashRowWithOutput(content: string) {
  return mkToolRow({
    toolName: 'Bash',
    toolFamily: 'bash',
    input: { command: 'ls' },
    status: 'success',
    result: { isError: false, content, diff: null },
  })
}

test('P4-37: an output carries the copy / search / wrap toolbar', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('a\nb\n')} />,
  )
  expect(html).toContain('aria-label="Search output"')
  expect(html).toContain('aria-label="Copy output"')
  expect(html).toContain('Wrap')
  expect(html).toContain('Copy')
})

test('P4-37: the output body is line-numbered, and every line of it renders', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('first\nsecond\nthird')} />,
  )
  expect(html).toContain('first')
  expect(html).toContain('second')
  expect(html).toContain('third')
  // 1-based gutter numbers, one per line.
  expect(html).toContain('>1</span>')
  expect(html).toContain('>2</span>')
  expect(html).toContain('>3</span>')
})

test('P4-37: with no query there is no counter, no stepper and no highlight', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('alpha\nbeta')} />,
  )
  expect(html).not.toContain('aria-label="Next match"')
  expect(html).not.toContain('aria-label="Previous match"')
  expect(html).not.toContain('<mark')
})

test('P4-37: output stays a text node — markup in a tool result is escaped, never mounted', () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      row={bashRowWithOutput('<img src=x onerror="boom">\n</div>')} />,
  )
  expect(html).toContain('&lt;img src=x onerror=')
  expect(html).not.toContain('<img src=x')
})

test('P4-37: a row with no output has no toolbar to hang controls on', () => {
  const html = renderToStaticMarkup(
    <ToolInspector
      row={mkToolRow({
        toolName: 'Bash',
        toolFamily: 'bash',
        input: { command: 'ls' },
        status: 'success',
        result: { isError: false, content: '', diff: null },
      })}
    />,
  )
  expect(html).not.toContain('aria-label="Search output"')
  expect(html).not.toContain('aria-label="Copy output"')
})

/* --------------------------------------------------------------------------- *
 * Bounded mounting (CC-59). The panel is the only route to a complete output,
 * so what it must NOT do is mount all of one. SSR proves the first paint; the
 * geometry and the budgets themselves are proven in `lineWindow.test.ts` and
 * `outputSearchModel.test.ts`.
 * --------------------------------------------------------------------------- */

test('a multi-megabyte single line mounts a bounded chunk, and copy still holds it whole', () => {
  const line = `${'x'.repeat(3_000_000)}needle`
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput(`first\n${line}\nlast`)} />,
  )

  // One logical line, and the row budget alone would have mounted all of it.
  expect(html.length).toBeLessThan(200_000)
  expect(html).toContain('…')
  expect(html).toContain('first')
  // The model is untouched by the render bound: copy writes this string.
  const model = describeToolForInspector(
    bashRowWithOutput(`first\n${line}\nlast`),
  )
  expect(model.output?.length).toBe(3_000_017)
  const source = readFileSync(new URL('./ToolInspector.tsx', import.meta.url), 'utf8')
  expect(source).toContain('.writeText(copy)')
})

test('the wrap toggle lives on the scroll box, so it qualifies the measurements', () => {
  // Geometry: `VirtualLineList` folds its container class list into the layout
  // revision, so wrap has to be a container class and not a per-line one.
  const source = readFileSync(new URL('./ToolInspector.tsx', import.meta.url), 'utf8')
  const list = source.slice(source.indexOf('<VirtualLineList'))
  expect(list).toContain('wrap ? LINE_TEXT_CLASS.wrap : LINE_TEXT_CLASS.nowrap')
  expect(list.indexOf('className=')).toBeLessThan(list.indexOf('renderLine='))
})

test('no em dash reaches the panel (CLAUDE.md §7)', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('a\nb')} />,
  )
  expect(html).not.toContain('—')
})

/* --------------------------------------------------------------------------- *
 * The panel over a file READ, whose payload arrives already numbered
 * (`readSource.ts`; `FileReadTool.ts:721` → `addLineNumbers`).
 * --------------------------------------------------------------------------- */

function readRowWithOutput(content: string, filePath = '/w/a.ts'): NestedToolUseRow {
  return mkToolRow({
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: filePath },
    status: 'success',
    result: { isError: false, content, diff: null },
  })
}

test('the panel shows the file line numbers, not its own count beside them', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={readRowWithOutput('812\tconst x = 1\n813\tconst y = 2')} />,
  )

  // The engine prefix is gone from the body, which reads as the file's source
  // in the code theme while nothing is being searched…
  const text = html.replace(/<[^>]+>/g, '')
  expect(text).not.toContain('812\tconst x = 1')
  expect(text).toContain('const x = 1')
  expect(html).toContain('hljs-keyword')
  // …and the gutter carries the file's real lines, not 1 and 2.
  expect(html).toContain('tool-output-gutter">812</span>')
  expect(html).toContain('tool-output-gutter">813</span>')
  expect(html).not.toContain('tool-output-gutter">1</span>')
})

test('output that is not a numbered read passes through the panel untouched', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('total 4\ndrwxr-xr-x  2 pt')} />,
  )

  expect(html).toContain('total 4')
  expect(html).toContain('>1</span>') // counted, as it always was
  expect(html).toContain('>2</span>')
})

/* --------------------------------------------------------------------------- *
 * The panel over a file WRITE. The card's reveal band sends a windowed write
 * here saying `Open full output`, so this panel has to answer with the file the
 * card was showing, not the engine's one-sentence ack.
 * --------------------------------------------------------------------------- */

function writeToolRow(
  input: Record<string, unknown>,
  result: { content: string; isError: boolean },
): NestedToolUseRow {
  return mkToolRow({
    toolName: 'Write',
    toolFamily: 'write',
    input,
    status: result.isError ? 'error' : 'success',
    result: { ...result, diff: null },
  })
}

test('a write panel opens on the file that was written, not the ack', () => {
  const model = describeToolForInspector(
    writeToolRow(
      { file_path: '/w/a.ts', content: 'const x = 1\nconst y = 2' },
      { content: 'File created successfully at: /w/a.ts', isError: false },
    ),
  )

  // Since 2026-08-13 the panel no longer renders the raw input, so this
  // selection is the whole of what a write shows.
  expect(model.output).toBe('const x = 1\nconst y = 2')
})

test('a failed write keeps its error in the panel, since no file was written', () => {
  const model = describeToolForInspector(
    writeToolRow(
      { file_path: '/w/a.ts', content: 'const x = 1' },
      { content: 'EACCES: permission denied', isError: true },
    ),
  )

  expect(model.output).toBe('EACCES: permission denied')
})

test('a write with no usable input content falls back to the result', () => {
  const model = describeToolForInspector(
    writeToolRow(
      { file_path: '/w/a.ts', content: '' },
      { content: 'File created successfully at: /w/a.ts', isError: false },
    ),
  )

  expect(model.output).toBe('File created successfully at: /w/a.ts')
})

test('no other family reads its output from the input', () => {
  const model = describeToolForInspector(
    mkToolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'ls', content: 'not the output' },
      status: 'success',
      result: { isError: false, content: 'a\nb', diff: null },
    }),
  )

  expect(model.output).toBe('a\nb')
})
