import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolInspector } from './ToolInspector.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import type { ToolUseRow } from './transcriptProjector.js'

function mkToolRow(overrides: Partial<ToolUseRow>): ToolUseRow {
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
    ...overrides,
  }
}

test('derives a summary from the real input and maps pending → running/accent', () => {
  const model = describeToolForInspector(
    mkToolRow({ input: { file_path: '/etc/hosts' } }),
  )
  expect(model.summary).toBe('/etc/hosts')
  expect(model.statusLabel).toBe('running')
  expect(model.statusTone).toBe('accent')
})

test('a resolved Bash card surfaces success + output', () => {
  const model = describeToolForInspector(
    mkToolRow({
      toolName: 'Bash',
      toolFamily: 'bash',
      input: { command: 'echo hi' },
      status: 'success',
      result: { isError: false, content: 'hi\n', diff: null },
    }),
  )
  expect(model.summary).toBe('echo hi')
  expect(model.statusLabel).toBe('success')
  expect(model.statusTone).toBe('good')
  expect(model.output).toBe('hi\n')
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
  expect(model.diff?.filePath).toBe('/app/x.ts')
  expect(model.diff?.hunks[0].lines).toEqual(['-old', '+new'])
})

test('narrows tolerantly: empty input has no summary, a non-record input degrades to {}', () => {
  expect(describeToolForInspector(mkToolRow({ input: {} })).summary).toBe('none')
  // A junk input shape (defensive — the wire is unknown) must not crash.
  const junk = mkToolRow({ input: 42 as unknown as Record<string, unknown> })
  const model = describeToolForInspector(junk)
  expect(model.input).toEqual({})
  expect(model.summary).toBe('none')
})

test('falls back to the first string value when no priority key is present', () => {
  const model = describeToolForInspector(
    mkToolRow({ input: { limit: 10, note: 'inspect me' } }),
  )
  expect(model.summary).toBe('inspect me')
})

test('renders the drawer over a real row (diff lines, row named in the header)', () => {
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
  // The header names the row (`deriveSummary` over the real input), and the
  // generic title above it is gone with the rest of the metadata stack.
  expect(html).toContain('/app/x.ts')
  expect(html).not.toContain('Tool inspector')
  // Diff line tones.
  expect(html).toContain('text-tone-good')
  expect(html).toContain('text-tone-danger')
})

test('the drawer opens on the output, not on a restatement of the card', () => {
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

  expect(html).toContain('Output') // the one section label left, plus Diff
  expect(html).not.toContain('>Tool<')
  expect(html).not.toContain('>Summary<')
  expect(html).not.toContain('>Status<')
  expect(html).not.toContain('>Input<')
  // The raw structured input went with them: no JSON keys reach the drawer.
  expect(html).not.toContain('description')
})

test('renders a Diff section for a real Apply_patch row (E1 — edit-family, files[] envelope)', () => {
  // The projector maps Apply_patch's multi-file `files[]` output to a
  // single-file diff (primary file); a real apply_patch row is edit-family and
  // MUST show a Diff section, unlike a diff-less Bash row.
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
  // The Diff section header + the patched path render.
  expect(html).toContain('Diff · ')
  expect(html).toContain('/app/y.ts')
  // Add/remove diff-line tones present (proves hunk lines rendered).
  expect(html).toContain('text-tone-good')
  expect(html).toContain('text-tone-danger')
})

test('a diff-less Bash row shows NO Diff section (contrast to Apply_patch)', () => {
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
  expect(html).not.toContain('Diff · ')
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

test('output search is memoized independently from toolbar state', () => {
  // Static SSR cannot toggle Wrap, so pin the dependency boundary at source.
  const source = readFileSync(new URL('./ToolInspector.tsx', import.meta.url), 'utf8')
  expect(source).toContain('() => describeOutputSearch(body, query, matchIndex)')
  expect(source).toContain('[body, query, matchIndex]')
})

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

test('no em dash reaches the drawer (CLAUDE.md §7)', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('a\nb')} />,
  )
  expect(html).not.toContain('—')
})

/* --------------------------------------------------------------------------- *
 * The drawer over a file READ, whose payload arrives already numbered
 * (`readSource.ts`; `FileReadTool.ts:721` → `addLineNumbers`).
 * --------------------------------------------------------------------------- */

function readRowWithOutput(content: string, filePath = '/w/a.ts'): ToolUseRow {
  return mkToolRow({
    toolName: 'Read',
    toolFamily: 'read',
    input: { file_path: filePath },
    status: 'success',
    result: { isError: false, content, diff: null },
  })
}

test('the drawer shows the file line numbers, not its own count beside them', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={readRowWithOutput('812\tconst x = 1\n813\tconst y = 2')} />,
  )

  // The engine prefix is gone from the body…
  expect(html).not.toContain('812\tconst x = 1')
  expect(html).toContain('const x = 1')
  // …and the gutter carries the file's real lines, not 1 and 2.
  expect(html).toContain('>812</span>')
  expect(html).toContain('>813</span>')
  expect(html).not.toContain('>1</span>')
})

test('output that is not a numbered read passes through the drawer untouched', () => {
  const html = renderToStaticMarkup(
    <ToolInspector row={bashRowWithOutput('total 4\ndrwxr-xr-x  2 pt')} />,
  )

  expect(html).toContain('total 4')
  expect(html).toContain('>1</span>') // counted, as it always was
  expect(html).toContain('>2</span>')
})

/* --------------------------------------------------------------------------- *
 * The drawer over a file WRITE. The card's reveal band sends a windowed write
 * here saying `Open full output`, so this panel has to answer with the file the
 * card was showing, not the engine's one-sentence ack.
 * --------------------------------------------------------------------------- */

function writeToolRow(
  input: Record<string, unknown>,
  result: { content: string; isError: boolean },
): ToolUseRow {
  return mkToolRow({
    toolName: 'Write',
    toolFamily: 'write',
    input,
    status: result.isError ? 'error' : 'success',
    result: { ...result, diff: null },
  })
}

test('a write drawer opens on the file that was written, not the ack', () => {
  const model = describeToolForInspector(
    writeToolRow(
      { file_path: '/w/a.ts', content: 'const x = 1\nconst y = 2' },
      { content: 'File created successfully at: /w/a.ts', isError: false },
    ),
  )

  expect(model.output).toBe('const x = 1\nconst y = 2')
  // The model still carries the input verbatim, but since 2026-08-13 the drawer
  // no longer renders it, so this selection is the whole of what a write shows.
  expect(model.input.content).toBe('const x = 1\nconst y = 2')
})

test('a failed write keeps its error in the drawer, since no file was written', () => {
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
