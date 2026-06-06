import React from 'react'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import {
  formatContextSizeHint,
  resolveAgentTarget,
} from '../AgentTool/resolveAgentTarget.js'
import {
  AgentResumeInProgressError,
  resumeAgentBackground,
  TranscriptNotFoundError,
} from '../AgentTool/resumeAgent.js'
import { RESUME_AGENT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    agentId: z
      .string()
      .describe(
        'Which stopped subagent to restart, identified by its friendly name/alias, Agent Mode worker handle, or raw agent ID. Only local subagents/workers are accepted — not teammate names, "*", or uds:/bridge: targets. Use SendMessage instead if the target is still running.',
      ),
    prompt: z.string().describe('New prompt to send to the resumed subagent'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const ResumeAgentTool = buildTool({
  name: RESUME_AGENT_TOOL_NAME,
  searchHint: 'resume stopped subagents and workers',
  maxResultSizeChars: 100_000,
  alwaysLoad: true,

  userFacingName() {
    return RESUME_AGENT_TOOL_NAME
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return getPrompt()
  },

  toAutoClassifierInput(input) {
    return `resume ${input.agentId}: ${input.prompt}`
  },

  async validateInput(input) {
    if (input.agentId.trim().length === 0) {
      return {
        result: false,
        message: 'agentId must not be empty',
        errorCode: 1,
      }
    }
    if (input.prompt.trim().length === 0) {
      return {
        result: false,
        message: 'prompt must not be empty',
        errorCode: 1,
      }
    }
    return { result: true }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },

  renderToolUseMessage(input) {
    return input.agentId ? `resume ${input.agentId}` : null
  },

  renderToolResultMessage(content) {
    const result: Output =
      typeof content === 'string' ? jsonParse(content) : content
    return (
      <MessageResponse>
        <Text color={result.success ? 'success' : 'error'}>{result.message}</Text>
      </MessageResponse>
    )
  },

  async call(input, context, canUseTool, assistantMessage) {
    const appState = context.getAppState()
    const resolved = await resolveAgentTarget({
      input: input.agentId,
      appState,
      sessionId: getSessionId(),
    })

    if (!resolved) {
      return {
        data: {
          success: false,
          message: `No subagent found for "${input.agentId}". Check the agentId or call Agent to spawn a new one.`,
        },
      }
    }

    const task = appState.tasks[resolved.agentId]
    if (isLocalAgentTask(task) && task.status === 'running') {
      return {
        data: {
          success: false,
          message: `Agent "${resolved.displayName}" is already running; resume is not needed. Any message you send via SendMessage will queue automatically and deliver at the next tool round.`,
        },
      }
    }

    try {
      const result = await resumeAgentBackground({
        agentId: resolved.agentId,
        prompt: input.prompt,
        sourceSessionId: resolved.sourceSessionId,
        toolUseContext: context,
        canUseTool,
        invokingRequestId: assistantMessage?.requestId,
      })
      return {
        data: {
          success: true,
          message: `Resumed "${result.description}" in the background.${formatContextSizeHint(resolved.contextTokens)}`,
        },
      }
    } catch (e) {
      if (e instanceof TranscriptNotFoundError) {
        return {
          data: {
            success: false,
            message: `Agent "${resolved.displayName}" has no transcript to resume; it may have been cleaned up. Spawn a new agent with Agent.`,
          },
        }
      }
      if (e instanceof AgentResumeInProgressError) {
        return {
          data: {
            success: false,
            message: `Agent "${resolved.displayName}" is already running; resume is not needed. Any message you send via SendMessage will queue automatically and deliver at the next tool round.`,
          },
        }
      }
      return {
        data: {
          success: false,
          message: `Failed to resume "${resolved.displayName}": ${errorMessage(e)}`,
        },
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
