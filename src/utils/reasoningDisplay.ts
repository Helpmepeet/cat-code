import { getInitialSettings } from './settings/settings.js'

export type ReasoningDisplayMode = 'off' | 'summary' | 'raw'
export type ReasoningKind = 'summary' | 'raw'

type ReasoningContentBlock = {
  type?: string
  reasoningKind?: unknown
  thinking?: unknown
}

type ReasoningDisplayMessage = {
  type: string
  uuid: string
  hasRawReasoning?: boolean
  message?: {
    content: readonly ReasoningContentBlock[]
  }
}

export function getReasoningDisplayMode(): ReasoningDisplayMode {
  try {
    const value = (getInitialSettings() as { reasoningDisplay?: unknown })
      .reasoningDisplay
    if (value === 'off' || value === 'summary' || value === 'raw') return value
  } catch {}
  return 'summary'
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

export function findLastVisibleThinkingBlockId(
  messages: readonly ReasoningDisplayMessage[],
  displayMode: ReasoningDisplayMode,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.type === 'assistant' && message.message) {
      for (let j = message.message.content.length - 1; j >= 0; j--) {
        const block = message.message.content[j]
        if (block?.type !== 'thinking') continue
        const reasoningKind = block.reasoningKind
        if (reasoningKind === 'summary' || reasoningKind === 'raw') {
          const hasContent =
            typeof block.thinking === 'string' &&
            block.thinking.trim().length > 0
          if (
            !shouldShowReasoningBlock(
              displayMode,
              reasoningKind,
              message.hasRawReasoning === true,
              hasContent,
            )
          ) {
            continue
          }
        }
        return `${message.uuid}:${j}`
      }
    } else if (message.type === 'user' && message.message) {
      const hasToolResult = message.message.content.some(
        block => block.type === 'tool_result',
      )
      if (!hasToolResult) return 'no-thinking'
    }
  }
  return null
}
