import type { MessageOrigin } from '../types/message.js'
import {
  ForkWorkerRequestSchema,
  ForkWorkerResultSchema,
  ORCHESTRATION_CONTRACT_VERSION,
  parseStructuredTeammateMessages,
  serializeForkWorkerRequestForOpenAI,
  serializeForkWorkerResultForOpenAI,
  serializeStructuredTeammateMessage,
  serializeStructuredTeammateMessages,
  type StructuredTeammateHandoffRequestMessage,
  type StructuredTeammateHandoffResultMessage,
  type StructuredTeammateMessage,
  type StructuredTeammateSerializationProvider,
} from '../contracts/orchestration.js'
import { safeParseJSON } from './json.js'
import { getAPIProvider, type APIProvider } from './model/providers.js'

export type TeammateStructuredPayload =
  | StructuredTeammateHandoffRequestMessage
  | StructuredTeammateHandoffResultMessage

export type TeammateMessageContract = {
  kind: 'teammate'
  from: string
  text: string
  color?: string
  summary?: string
  structured?: TeammateStructuredPayload
}

export type TeammateMessageOrigin = Extract<
  MessageOrigin,
  { kind: 'teammate' }
>

function toStructuredTeammateMessage(
  message: TeammateMessageContract,
): StructuredTeammateMessage {
  if (message.structured) {
    return {
      ...message.structured,
      from: message.from,
      color: message.color ?? message.structured.color,
      summary: message.summary ?? message.structured.summary,
    }
  }

  const parsed = safeParseJSON(message.text.trim())
  const handoffRequest = ForkWorkerRequestSchema.safeParse(parsed)
  if (handoffRequest.success) {
    return {
      version: ORCHESTRATION_CONTRACT_VERSION,
      kind: 'handoff_request',
      from: message.from,
      payload: handoffRequest.data,
      color: message.color,
      summary: message.summary,
    }
  }

  const handoffResult = ForkWorkerResultSchema.safeParse(parsed)
  if (handoffResult.success) {
    return {
      version: ORCHESTRATION_CONTRACT_VERSION,
      kind: 'handoff_result',
      from: message.from,
      payload: handoffResult.data,
      color: message.color,
      summary: message.summary,
    }
  }

  return {
    version: ORCHESTRATION_CONTRACT_VERSION,
    kind: 'chat',
    from: message.from,
    text: message.text,
    color: message.color,
    summary: message.summary,
  }
}

function fromStructuredTeammateMessage(
  message: StructuredTeammateMessage,
): TeammateMessageContract {
  return {
    kind: 'teammate',
    from: message.from,
    text:
      message.kind === 'chat'
        ? message.text
        : message.kind === 'handoff_request'
          ? serializeForkWorkerRequestForOpenAI(message.payload)
          : serializeForkWorkerResultForOpenAI(message.payload),
    color: message.color,
    summary: message.summary,
    structured:
      message.kind === 'chat'
        ? undefined
        : message.kind === 'handoff_request'
          ? message
          : message,
  }
}

export function serializeTeammateMessage(
  message: TeammateMessageContract,
  provider: StructuredTeammateSerializationProvider = 'claude',
): string {
  return serializeStructuredTeammateMessage(
    toStructuredTeammateMessage(message),
    provider,
  )
}

export function formatTeammateMessages(
  messages: TeammateMessageContract[],
  provider: StructuredTeammateSerializationProvider = 'claude',
): string {
  return serializeStructuredTeammateMessages(
    messages.map(toStructuredTeammateMessage),
    provider,
  )
}

export function formatTeammateMessagesForModel(
  messages: TeammateMessageContract[],
  provider: APIProvider = getAPIProvider(),
): string {
  return formatTeammateMessages(
    messages,
    provider === 'openai' ? 'openai' : 'claude',
  )
}

export function parseTeammateMessages(
  text: string,
): TeammateMessageContract[] {
  return parseStructuredTeammateMessages(text).map(fromStructuredTeammateMessage)
}

export function toTeammateMessageContract(message: {
  from: string
  text: string
  color?: string
  summary?: string
  structured?: TeammateStructuredPayload
}): TeammateMessageContract {
  const contract: TeammateMessageContract = {
    kind: 'teammate',
    from: message.from,
    text: message.text,
    color: message.color,
    summary: message.summary,
    structured: message.structured,
  }

  if (contract.structured) {
    return contract
  }

  return {
    ...contract,
    structured: (() => {
      const parsed = safeParseJSON(message.text.trim())
      const handoffRequest = ForkWorkerRequestSchema.safeParse(parsed)
      if (handoffRequest.success) {
        return {
          version: ORCHESTRATION_CONTRACT_VERSION,
          kind: 'handoff_request',
          from: message.from,
          payload: handoffRequest.data,
          color: message.color,
          summary: message.summary,
        }
      }

      const handoffResult = ForkWorkerResultSchema.safeParse(parsed)
      if (handoffResult.success) {
        return {
          version: ORCHESTRATION_CONTRACT_VERSION,
          kind: 'handoff_result',
          from: message.from,
          payload: handoffResult.data,
          color: message.color,
          summary: message.summary,
        }
      }

      return undefined
    })(),
  }
}

export function isTeammateOrigin(origin: unknown): origin is TeammateMessageOrigin {
  return (
    !!origin &&
    typeof origin === 'object' &&
    'kind' in origin &&
    (origin as { kind?: unknown }).kind === 'teammate' &&
    'messages' in origin &&
    Array.isArray((origin as { messages?: unknown }).messages)
  )
}
