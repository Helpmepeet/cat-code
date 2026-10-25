import { deriveToolFamily, type FocusedLiveState, type NestedTranscriptRow } from './transcriptProjector.js'
import { deriveTarget } from './transcriptToolTarget.js'
import type { ToolActivity } from '../../../src/app-runtime/toolActivityContract.js'

export type FocusedCall = Extract<NestedTranscriptRow, { kind: 'tool-use' }> & { preparing?: true; awaitingApproval?: true; additions?: number; activity?: ToolActivity }
const verbs: Record<string, string> = { bash: 'Running', read: 'Reading', edit: 'Editing', write: 'Writing', grep: 'Searching', agent: 'Delegating', web: 'Fetching', notebook: 'Editing' }
const past: Record<string, string> = { bash: 'Ran', read: 'Read', edit: 'Edited', write: 'Wrote', grep: 'Searched', agent: 'Delegated', web: 'Fetched', notebook: 'Edited' }
export function callVerb(call: FocusedCall, signalled: boolean): string {
  if (call.preparing) return 'Preparing'
  if (call.status !== 'pending') return past[call.toolFamily] ?? 'Used'
  if (call.awaitingApproval) return verbs[call.toolFamily] ?? 'Using'
  return call.activity?.phase === 'reviewing' ? 'Reviewing' : call.activity?.phase === 'executing' || !signalled ? verbs[call.toolFamily] ?? 'Using' : 'Queued'
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`
}
export function callTarget(call: FocusedCall): string { return deriveTarget(call) }
export function rollingCalls(calls: readonly FocusedCall[]): FocusedCall[] {
  const rank = (c: FocusedCall) => c.status === 'pending' && c.activity ? 0 : c.preparing ? 1 : c.status !== 'pending' ? 2 : 3
  const picked = calls.map((call, index) => ({ call, index })).sort((a, b) => rank(a.call) - rank(b.call) || (rank(a.call) === 2 ? b.index - a.index : a.index - b.index)).slice(0, 3)
  return picked.sort((a, b) => a.index - b.index).map(item => item.call)
}

/** Read incomplete JSON strings without inventing a stored tool-use row. */
function partialField(json: string, field: string): string {
  const found = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(json)?.[1] ?? ''
  try { return JSON.parse(`"${found.replace(/\\$/, '')}"`) as string } catch { return found }
}
export function preparingCalls(state: FocusedLiveState | null, sessionId: string): FocusedCall[] {
  return Object.values(state?.preparing ?? {}).map(tool => {
    const input = Object.fromEntries(['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'notebook_path', 'to', 'agentId', 'skill'].map(key => [key, partialField(tool.json, key)]))
    const patch = tool.json.startsWith('***') ? tool.json : partialField(tool.json, 'patch') || partialField(tool.json, 'input')
    const file = partialField(tool.json, 'file_path') || partialField(tool.json, 'path') || /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/.exec(patch)?.[1] || ''
    const added = partialField(tool.json, 'new_string') || partialField(tool.json, 'content')
    return { kind: 'tool-use', id: `preparing:${tool.toolUseId}`, sessionId, frameId: tool.messageId, messageId: tool.messageId,
      blockIndex: tool.blockIndex, parentToolUseId: null, toolUseId: tool.toolUseId, toolName: tool.toolName, toolFamily: deriveToolFamily(tool.toolName),
      input: { ...input, file_path: file }, status: 'pending', result: null, agentCompletion: null, children: [], preparing: true,
      additions: patch ? patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length : added ? added.split('\n').length : 0 }
  })
}
