export type ReasoningDisplayMode = 'off' | 'summary' | 'raw'
export type ReasoningKind = 'summary' | 'raw'

export function shouldShowReasoningBlock(
  displayMode: ReasoningDisplayMode,
  reasoningKind: ReasoningKind,
  hasRawReasoning: boolean,
): boolean {
  if (displayMode === 'off') return false
  if (displayMode === 'summary') return reasoningKind === 'summary'
  return reasoningKind === 'raw' || !hasRawReasoning
}
