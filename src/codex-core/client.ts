import { randomUUID } from 'crypto'

import { createCodexFetch, mapClaudeModelToCodex } from '../services/api/codex-fetch-adapter.js'
import { runWithCodexLeaseOwner } from '../services/api/codexAccountLeaseManager.js'
import { resolveCodexCoreAccount } from './accounts.js'
import { CodexCoreError, normalizeCodexCoreError } from './errors.js'
import { buildCodexCoreRequest, normalizeCodexCoreMessages } from './request.js'
import { parseCodexCoreResponse } from './response.js'
import type { CodexLLMResult, RunCodexLLMInput } from './types.js'

export async function runCodexLLM(options: RunCodexLLMInput): Promise<CodexLLMResult> {
  try {
    validateOptions(options)

    const account = await resolveCodexCoreAccount(options.accountProfile)
    const model = mapClaudeModelToCodex(options.model)
    const conversationId = options.conversationId?.trim() || randomUUID()
    const codexFetch = createCodexFetch(account.accessToken, conversationId)
    const request = buildCodexCoreRequest(options, model, conversationId)

    const response = await runWithCodexLeaseOwner(undefined, () =>
      codexFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.requestBody),
      }),
    )

    const parsed = await parseCodexCoreResponse(response)
    const assistantMessage = { role: 'assistant' as const, content: parsed.text }

    return {
      text: parsed.text,
      assistantMessage,
      messagesForNextTurn: [...request.messagesForNextTurn, assistantMessage],
      conversationId,
      continuationState: { conversationId },
      usage: parsed.usage,
      cache: parsed.cache,
      metadata: {
        accountId: account.accountId,
        accountProfile: account.profile,
        model,
        stopReason: parsed.stopReason,
      },
      rawResponse: parsed.rawResponse,
      rawEvents: parsed.rawEvents,
    }
  } catch (error) {
    throw normalizeCodexCoreError(error)
  }
}

function validateOptions(options: RunCodexLLMInput): void {
  if (options.stream === true) {
    throw new CodexCoreError('invalid_request', 'runCodexLLM currently supports stream: false only')
  }
  if (!options.accountProfile?.trim()) {
    throw new CodexCoreError('invalid_request', 'accountProfile is required')
  }
  if (!options.model?.trim()) {
    throw new CodexCoreError('invalid_request', 'model is required')
  }
  if (options.conversationId !== undefined && !options.conversationId.trim()) {
    throw new CodexCoreError('invalid_request', 'conversationId must not be empty')
  }
  normalizeCodexCoreMessages(options)
}
