import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from './TranscriptView.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { highlightedLines } from './diffHighlight.js'

/**
 * The regression: a highlighted token that spans a BLANK line. Splitting it used
 * to clone the element with zero children arguments, which React reads as "keep
 * the original children" — so the empty line reprinted the whole token.
 */
test('a token spanning a blank line contributes nothing to that line', () => {
  const lines = highlightedLines([
    createElement('span', { className: 'hljs-string', key: 's' }, 'alpha\n\nbeta'),
  ])

  expect(lines).toHaveLength(3)
  expect(lines[1]).toEqual([])
  expect(renderToStaticMarkup(createElement('i', null, ...lines[0]))).toContain('alpha')
  expect(renderToStaticMarkup(createElement('i', null, ...lines[2]))).toContain('beta')
})

/**
 * The same case through the surface that owns it: an Edit card's diff body. A
 * blank line ADDED inside a template literal is the everyday trigger, and the
 * damage is only visible once the row is rendered — the reprinted token carries
 * its own newlines into a `whitespace-pre` row and breaks the line grid.
 */
test('an added blank line inside a multi-line token does not reprint the token', () => {
  const html = renderToStaticMarkup(
    createElement(TranscriptRowsView, {
      rows: [
        diffRow([' const banner = `alpha', '+', ' beta`', ' const after = 1']),
      ],
    }),
  )

  // `whitespace-pre` moved onto the diff body's scroll box when the rows were
  // virtualized (CC-62), so a row now opens on its own wash class alone.
  const rows = html.split('<div class="flex ')
  const blankRow = rows.find(row => row.includes('text-tone-success'))
  expect(blankRow).toBeDefined()
  expect(blankRow).not.toContain('alpha')
  expect(occurrences(html, 'alpha')).toBe(1)
})

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function diffRow(lines: string[]): NestedTranscriptRow {
  return {
    id: 's:m:0:Edit',
    sessionId: 's',
    messageId: 'm',
    frameId: 'f',
    blockIndex: 0,
    parentToolUseId: null,
    kind: 'tool-use',
    toolUseId: 'toolu_diff_blank_line',
    toolName: 'Edit',
    toolFamily: 'edit',
    agentCompletion: null,
    input: { file_path: '/repo/banner.ts' },
    // An errored card opens itself, which is how the body renders under SSR.
    status: 'error',
    result: {
      isError: true,
      content: '',
      diff: {
        filePath: '/repo/banner.ts',
        hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines }],
      },
    },
    children: [],
  }
}
