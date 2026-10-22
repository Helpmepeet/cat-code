import { createContext } from 'react'
import type { InlineCommandRequest, InlineCommandRun, InlineCommandSource } from '../../shared/inlineCommand.js'

export type InlineCommandContextValue = {
  engineSessionId: string | null
  generation?: string
  runs: InlineCommandRun[]
  requests: InlineCommandRequest[]
  pending: ReadonlyMap<string, { requestId: string; generation: string; previousRunId?: string }>
  errors: ReadonlyMap<string, string>
  start(source: InlineCommandSource): void
  stop(run: InlineCommandRun): void
}
export const InlineCommandContext = createContext<InlineCommandContextValue | null>(null)
