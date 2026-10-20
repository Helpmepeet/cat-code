import { createContext } from 'react'
import type { NestedToolUseRow, NestedTranscriptRow } from './transcriptProjector.js'

export type AgentRevealRequest = { toolUseId: string; sequence: number }
export const AgentRevealContext = createContext<AgentRevealRequest | null>(null)
/**
 * Set where Agent cards open the subagent side panel instead of nesting the
 * agent's steps inline. Null keeps inline steps, as inside the panel itself.
 */
export const AgentPanelContext = createContext<((card: NestedToolUseRow) => void) | null>(null)

export function containsAgentTool(rows: readonly NestedTranscriptRow[], toolUseId: string): boolean {
  return rows.some(row => (row.kind === 'tool-use' && row.toolUseId === toolUseId) ||
    containsAgentTool(row.children, toolUseId))
}
