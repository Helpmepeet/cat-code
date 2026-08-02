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

test('renders the drawer over a real row (structured input as text, diff lines)', () => {
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
  expect(html).toContain('Tool inspector')
  expect(html).toContain('/app/x.ts')
  // Structured input rendered as escaped JSON text, never HTML.
  expect(html).toContain('file_path')
  // Diff line tones.
  expect(html).toContain('text-tone-good')
  expect(html).toContain('text-tone-danger')
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
