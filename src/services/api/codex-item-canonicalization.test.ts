/**
 * Record→replay round-trip tests for canonicalizeCodexItem.
 *
 * Item 1 of the context-cost fixes (docs/codex/2026-07-06-context-cost-fixes-plan.md):
 * the WS transport only sends an incremental delta when the item shape RECORDED
 * from the server's response.output_item.done (via normalizeCompletedOutputItem
 * → canonicalizeCodexItem) byte-matches the shape REPLAYED on the next turn (via
 * translateMessages inside translateToCodexBody).
 *
 * These tests assert that agreement for each output-item kind, deliberately
 * feeding inputs that used to drift:
 *   - message: server output_text parts carry a `logprobs` field (the -14 drift)
 *   - function_call with Bash cd-strip and Grep openai key-rename normalization
 *   - Apply_patch recorded as custom_tool_call (the type_mismatch drift)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { canonicalizeCodexItem, translateToCodexBody } from './codex-fetch-adapter.js'
import {
  getSessionProvider,
  setSessionProvider,
} from '../../bootstrap/state.js'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { normalizeToolInput } from '../../utils/api.js'
import { getAllBaseTools } from '../../tools.js'
import { findToolByName } from '../../Tool.js'

/**
 * Compute the transcript form of a tool input the way the decode path does
 * (normalizeToolInput applied once, messages.ts:2733). Using the real function
 * keeps the round-trip honest: both record and replay run the same rename/cd
 * transforms, so any key-order/shape drift would surface here rather than being
 * papered over by a hand-picked fixture order.
 */
function transcriptForm(name: string, rawArgs: Record<string, unknown>): unknown {
  const tool = findToolByName(getAllBaseTools(), name)
  return tool ? normalizeToolInput(tool, rawArgs as never) : rawArgs
}

/** Build one Anthropic assistant message with a single tool_use block. */
function assistantToolUseMessage(
  callId: string,
  name: string,
  input: unknown,
) {
  return {
    type: 'assistant' as const,
    uuid: `asst_${callId}`,
    message: {
      id: `msg_${callId}`,
      type: 'message' as const,
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: callId, name, input }],
    },
  }
}

/**
 * Run a single assistant tool_use through the REAL replay path
 * (translateToCodexBody → translateMessages) and return the emitted output item.
 * The `input` passed here is the transcript form (post decode-time
 * normalizeToolInput), exactly as history holds it.
 */
function replayToolCallItem(
  callId: string,
  name: string,
  transcriptInput: unknown,
): Record<string, unknown> {
  const { codexBody } = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    tools: [],
    _openaiInstructionAssembly: {
      instructions: 'sys',
      inputMessages: [assistantToolUseMessage(callId, name, transcriptInput)],
    },
  })
  const input = (codexBody.input as Array<Record<string, unknown>>) ?? []
  const item = input.find(
    it => it.type === 'function_call' || it.type === 'custom_tool_call',
  )
  if (!item) throw new Error('no tool-call item emitted by replay path')
  return item
}

describe('canonicalizeCodexItem: message round-trip', () => {
  test('drops logprobs and any unknown fields on output_text parts', () => {
    const rawServerMessage = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: 'msg_srv_1',
      content: [
        {
          type: 'output_text',
          text: 'hello world',
          annotations: [],
          logprobs: [],
        },
      ],
    }

    const canonical = canonicalizeCodexItem(rawServerMessage)

    expect(canonical).toEqual({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello world', annotations: [] }],
    })
    // The exact -14 field must be gone.
    expect(JSON.stringify(canonical)).not.toContain('logprobs')
  })

  test('record shape byte-matches the translateMessages replay shape', () => {
    const rawServerMessage = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'answer', annotations: [], logprobs: [] },
      ],
    }
    const canonical = canonicalizeCodexItem(rawServerMessage)

    // Replay path for the same assistant text.
    const { codexBody } = translateToCodexBody({
      model: 'claude-sonnet-4-6',
      tools: [],
      _openaiInstructionAssembly: {
        instructions: 'sys',
        inputMessages: [
          {
            type: 'assistant',
            uuid: 'a1',
            message: {
              id: 'msg_a1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'answer' }],
            },
          },
        ],
      },
    })
    const replayed = (codexBody.input as Array<Record<string, unknown>>).find(
      it => it.type === 'message',
    )
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(replayed))
  })
})

describe('canonicalizeCodexItem: function_call tool-input normalization', () => {
  let prevProvider: ReturnType<typeof getSessionProvider>
  let prevCwd: string

  beforeEach(() => {
    prevProvider = getSessionProvider()
    prevCwd = getCwdState()
    setSessionProvider('openai')
  })
  afterEach(() => {
    setSessionProvider(prevProvider)
    setCwdState(prevCwd)
  })

  test('Bash cd-strip: record args match replay after the leading cd is removed', () => {
    setCwdState('/repo/project')
    const callId = 'call_bash_1'

    // Server sends the raw model arguments (command still prefixed with cd).
    const rawServerItem = {
      type: 'function_call',
      call_id: callId,
      name: 'Bash',
      arguments: JSON.stringify({
        command: 'cd /repo/project && ls -la',
        description: 'list',
      }),
    }
    const canonical = canonicalizeCodexItem(rawServerItem)

    // The canonical args must have the cd stripped (normalizeToolInput behaviour).
    const canonicalArgs = JSON.parse(canonical.arguments as string)
    expect(canonicalArgs.command).toBe('ls -la')

    // Replay: transcript holds the decode-time normalized (cd-stripped) form.
    const replayed = replayToolCallItem(
      callId,
      'Bash',
      transcriptForm('Bash', {
        command: 'cd /repo/project && ls -la',
        description: 'list',
      }),
    )
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(replayed))
  })

  test('Grep key-rename: record args match replay after openai keys map back', () => {
    const callId = 'call_grep_1'

    // The model emits the OpenAI-renamed schema keys (show_line_numbers, ...).
    const rawServerItem = {
      type: 'function_call',
      call_id: callId,
      name: 'Grep',
      arguments: JSON.stringify({
        pattern: 'needle',
        show_line_numbers: true,
        lines_after: 2,
      }),
    }
    const canonical = canonicalizeCodexItem(rawServerItem)
    const canonicalArgs = JSON.parse(canonical.arguments as string)

    // Renamed back to the first-party dash keys.
    expect(canonicalArgs).toHaveProperty('-n', true)
    expect(canonicalArgs).toHaveProperty('-A', 2)
    expect(canonicalArgs).not.toHaveProperty('show_line_numbers')

    // Replay: the transcript holds the decode-time renamed form.
    const replayed = replayToolCallItem(
      callId,
      'Grep',
      transcriptForm('Grep', {
        pattern: 'needle',
        show_line_numbers: true,
        lines_after: 2,
      }),
    )
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(replayed))
  })

  test('unknown/MCP tool: deterministic re-stringify, no drift', () => {
    const callId = 'call_mcp_1'
    const rawServerItem = {
      type: 'function_call',
      call_id: callId,
      name: 'mcp__weather__forecast',
      arguments: '{"city":"Paris"}',
    }
    const canonical = canonicalizeCodexItem(rawServerItem)
    expect(canonical.arguments).toBe('{"city":"Paris"}')
  })
})

describe('canonicalizeCodexItem: Apply_patch custom_tool_call round-trip', () => {
  test('server custom_tool_call replays as custom_tool_call from {input: raw} wrap', () => {
    const callId = 'call_patch_1'
    const rawEnvelope =
      '*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch'

    // Server records Apply_patch as custom_tool_call with the raw input string.
    const rawServerItem = {
      type: 'custom_tool_call',
      call_id: callId,
      name: 'Apply_patch',
      input: rawEnvelope,
    }
    const canonical = canonicalizeCodexItem(rawServerItem)

    // Replay: transcript stores the unparseable envelope as { input: raw }.
    const replayed = replayToolCallItem(callId, 'Apply_patch', {
      input: rawEnvelope,
    })

    expect(replayed.type).toBe('custom_tool_call')
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(replayed))
  })

  test('Apply_patch {ops} arm replays as custom_tool_call with serialized input', () => {
    const callId = 'call_patch_2'
    const ops = [{ type: 'delete', path: 'src/gone.ts' }]

    // Server saw the serialized JSON as the custom-tool input.
    const rawServerItem = {
      type: 'custom_tool_call',
      call_id: callId,
      name: 'Apply_patch',
      input: JSON.stringify({ ops }),
    }
    const canonical = canonicalizeCodexItem(rawServerItem)

    const replayed = replayToolCallItem(callId, 'Apply_patch', { ops })
    expect(replayed.type).toBe('custom_tool_call')
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(replayed))
  })
})
