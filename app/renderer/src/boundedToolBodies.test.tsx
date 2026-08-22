/**
 * CC-62 — every routed tool body and both diff surfaces mount a bounded amount
 * of DOM, whatever the payload is.
 *
 * WHY THESE NUMBERS ARE LITERALS. Every other mounting assertion in this
 * package used to read `expect(measured).toBeLessThanOrEqual(MAX_SOMETHING)`,
 * which compares a budget against itself: an adversarial review took two
 * budgets to a billion with the suite still green. So each family is measured
 * against a literal, AND against the same measurement over a source ten times
 * bigger. A raised budget moves the second number, which is what fails.
 *
 * WHAT SSR CAN AND CANNOT PROVE. These render to static markup, so the
 * virtualizer runs with its initial viewport and no measurement: the window is
 * the fixed-geometry one, and 36 rows is what a 384px viewport plus overscan
 * frames. That is exactly the point — the mounted count is decided by the
 * viewport, never by the payload. Real measured heights, real scrolling and the
 * `MAX_MOUNTED_OUTPUT_LINES` ceiling on a tall viewport are browser-only and
 * live in `lineWindow.test.ts` against the model.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolInspector } from './ToolInspector.js'
import { describeOutputSearch } from './outputSearchModel.js'
import { describeToolForInspector } from './toolInspectorModel.js'
import { parseReadSource } from './readSource.js'
import type {
  NestedToolUseRow,
  NestedTranscriptRow,
  ToolCardStatus,
  ToolDiffProjection,
  ToolFamily,
  ToolResultProjection,
} from './transcriptProjector.js'

const blockSource = {
  sessionId: 's' as const,
  messageId: 'm',
  frameId: 'f',
  blockIndex: 0,
  parentToolUseId: null,
  children: [] as NestedTranscriptRow[],
}

function toolRow(fields: {
  toolName: string
  toolFamily: ToolFamily
  input?: Record<string, unknown>
  status?: ToolCardStatus
  result?: ToolResultProjection | null
}): NestedToolUseRow {
  return {
    ...blockSource,
    id: `s:m:0:${fields.toolName}`,
    kind: 'tool-use',
    toolUseId: `toolu_${fields.toolName}`,
    toolName: fields.toolName,
    toolFamily: fields.toolFamily,
    agentCompletion: null,
    input: fields.input ?? {},
    status: fields.status ?? 'error',
    result: fields.result ?? null,
  }
}

function render(row: NestedTranscriptRow): string {
  return renderToStaticMarkup(<TranscriptRowsView rows={[row]} />)
}

/** Rows the virtualizer actually mounted: each gets the grid's minimum height. */
function mountedRows(html: string): number {
  return occurrences(html, 'class="min-h-[20px]"')
}

/** Every element in the render, the card chrome included. */
function mountedElements(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length
}

/** Everything a reader can see, with the markup taken back out. */
function mountedText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/* ── the payloads ─────────────────────────────────────────────────────────── */

const HUGE_LINES = 50_000
const BIGGER_LINES = 500_000

/** A file read, in the engine's own `cat -n` shape. */
function numbered(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `${index + 1}\tconst v${index} = ${index}`,
  ).join('\n')
}

function sourceLines(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `const v${index} = ${index}`,
  ).join('\n')
}

function grepLines(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `src/a.ts:${index + 1}:const v${index} = ${index}`,
  ).join('\n')
}

/** One logical line, and nothing else. The row ceiling cannot help here. */
function giantLine(characters: number): string {
  return `const value = "${'x'.repeat(characters)}"`
}

function wholeFilePatch(count: number): ToolDiffProjection {
  return {
    filePath: '/repo/big.ts',
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: count,
        lines: Array.from(
          { length: count },
          (_unused, index) => `+const v${index} = ${index}`,
        ),
      },
    ],
  }
}

/* ── the families ─────────────────────────────────────────────────────────── */

type Family = {
  name: string
  /** A body of `count` ordinary lines. */
  many: (count: number) => NestedTranscriptRow
  /** A body that is ONE logical line of `characters` characters. */
  one: (characters: number) => NestedTranscriptRow
}

const families: Family[] = [
  {
    name: 'a file read',
    many: count =>
      toolRow({
        toolName: 'Read',
        toolFamily: 'read',
        input: { file_path: '/w/big.ts' },
        result: { content: numbered(count), isError: true, diff: null },
      }),
    one: characters =>
      toolRow({
        toolName: 'Read',
        toolFamily: 'read',
        input: { file_path: '/w/big.ts' },
        result: { content: `1\t${giantLine(characters)}`, isError: true, diff: null },
      }),
  },
  {
    name: 'a file write',
    many: count =>
      toolRow({
        toolName: 'Write',
        toolFamily: 'write',
        input: { file_path: '/w/big.ts', content: sourceLines(count) },
        result: { content: 'File created', isError: false, diff: null },
      }),
    one: characters =>
      toolRow({
        toolName: 'Write',
        toolFamily: 'write',
        input: { file_path: '/w/big.ts', content: giantLine(characters) },
        result: { content: 'File created', isError: false, diff: null },
      }),
  },
  {
    name: 'a search',
    many: count =>
      toolRow({
        toolName: 'Grep',
        toolFamily: 'grep',
        input: { pattern: 'const' },
        result: { content: grepLines(count), isError: false, diff: null },
      }),
    one: characters =>
      toolRow({
        toolName: 'Grep',
        toolFamily: 'grep',
        input: { pattern: 'const' },
        result: {
          content: `src/a.ts:1:${giantLine(characters)}`,
          isError: false,
          diff: null,
        },
      }),
  },
  {
    name: 'an image call result',
    many: count =>
      toolRow({
        toolName: 'GenerateImage',
        toolFamily: 'imagegen',
        input: { prompt: 'a cat' },
        result: { content: sourceLines(count), isError: false, diff: null },
      }),
    one: characters =>
      toolRow({
        toolName: 'GenerateImage',
        toolFamily: 'imagegen',
        input: { prompt: 'a cat' },
        result: { content: giantLine(characters), isError: false, diff: null },
      }),
  },
  {
    name: 'a diff card',
    many: count =>
      toolRow({
        toolName: 'Edit',
        toolFamily: 'edit',
        input: { file_path: '/repo/big.ts' },
        result: { content: '', isError: true, diff: wholeFilePatch(count) },
      }),
    one: characters =>
      toolRow({
        toolName: 'Edit',
        toolFamily: 'edit',
        input: { file_path: '/repo/big.ts' },
        result: {
          content: '',
          isError: true,
          diff: {
            filePath: '/repo/big.ts',
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: [`+${giantLine(characters)}`],
              },
            ],
          },
        },
      }),
  },
]

describe('a body of 50,000 lines mounts a bounded number of rows', () => {
  for (const family of families) {
    test(family.name, () => {
      const html = render(family.many(HUGE_LINES))
      const rows = mountedRows(html)

      // Something rendered, and it is the viewport's worth, not the payload's.
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThan(60)
      expect(mountedElements(html)).toBeLessThan(700)
      expect(mountedText(html).length).toBeLessThan(6_000)

      // Ten times the source, the same mounted rows. This is the assertion a
      // raised budget cannot survive.
      const bigger = render(family.many(BIGGER_LINES))
      expect(mountedRows(bigger)).toBe(rows)
    })
  }
})

describe('one logical line of 200,000 characters mounts a bounded row', () => {
  for (const family of families) {
    test(family.name, () => {
      const html = render(family.one(200_000))

      expect(mountedRows(html)).toBe(1)
      // The character budget is 4,000 plus a cut mark, and the card chrome
      // around it is a few dozen characters of its own.
      expect(mountedText(html).length).toBeLessThan(4_500)
      expect(mountedText(html)).toContain('…')

      // Five times the line, the same mounted characters.
      const bigger = render(family.one(1_000_000))
      expect(mountedText(bigger).length).toBe(mountedText(html).length)
    })
  }
})

describe('the logical model behind a bounded body stays complete', () => {
  test('a read still numbers its rows with the file lines it really is', () => {
    const content = Array.from(
      { length: 900 },
      (_unused, index) => `${index + 801}\tconst v${index} = ${index}`,
    ).join('\n')
    const html = render(
      toolRow({
        toolName: 'Read',
        toolFamily: 'read',
        input: { file_path: '/w/big.ts' },
        result: { content, isError: true, diff: null },
      }),
    )

    // The window's head starts at the file's real first line, and the band
    // states the true size of the gap it is hiding.
    expect(html).toContain('text-text-subtle/60">801</span>')
    expect(html).toContain('864 lines hidden')
    // The parse that produced those numbers kept every line.
    expect(parseReadSource(content).numbers).toHaveLength(900)
  })

  test('a diff card mounts a window while the model holds every hunk line', () => {
    const diff = wholeFilePatch(HUGE_LINES)
    const html = render(
      toolRow({
        toolName: 'Edit',
        toolFamily: 'edit',
        input: { file_path: '/repo/big.ts' },
        result: { content: '', isError: true, diff },
      }),
    )

    expect(mountedRows(html)).toBeLessThan(60)
    expect(diff.hunks[0].lines).toHaveLength(HUGE_LINES)
    // The card head still counts the whole patch, not the mounted slice.
    expect(html).toContain(`+${HUGE_LINES}`)
  })

  test('every family republishes its complete output to the drawer', () => {
    // `Copy` and the search field both read this string, and it is the whole
    // one the card was given, whatever the card mounted. A write is the one
    // family whose output is its INPUT, which is the file it wrote.
    for (const family of families) {
      const row = family.many(HUGE_LINES)
      if (row.kind !== 'tool-use' || row.result === null) throw new Error('fixture')
      const expected =
        row.toolFamily === 'write' ? row.input['content'] : row.result.content
      expect(describeToolForInspector(row).output ?? '').toBe(
        typeof expected === 'string' ? expected : '',
      )
    }
  })

  test('copy and search read the whole output, not the mounted part', () => {
    const content = sourceLines(HUGE_LINES)
    const model = describeToolForInspector({
      ...toolRow({
        toolName: 'Bash',
        toolFamily: 'bash',
        input: { command: 'cat big.ts' },
        status: 'success',
        result: { content, isError: false, diff: null },
      }),
      children: undefined,
    } as never)

    // `Copy` writes this string; it is the complete output.
    expect(model.output).toBe(content)
    expect(model.output?.split('\n')).toHaveLength(HUGE_LINES)

    // And a search finds a match on the very last line, which no viewport
    // mounted.
    const search = describeOutputSearch(content, `v${HUGE_LINES - 1} `, 0)
    expect(search.totalLines).toBe(HUGE_LINES)
    expect(search.matches).toEqual([HUGE_LINES])
    expect(search.activeLine).toBe(HUGE_LINES)
  })
})

describe('the inspector drawer bounds its own diff section', () => {
  test('a whole-file patch mounts a window, and the row list stays complete', () => {
    const diff = wholeFilePatch(HUGE_LINES)
    const row = toolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/repo/big.ts' },
      status: 'success',
      result: { content: '', isError: false, diff },
    })
    const html = renderToStaticMarkup(<ToolInspector row={row} />)

    const rows = mountedRows(html)
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(60)
    expect(mountedElements(html)).toBeLessThan(700)

    const bigger = renderToStaticMarkup(
      <ToolInspector
        row={toolRow({
          toolName: 'Edit',
          toolFamily: 'edit',
          input: { file_path: '/repo/big.ts' },
          status: 'success',
          result: { content: '', isError: false, diff: wholeFilePatch(BIGGER_LINES) },
        })}
      />,
    )
    expect(mountedRows(bigger)).toBe(rows)
    expect(describeToolForInspector(row).diff?.hunks[0].lines).toHaveLength(HUGE_LINES)
  })

  test('one minified patch line mounts a bounded row', () => {
    const row = toolRow({
      toolName: 'Edit',
      toolFamily: 'edit',
      input: { file_path: '/repo/big.ts' },
      status: 'success',
      result: {
        content: '',
        isError: false,
        diff: {
          filePath: '/repo/big.ts',
          hunks: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: [`+${giantLine(200_000)}`],
            },
          ],
        },
      },
    })
    const html = renderToStaticMarkup(<ToolInspector row={row} />)

    expect(mountedRows(html)).toBe(1)
    expect(mountedText(html).length).toBeLessThan(4_500)
    expect(mountedText(html)).toContain('…')
  })
})
