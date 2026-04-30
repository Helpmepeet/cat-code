import { z } from 'zod/v4'
import {
  FORK_WORKER_REQUEST_TAG,
  FORK_WORKER_RESULT_TAG,
  TEAMMATE_MESSAGE_TAG,
} from '../constants/xml.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

export const ORCHESTRATION_CONTRACT_VERSION = 1 as const

const OrchestrationContractVersionSchema = z.literal(
  ORCHESTRATION_CONTRACT_VERSION,
)

export const ForkWorkerExpectedOutputSchema = z.object({
  include_key_files: z.boolean(),
  include_files_changed: z.boolean(),
  include_issues: z.boolean(),
})

export type ForkWorkerExpectedOutput = z.infer<
  typeof ForkWorkerExpectedOutputSchema
>

export const ForkWorkerRequestSchema = z.object({
  version: OrchestrationContractVersionSchema,
  kind: z.literal('fork_worker_request'),
  scope: z.string(),
  directive: z.string(),
  constraints: z.array(z.string()),
  expected_output: ForkWorkerExpectedOutputSchema,
})

export type ForkWorkerRequest = z.infer<typeof ForkWorkerRequestSchema>

export const ForkWorkerResultSchema = z.object({
  version: OrchestrationContractVersionSchema,
  kind: z.literal('fork_worker_result'),
  scope: z.string(),
  result: z.string(),
  key_files: z.array(z.string()),
  files_changed: z.array(z.string()),
  issues: z.array(z.string()),
  commit_hash: z.string().nullable(),
})

export type ForkWorkerResult = z.infer<typeof ForkWorkerResultSchema>

const StructuredTeammateMessageBaseSchema = z.object({
  version: OrchestrationContractVersionSchema,
  from: z.string(),
  summary: z.string().optional(),
  color: z.string().optional(),
})

export const StructuredTeammateChatMessageSchema =
  StructuredTeammateMessageBaseSchema.extend({
    kind: z.literal('chat'),
    text: z.string(),
  })

export type StructuredTeammateChatMessage = z.infer<
  typeof StructuredTeammateChatMessageSchema
>

export const StructuredTeammateHandoffRequestMessageSchema =
  StructuredTeammateMessageBaseSchema.extend({
    kind: z.literal('handoff_request'),
    payload: ForkWorkerRequestSchema,
  })

export type StructuredTeammateHandoffRequestMessage = z.infer<
  typeof StructuredTeammateHandoffRequestMessageSchema
>

export const StructuredTeammateHandoffResultMessageSchema =
  StructuredTeammateMessageBaseSchema.extend({
    kind: z.literal('handoff_result'),
    payload: ForkWorkerResultSchema,
  })

export type StructuredTeammateHandoffResultMessage = z.infer<
  typeof StructuredTeammateHandoffResultMessageSchema
>

export const StructuredTeammateMessageSchema = z.discriminatedUnion('kind', [
  StructuredTeammateChatMessageSchema,
  StructuredTeammateHandoffRequestMessageSchema,
  StructuredTeammateHandoffResultMessageSchema,
])

export type StructuredTeammateMessage = z.infer<
  typeof StructuredTeammateMessageSchema
>

export const GeneratedAgentConfigSchema = z.object({
  identifier: z.string(),
  whenToUse: z.string(),
  systemPrompt: z.string(),
})

export type GeneratedAgentConfig = z.infer<typeof GeneratedAgentConfigSchema>

export const SessionSearchResultSchema = z.object({
  relevant_indices: z.array(z.number().int()),
})

export type SessionSearchResult = z.infer<typeof SessionSearchResultSchema>

export function parseForkWorkerResult(value: unknown): ForkWorkerResult {
  return ForkWorkerResultSchema.parse(value)
}

export function validateForkWorkerResult(value: unknown) {
  return ForkWorkerResultSchema.safeParse(value)
}

export function getForkWorkerResultJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ForkWorkerResultSchema)
}

export function parseGeneratedAgentConfig(value: unknown): GeneratedAgentConfig {
  return GeneratedAgentConfigSchema.parse(value)
}

export function validateGeneratedAgentConfig(value: unknown) {
  return GeneratedAgentConfigSchema.safeParse(value)
}

export function parseSessionSearchResult(value: unknown): SessionSearchResult {
  return SessionSearchResultSchema.parse(value)
}

export function validateSessionSearchResult(value: unknown) {
  return SessionSearchResultSchema.safeParse(value)
}

export function getGeneratedAgentConfigJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(GeneratedAgentConfigSchema)
}

export function getSessionSearchResultJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(SessionSearchResultSchema)
}

export type StructuredTeammateSerializationProvider = 'claude' | 'openai'

const TEAMMATE_MESSAGE_REGEX = new RegExp(
  `<${TEAMMATE_MESSAGE_TAG}\\s+teammate_id="([^"]+)"(?:\\s+color="([^"]+)")?(?:\\s+summary="([^"]+)")?>\\n?([\\s\\S]*?)\\n?<\\/${TEAMMATE_MESSAGE_TAG}>`,
  'g',
)

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function unescapeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
}

function stringifyContract(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseTaggedJsonPayload(text: string, tag: string): unknown {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`))
  if (!match?.[1]) {
    throw new Error(`Missing <${tag}> payload`)
  }
  return JSON.parse(unescapeXmlText(match[1]))
}

export function parseForkWorkerRequest(value: unknown): ForkWorkerRequest {
  return ForkWorkerRequestSchema.parse(value)
}

export function parseForkWorkerRequestFromTaggedText(text: string): ForkWorkerRequest {
  return parseForkWorkerRequest(parseTaggedJsonPayload(text, FORK_WORKER_REQUEST_TAG))
}

export function serializeForkWorkerRequestForClaude(
  request: ForkWorkerRequest,
): string {
  return `<${FORK_WORKER_REQUEST_TAG}>\n${escapeXmlText(stringifyContract(request))}\n</${FORK_WORKER_REQUEST_TAG}>`
}

export function serializeForkWorkerRequestForOpenAI(
  request: ForkWorkerRequest,
): string {
  return stringifyContract(request)
}

export function parseForkWorkerResultFromTaggedText(text: string): ForkWorkerResult {
  return parseForkWorkerResult(parseTaggedJsonPayload(text, FORK_WORKER_RESULT_TAG))
}

export function serializeForkWorkerResultForClaude(
  result: ForkWorkerResult,
): string {
  return `<${FORK_WORKER_RESULT_TAG}>\n${escapeXmlText(stringifyContract(result))}\n</${FORK_WORKER_RESULT_TAG}>`
}

export function serializeForkWorkerResultForOpenAI(
  result: ForkWorkerResult,
): string {
  return stringifyContract(result)
}

function getStructuredTeammateMessageBody(
  message: StructuredTeammateMessage,
): string {
  return message.kind === 'chat' ? message.text : stringifyContract(message)
}

function serializeStructuredTeammateMessageForClaude(
  message: StructuredTeammateMessage,
): string {
  const colorAttr = message.color
    ? ` color="${escapeXmlAttribute(message.color)}"`
    : ''
  const summaryAttr = message.summary
    ? ` summary="${escapeXmlAttribute(message.summary)}"`
    : ''

  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${escapeXmlAttribute(message.from)}"${colorAttr}${summaryAttr}>\n${escapeXmlText(getStructuredTeammateMessageBody(message))}\n</${TEAMMATE_MESSAGE_TAG}>`
}

function serializeStructuredTeammateMessageForOpenAI(
  message: StructuredTeammateMessage,
): string {
  return stringifyContract(message)
}

export function serializeStructuredTeammateMessage(
  message: StructuredTeammateMessage,
  provider: StructuredTeammateSerializationProvider = 'claude',
): string {
  return provider === 'openai'
    ? serializeStructuredTeammateMessageForOpenAI(message)
    : serializeStructuredTeammateMessageForClaude(message)
}

export function serializeStructuredTeammateMessages(
  messages: StructuredTeammateMessage[],
  provider: StructuredTeammateSerializationProvider = 'claude',
): string {
  if (provider === 'openai') {
    return messages.length === 1
      ? serializeStructuredTeammateMessage(messages[0]!, provider)
      : stringifyContract(messages)
  }

  return messages
    .map(message => serializeStructuredTeammateMessage(message, provider))
    .join('\n\n')
}

export function parseStructuredTeammateMessages(
  text: string,
): StructuredTeammateMessage[] {
  const messages: StructuredTeammateMessage[] = []

  for (const match of text.matchAll(TEAMMATE_MESSAGE_REGEX)) {
    const from = match[1]
    const color = match[2]
    const summary = match[3]
    const body = match[4]
    if (!from || !body) continue

    const unescapedBody = unescapeXmlText(body).trim()
    const parsed = safeParseStructuredTeammateMessage(unescapedBody, {
      from,
      color,
      summary,
    })
    if (parsed) {
      messages.push(parsed)
    }
  }

  if (messages.length > 0) {
    return messages
  }

  return safeParseStandaloneStructuredTeammateMessages(text)
}

function safeParseStandaloneStructuredTeammateMessages(
  text: string,
): StructuredTeammateMessage[] {
  try {
    const parsed = JSON.parse(text.trim())
    if (Array.isArray(parsed)) {
      return parsed.map(item => StructuredTeammateMessageSchema.parse(item))
    }
    return [StructuredTeammateMessageSchema.parse(parsed)]
  } catch {
    return []
  }
}

function safeParseStructuredTeammateMessage(
  body: string,
  fallback: { from: string; color?: string; summary?: string },
): StructuredTeammateMessage | null {
  const structuredMessages = safeParseStandaloneStructuredTeammateMessages(body)
  if (structuredMessages.length > 0) {
    return structuredMessages[0] ?? null
  }

  if (!body) return null
  return StructuredTeammateChatMessageSchema.parse({
    version: ORCHESTRATION_CONTRACT_VERSION,
    kind: 'chat',
    from: fallback.from,
    text: body,
    color: fallback.color,
    summary: fallback.summary,
  })
}
