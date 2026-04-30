export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max'

export type CodexCoreMessageRole = 'system' | 'developer' | 'user' | 'assistant'

export type CodexCoreMessage = {
  role: CodexCoreMessageRole
  content: string
}

export type CodexCoreConversationState = {
  conversationId: string
}

export type CodexCoreUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}

export type CodexCoreCacheMetadata = {
  hit?: boolean
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  raw?: unknown
}

export type RunCodexLLMInput = {
  accountProfile: string
  model: string
  reasoningEffort?: CodexReasoningEffort
  input?: string
  messages?: CodexCoreMessage[]
  systemPrompt?: string
  conversationId?: string
  stream?: boolean
}

export type CodexLLMUsage = CodexCoreUsage

export type CodexLLMMetadata = {
  accountId: string
  accountProfile: string
  model: string
  stopReason?: string | null
  requestId?: string
}

export type CodexLLMResult = {
  text: string
  assistantMessage: { role: 'assistant'; content: string }
  messagesForNextTurn: CodexCoreMessage[]
  conversationId: string
  continuationState: CodexCoreConversationState
  usage?: CodexCoreUsage
  cache?: CodexCoreCacheMetadata
  metadata: CodexLLMMetadata
  rawResponse: unknown
  rawEvents: Array<Record<string, unknown>>
}
