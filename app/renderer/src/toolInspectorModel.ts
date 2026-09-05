import type {
  ToolDiffProjection,
  ToolFamily,
  ToolUseRow,
} from './transcriptProjector.js'

/**
 * Exactly what the drawer paints. The Tool / Summary / Status / raw-Input stack
 * was removed on 2026-08-13 (see `ToolInspector.tsx`'s header); the model was
 * left computing its fields, so they are gone from here too rather than sitting
 * as a second, unread account of a row the card already describes.
 */
export type ToolInspectorModel = {
  family: ToolFamily
  summary: string
  diff: ToolDiffProjection | null
  output: string | null
}

const SUMMARY_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'name',
] as const

export function describeToolForInspector(row: ToolUseRow): ToolInspectorModel {
  const input = isRecord(row.input) ? row.input : {}
  return {
    family: row.toolFamily,
    summary: deriveSummary(input),
    diff: row.result?.diff ?? null,
    output: selectOutput(row, input),
  }
}

/**
 * What the drawer's Output panel shows: the tool's result, except for a WRITE.
 *
 * A Write result is one of two fixed sentences and never the file
 * (`src/tools/FileWriteTool/FileWriteTool.ts:418-433`); the file is the tool's
 * input (`content`, `:63`). The card's body already reads it there
 * (`WriteBody`, `TranscriptView.tsx`), and the card's reveal band sends a
 * windowed write HERE under the label `Open full output`. Answering that with a
 * one-line sentence instead of the rest of the file breaks the promise the band
 * made, so the two surfaces read the same string.
 *
 * A FAILED write keeps its result: that one carries the error, and there is no
 * written file to show. So does a write whose input has no usable `content`.
 *
 * This used to end "the raw input panel is untouched either way, so nothing is
 * hidden by this". That stopped being true on 2026-08-13, when the drawer lost
 * its Input section: `output` is now the ONLY thing the drawer shows for a
 * write, so this selection decides what is visible rather than which of two
 * panels leads.
 */
function selectOutput(
  row: ToolUseRow,
  input: Record<string, unknown>,
): string | null {
  if (row.result?.isCancelled === true) return null
  const result = nonEmpty(row.result?.content)
  if (row.toolFamily !== 'write' || row.result?.isError === true) return result
  const written = input['content']
  return typeof written === 'string' && written.length > 0 ? written : result
}

function deriveSummary(input: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
  }
  return 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
