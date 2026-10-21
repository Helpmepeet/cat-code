import type {
  NestedToolUseRow,
  ToolDiffProjection,
  ToolFamily,
} from './transcriptProjector.js'
import { selectToolDiffs } from './toolDiffs.js'
import { peerToolPresentation, type PeerToolPresentation } from './peerSurfaces.js'
import { readSourceLanguage } from './readSource.js'
import { deriveTarget } from './transcriptToolTarget.js'

/**
 * Exactly what the full-output panel paints. The Tool / Summary / Status /
 * raw-Input stack was removed on 2026-08-13 (see `ToolInspector.tsx`'s header).
 * What is left is the row's identity, framed the way its card frames it, and
 * the two bodies a call can carry: the changes it made and the text it
 * returned.
 */
export type ToolInspectorModel = {
  family: ToolFamily
  /** The peer tools' own mark and word, which replace the family's. */
  presentation: PeerToolPresentation | null
  /** The card's one-line target (`deriveTarget`), so the two read the same. */
  target: string
  diffs: readonly ToolDiffProjection[]
  output: string | null
  /** True when `output` arrives in the engine's numbered read format. */
  numberedRead: boolean
  /** The highlighter language when `output` is a file's source, else null. */
  outputLanguage: string | null
  failed: boolean
}

export function describeToolForInspector(
  row: NestedToolUseRow,
  cwd: string | null = null,
): ToolInspectorModel {
  const input = isRecord(row.input) ? row.input : {}
  const output = selectOutput(row, input)
  const failed = row.result?.isError === true
  const source = !failed && (row.toolFamily === 'read' || row.toolFamily === 'write')
  return {
    family: row.toolFamily,
    presentation: peerToolPresentation(row.toolName, input),
    target: deriveTarget(input === row.input ? row : { ...row, input }, cwd),
    diffs: selectToolDiffs(row.result),
    output,
    numberedRead: row.toolFamily === 'read',
    outputLanguage: source && output !== null ? readSourceLanguage(input['file_path']) : null,
    failed,
  }
}

/**
 * What the panel's text body shows: the tool's result, except for a WRITE.
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
 * The panel has no raw-input section, so this selection decides what is
 * visible for a write rather than which of two sections leads.
 */
function selectOutput(
  row: NestedToolUseRow,
  input: Record<string, unknown>,
): string | null {
  if (row.result?.isCancelled === true) return null
  const result = nonEmpty(row.result?.content)
  if (row.toolFamily !== 'write' || row.result?.isError === true) return result
  const written = input['content']
  return typeof written === 'string' && written.length > 0 ? written : result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
