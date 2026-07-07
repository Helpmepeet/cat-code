import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { describeToolForInspector, ToolInspector } from './ToolInspector.js'
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

test('narrows tolerantly: empty input → "—", a non-record input degrades to {}', () => {
  expect(describeToolForInspector(mkToolRow({ input: {} })).summary).toBe('—')
  // A junk input shape (defensive — the wire is unknown) must not crash.
  const junk = mkToolRow({ input: 42 as unknown as Record<string, unknown> })
  const model = describeToolForInspector(junk)
  expect(model.input).toEqual({})
  expect(model.summary).toBe('—')
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

test('renders nothing when there is no row', () => {
  expect(renderToStaticMarkup(<ToolInspector row={null} />)).toBe('')
})
