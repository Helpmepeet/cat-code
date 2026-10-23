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
  explainBlockedReason?: string
  explain?(run: InlineCommandRun): void
  start(source: InlineCommandSource): void
  stop(run: InlineCommandRun): void
}
export const InlineCommandContext = createContext<InlineCommandContextValue | null>(null)

export function getInlineCommandAvailability(input: {
  connected: boolean
  workspaceBusy: boolean
  waitingForPermission: boolean
  generating: boolean
  queuedPrompt: boolean
  attachmentPending: boolean
}): { blockedReason?: string; explainBlockedReason?: string } {
  const blockedReason = !input.connected ? 'Connect to a trusted workspace before running a command.'
    : input.workspaceBusy ? 'Wait for the workspace to become available.' : undefined
  return {
    blockedReason,
    explainBlockedReason: blockedReason ??
      (input.waitingForPermission ? 'Respond to the pending permission request first.'
        : input.generating ? 'Wait for the current turn to finish.'
          : input.queuedPrompt ? 'Wait for queued prompts to finish.'
            : input.attachmentPending ? 'Wait for the attachment to finish.' : undefined),
  }
}
