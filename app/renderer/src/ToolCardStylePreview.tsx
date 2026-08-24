/**
 * The live transcript canvas that heads Settings ▸ Transcript, above the
 * "Tool calls" picker.
 *
 * IT MUST BE THE TRANSCRIPT'S OWN ROWS, NOT A LOOKALIKE — the same rule
 * `CodeThemePreview` states for the code block, and for the same reason: a
 * preview that draws its own approximation drifts from the real thing the
 * moment either side is touched, and the picker above it then advertises a
 * drawing the transcript does not produce. So the sample goes through the
 * exported `TranscriptRowsView`, which brings the real shells, the real family
 * marks, the real collapsed peek and the real spacing with it.
 *
 * The style is applied by neither: `ToolCardStyleProvider` sits above the whole
 * app (`main.tsx`) and the shells read the context, so this recolours on a
 * picker change with no prop and no reload. That is why it takes no arguments.
 *
 * FIXED HEIGHT, deliberately. The two styles draw the same calls at different
 * heights, and a canvas that grows on change shoves the picker out from under
 * the pointer that just used it. The height fits the taller style (`cards`);
 * `lines` leaves space at the bottom, which is the density being chosen made
 * visible rather than a gap to close.
 *
 * The sample is three rows on purpose: two adjacent reads, so the flush spacing
 * `lines` applies between neighbouring tool rows is visible, and a finished bash
 * call whose output shows as a collapsed peek, which is the most common row in
 * a real transcript and the one that differs most between the two styles.
 */

import type { NestedTranscriptRow } from './transcriptProjector.js'
import { TranscriptRowsView } from './TranscriptView.js'

const PREVIEW_SESSION = 'settings-preview'

function previewToolRow(
  id: string,
  toolName: string,
  toolFamily: 'read' | 'bash',
  input: Record<string, unknown>,
  content: string,
): NestedTranscriptRow {
  return {
    sessionId: PREVIEW_SESSION,
    messageId: `${id}-m`,
    frameId: `${id}-f`,
    blockIndex: 0,
    parentToolUseId: null,
    children: [],
    id,
    kind: 'tool-use',
    toolUseId: `toolu_${id}`,
    toolName,
    toolFamily,
    agentCompletion: null,
    input,
    status: 'success',
    result: { content, isError: false, diff: null },
  }
}

const PREVIEW_ROWS: NestedTranscriptRow[] = [
  previewToolRow(
    'preview-read-1',
    'Read',
    'read',
    { file_path: 'src/loader/index.ts' },
    'export function load(entry) {\n  return resolve(walk(entry))\n}',
  ),
  previewToolRow(
    'preview-read-2',
    'Read',
    'read',
    { file_path: 'src/loader/graph.ts' },
    'export function walk(entry) {\n  return crawl(entry, new Set())\n}',
  ),
  previewToolRow(
    'preview-bash-1',
    'Bash',
    'bash',
    { command: 'bun test src/loader' },
    '12 pass\n0 fail\nRan 12 tests across 3 files. [1.42s]',
  ),
]

export function ToolCardStylePreview() {
  return (
    <div className="h-[188px] overflow-hidden rounded-lg border border-shell-seam bg-app-bg">
      <TranscriptRowsView rows={PREVIEW_ROWS} />
    </div>
  )
}
