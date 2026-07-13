export type ReasoningDisplayMode = 'off' | 'summary' | 'raw'
export type ReasoningKind = 'summary' | 'raw'

type ReasoningContentBlock = {
  type?: string
  reasoningKind?: unknown
  thinking?: unknown
}

export function hasUsableRawReasoning(
  content: readonly ReasoningContentBlock[],
): boolean {
  return content.some(
    block =>
      block.type === 'thinking' &&
      block.reasoningKind === 'raw' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim().length > 0,
  )
}

export function hasReasoningDisplayMetadata(
  content: readonly ReasoningContentBlock[],
): boolean {
  return content.some(
    block =>
      block.type === 'thinking' &&
      (block.reasoningKind === 'summary' || block.reasoningKind === 'raw'),
  )
}

export function shouldShowReasoningBlock(
  displayMode: ReasoningDisplayMode,
  reasoningKind: ReasoningKind,
  hasRawReasoning: boolean,
  hasContent = true,
): boolean {
  if (displayMode === 'off') return false
  if (displayMode === 'summary') return reasoningKind === 'summary'
  if (reasoningKind === 'raw' && !hasContent) return false
  return reasoningKind === 'raw' || !hasRawReasoning
}
