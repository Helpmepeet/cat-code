import { createContext } from 'react'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export type AgentRevealRequest = { toolUseId: string; sequence: number }
export const AgentRevealContext = createContext<AgentRevealRequest | null>(null)

export function containsAgentTool(rows: readonly NestedTranscriptRow[], toolUseId: string): boolean {
  return rows.some(row => (row.kind === 'tool-use' && row.toolUseId === toolUseId) ||
    containsAgentTool(row.children, toolUseId))
}
