type HandoffCaller = { agentId?: unknown; turnHandoff?: TurnHandoff }

export type HandoffRequest = { operationId: string; toolUseId: string }
export type HandoffBoundary = { tip_uuid: string; tool_use_id: string }
export type HandoffTerminalOutcome = 'failed' | 'cancelled' | 'uncertain'

/** Shared by every executor/provider attempt in one main conversational turn. */
export class TurnHandoff {
  private request: HandoffRequest | null = null
  private pending: HandoffRequest | null = null
  private invalid = false

  reserve(context: HandoffCaller, request: HandoffRequest): void {
    if (context.agentId || context.turnHandoff !== this || this.invalid || this.pending || this.request || !request.operationId || !request.toolUseId) {
      throw new Error('Handoff cannot be reserved')
    }
    this.pending = { ...request }
  }

  release(operationId: string): void {
    if (this.request) throw new Error('Accepted handoff cannot be released within its turn')
    if (this.pending?.operationId === operationId) this.pending = null
  }

  accept(context: HandoffCaller, request: HandoffRequest): void {
    if (context.agentId || context.turnHandoff !== this) {
      throw new Error('Only the main conversational turn can hand off')
    }
    if (this.invalid || this.request || !request.operationId || !request.toolUseId ||
      (this.pending && (this.pending.operationId !== request.operationId || this.pending.toolUseId !== request.toolUseId))) {
      throw new Error('Handoff cannot be accepted')
    }
    this.request = { ...request }
  }

  get accepted(): HandoffRequest | null { return this.request }
  get requested(): HandoffRequest | null { return this.request ?? this.pending }
  get isValid(): boolean { return !this.invalid }
  invalidate(): void { this.invalid = true }
}

export function getAcceptedHandoff(context: HandoffCaller): HandoffRequest | null {
  return context.agentId ? null : context.turnHandoff?.accepted ?? null
}

export function isHandoffExecutionFenced(context: HandoffCaller): boolean {
  return !context.agentId && Boolean(context.turnHandoff?.accepted ||
    (context.turnHandoff?.requested && !context.turnHandoff.isValid))
}

export function handoffContinuationPrompt(): string {
  return 'The conversation has moved to the selected workspace. Its instructions are now loaded. Continue the existing user request from the saved conversation. Do not repeat completed work or attempt another workspace jump.'
}

export function handoffTerminalPrompt(outcome: HandoffTerminalOutcome): string {
  if (outcome === 'uncertain') return 'The workspace changed, but continuation completion could not be confirmed. Some work may have started. Wait for the user to reconcile the conversation before continuing.'
  return outcome === 'cancelled'
    ? 'The workspace change or continuation was stopped. Some work may have started. Wait for the user to review existing progress and provide the next instruction.'
    : 'The accepted workspace jump could not finish safely. Work did not continue. Wait for the user to reconcile the conversation before continuing.'
}

export function handoffOutcomeText(outcome: HandoffTerminalOutcome): string {
  if (outcome === 'uncertain') return 'The workspace changed, but completion could not be confirmed. Some work may have started. Send a message to review what happened.'
  if (outcome === 'cancelled') return 'The workspace change or continuation was stopped. Review existing progress before continuing.'
  return 'The workspace change could not finish. Work did not continue. Send a message when you are ready to continue.'
}

export function readHandoffOutcomeData(value: unknown): { operationId: string; outcome: HandoffTerminalOutcome } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (Object.keys(data).sort().join(',') !== 'operationId,outcome' ||
    typeof data.operationId !== 'string' || !data.operationId || data.operationId.length > 128 ||
    typeof data.outcome !== 'string' || !['failed', 'cancelled', 'uncertain'].includes(data.outcome)) return null
  return { operationId: data.operationId, outcome: data.outcome as HandoffTerminalOutcome }
}
