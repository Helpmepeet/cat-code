import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ASK_PARENT_SESSION_TOOL_NAME, DESCRIPTION } from './prompt.js'

const AskParentSessionKindSchema = z.enum(['question', 'context', 'blocked'])

const inputSchema = lazySchema(() =>
  z.strictObject({
    kind: AskParentSessionKindSchema.describe(
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
    kind: AskParentSessionKindSchema,
    message: z.string(),
    evidence: z.array(z.string()),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type AskParentSessionToolResult = z.infer<OutputSchema>

/**
 * The confirmation the worker's transcript records for the call. It is not an
 * answer and cannot be one: runAgent ends the run as soon as this tool
 * reports, so nothing in this session ever reads it. Returning the request
 * itself here (which is what this tool used to do) is what taught a worker to
 * treat the call as request/response and go hunting for a channel to its
 * spawner when the reply never came.
 */
export const ASK_PARENT_SESSION_ACK =
  'Handed to the parent session. This run ends here and is reported as blocked; any reply arrives as a new or resumed run.'

/**
 * Reads the escalation out of an `ask_parent_session` tool_use input. A worker's
 * input has already passed `inputSchema` by the time the call produces a
 * result, so this parse is a narrowing of an `unknown` block payload rather
 * than a second validation, and it applies the same `evidence` default the
 * call does.
 */
export function parseAskParentSessionEscalation(
  value: unknown,
): AskParentSessionToolResult | null {
  const parsed = inputSchema().safeParse(value)
  if (!parsed.success) return null
  const { kind, message, evidence } = parsed.data
  return { kind, message, evidence: evidence ?? [] }
}

/**
 * The run's final text when a worker escalates. It has to satisfy
 * `extractHandoffStatus` and `extractBlockReason` in LocalAgentTask, which
 * read handoff status and the block reason out of the result text, and it
 * follows the same handoff skeleton the role prompts ask workers to write by
 * hand (`getCodingWorkerSystemPrompt` in the worker prompt), so a
 * harness-written blocked handoff and a model-written one parse identically.
 */
export function formatBlockedHandoff(
  escalation: AskParentSessionToolResult,
): string {
  const sections = [
    `Stopped and handed back to the parent session (${escalation.kind}).`,
    'status: blocked',
    `Open questions / blockers:\n- ${escalation.message}`,
  ]
  if (escalation.evidence.length > 0) {
    sections.push(
      `Evidence:\n${escalation.evidence.map(item => `- ${item}`).join('\n')}`,
    )
  }
  return sections.join('\n\n')
}

/**
 * Escalation is terminal. The tool records the question; runAgent watches for
 * its result, ends the worker's loop, and returns `formatBlockedHandoff` as
 * the run's result, so stopping is no longer something the worker has to
 * volunteer to do.
 */
export const AskParentSessionTool = buildTool({
  name: ASK_PARENT_SESSION_TOOL_NAME,
  maxResultSizeChars: 8_192,
  userFacingName() {
    return 'ask_parent_session'
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
  mapToolResultToToolResultBlockParam(_output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: ASK_PARENT_SESSION_ACK,
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
} satisfies ToolDef<InputSchema, AskParentSessionToolResult>)
