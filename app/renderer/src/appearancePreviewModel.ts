import type { NestedTranscriptRow, ToolFamily } from './transcriptProjector.js'
import { deriveFocusedTranscript } from './focusedTranscriptLayout.js'

function source(id: string) {
  return { id, sessionId: 'appearance-preview', messageId: `${id}-message`, frameId: `${id}-frame`, blockIndex: 0, parentToolUseId: null, children: [] }
}

function tool(id: string, toolName: string, toolFamily: ToolFamily, input: Record<string, unknown>, content: string): NestedTranscriptRow {
  return { ...source(id), kind: 'tool-use', toolUseId: id, toolName, toolFamily, input, status: 'success', agentCompletion: null, result: { content, isError: false, diff: null } }
}

// Different tool families keep the sample as three individual calls rather than
// folding adjacent reads into a run that hides the Cards/Lines distinction.
export const APPEARANCE_PREVIEW_ROWS: NestedTranscriptRow[] = [
  { ...source('preview-user'), kind: 'user-text', role: 'user', isReplay: false, content: 'Can you simplify the loader?' },
  { ...source('preview-reasoning'), kind: 'thinking', reasoningKind: 'summary', content: 'Tracing the module graph\n\nChecking the duplicate traversal' },
  tool('preview-search', 'Grep', 'grep', { pattern: 'resolveGraph', path: 'src/loader' }, 'src/loader/index.ts:12: const graph = resolveGraph(entry)'), // §7-ok: A simulated search hit is transcript data, not an engineering note in product copy.
  tool('preview-read', 'Read', 'read', { file_path: 'src/loader/index.ts' }, 'const dependencies = resolveGraph(entry)\nreturn load(resolveGraph(entry), dependencies)'),
  tool('preview-bash', 'Bash', 'bash', { command: 'bun test src/loader' }, '12 pass\n0 fail'),
]

// The final prose is rendered by ArrivingReply so replay uses the real arrival
// path in either mode. These completion rows only establish the worked fold.
const completedPreviewRows: NestedTranscriptRow[] = [
  ...APPEARANCE_PREVIEW_ROWS,
  { ...source('preview-answer'), kind: 'assistant-text', role: 'assistant', content: 'The loader now traverses the graph once.' },
  { ...source('preview-result'), kind: 'result', subtype: 'success', isError: false, errors: [], durationMs: 104000 },
]
export const APPEARANCE_PREVIEW_FOCUSED_TURN = deriveFocusedTranscript(completedPreviewRows, false)
  .find(item => item.kind === 'focused-turn')!
export const APPEARANCE_PREVIEW_USER_ROWS = APPEARANCE_PREVIEW_ROWS.slice(0, 1)

export const APPEARANCE_PREVIEW_CODE = `// One traversal builds and consumes the graph.
export function load(entry: string) {
  const seen = new Set<string>()
  return resolve(walk(entry, seen), {
    label: "loader",
    depth: 9,
  })
}`
