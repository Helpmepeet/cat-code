import { createContext } from 'react'
import type { InlineCommandRequest, InlineCommandRun, InlineCommandSource } from '../../shared/inlineCommand.js'

export type InlineCommandContextValue = {
  engineSessionId: string | null
  generation?: string
  runs: InlineCommandRun[]
  requests: InlineCommandRequest[]
  pending: ReadonlyMap<string, { requestId: string; generation: string; previousRunId?: string }>
  errors: ReadonlyMap<string, string>
  blockedReason?: string
  start(source: InlineCommandSource): void
  stop(run: InlineCommandRun): void
}
export const InlineCommandContext = createContext<InlineCommandContextValue | null>(null)

export function getInlineCommandAvailability(input: {
  connected: boolean
  workspaceBusy: boolean
}): { blockedReason?: string } {
  const blockedReason = !input.connected ? 'Connect to a trusted workspace before running a command.'
    : input.workspaceBusy ? 'Wait for the workspace to become available.' : undefined
  return {
    blockedReason,
  }
}
