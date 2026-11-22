import type { MessageOrigin } from '../types/message.js'

type CommandLifecycleState = 'started' | 'completed'
type AgentOutcomeDisplay = { prompt: string; origin: MessageOrigin }

type CommandLifecycleListener = (
  uuid: string,
  state: CommandLifecycleState,
  timestamp?: string,
  agentOutcome?: AgentOutcomeDisplay,
) => void

let listener: CommandLifecycleListener | null = null

export function setCommandLifecycleListener(
  cb: CommandLifecycleListener | null,
): void {
  listener = cb
}

export function notifyCommandLifecycle(
  uuid: string,
  state: CommandLifecycleState,
  timestamp?: string,
  agentOutcome?: AgentOutcomeDisplay,
): void {
  listener?.(uuid, state, timestamp, agentOutcome)
}
