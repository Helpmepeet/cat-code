import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ASK_ORCHESTRATOR_TOOL_NAME, DESCRIPTION } from './prompt.js'

const AskOrchestratorKindSchema = z.enum(['question', 'context', 'blocked'])

const inputSchema = lazySchema(() =>
  z.strictObject({
    kind: AskOrchestratorKindSchema.describe(
      'question = ask for clarification, context = request missing context, blocked = report that you cannot continue safely',
    ),
    message: z
      .string()
      .describe('The clarifying question, missing context request, or blocked summary'),
    evidence: z
      .array(z.string())
      .optional()
      .describe('Concrete evidence, failed attempts, or file references that justify the request'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    kind: AskOrchestratorKindSchema,
    message: z.string(),
    evidence: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type AskOrchestratorToolResult = z.infer<OutputSchema>

export function parseAskOrchestratorToolResult(
  value: unknown,
): AskOrchestratorToolResult | null {
  if (typeof value === 'string') {
    try {
      return outputSchema().parse(JSON.parse(value))
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    const text = value
      .filter(
        (item): item is { type: 'text'; text: string } =>
          Boolean(item) &&
          typeof item === 'object' &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string',
      )
      .map(item => item.text)
      .join('')

    return text ? parseAskOrchestratorToolResult(text) : null
  }

  try {
    return outputSchema().parse(value)
  } catch {
    return null
  }
}

export const AskOrchestratorTool = buildTool({
  name: ASK_ORCHESTRATOR_TOOL_NAME,
  maxResultSizeChars: 8_192,
  userFacingName() {
    return 'ask_orchestrator'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.kind}: ${input.message}`
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call({ kind, message, evidence }) {
    return {
      data: {
        kind,
        message,
        evidence: evidence ?? [],
      },
    }
  },
} satisfies ToolDef<InputSchema, AskOrchestratorToolResult>)
