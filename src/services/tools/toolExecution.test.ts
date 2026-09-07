import { afterEach, describe, expect, mock, test } from 'bun:test'
import z from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import type { MessageUpdateLazy } from './toolExecution.js'
import { classifyToolError } from './toolExecution.js'
import { FilePatchError } from '../../tools/FilePatchTool/types.js'

// Only runPreToolUseHooks is stubbed, and only while this file's tests run:
// mock.module is installed during the import phase of every file in the
// invocation and never restored, so an always-live stub would rewrite hook
// behaviour for unrelated suites. The real implementation is captured before
// the mock is installed, because mock.module rewrites the live namespace
// object and reading it back afterwards yields the stub.
let stubsActive = false
let injectedContext: string[] | null = null
let postToolUseHooksThrow = false

const actualToolHooks = await import('./toolHooks.js')
const realRunPreToolUseHooks = actualToolHooks.runPreToolUseHooks
const realRunPostToolUseHooks = actualToolHooks.runPostToolUseHooks
mock.module('./toolHooks.js', () => ({
  ...actualToolHooks,
  runPreToolUseHooks: async function* (
    ...args: Parameters<typeof realRunPreToolUseHooks>
  ) {
    if (!stubsActive || injectedContext === null) {
      yield* realRunPreToolUseHooks(...args)
      return
    }
    const [, tool, , toolUseID] = args
    yield {
      type: 'additionalContext' as const,
      message: {
        message: createAttachmentMessage({
          type: 'hook_additional_context',
          content: injectedContext,
          hookName: `PreToolUse:${tool.name}`,
          toolUseID,
          hookEvent: 'PreToolUse',
        }),
      },
    }
  },
  runPostToolUseHooks: async function* (
    ...args: Parameters<typeof realRunPostToolUseHooks>
  ) {
    if (!stubsActive || !postToolUseHooksThrow) {
      yield* realRunPostToolUseHooks(...args)
      return
    }
    throw new Error('PostToolUse hook exploded')
  },
}))

const { runToolUse } = await import('./toolExecution.js')

const HOOK_TEXT = 'deploy runbook step 3 is mandatory'

function createAssistantMessage(): AssistantMessage {
  return {
    type: 'assistant',
    uuid: 'assistant-uuid',
    timestamp: '2026-09-01T00:00:00.000Z',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'gpt-5.6-terra',
      role: 'assistant',
      content: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'tool_use',
      stop_sequence: null,
    },
  } as unknown as AssistantMessage
}

function createToolUseContext(
  tools: unknown[],
  abortController = new AbortController(),
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'bypassPermissions',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
    tasks: {},
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.6-terra',
      tools,
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
    },
    abortController,
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (s: typeof appState) => typeof appState) => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [] as Message[],
  } as unknown as ToolUseContext
}

function makeTool(name: string, call: () => Promise<{ data: unknown }>) {
  return buildTool({
    name,
    inputSchema: z.strictObject({ value: z.string() }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async description() {
      return name
    },
    async prompt() {
      return name
    },
    async validateInput() {
      return { result: true as const }
    },
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    maxResultSizeChars: 10_000,
    mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: 'ok',
      }
    },
    call,
  })
}

async function drain(
  tool: ReturnType<typeof makeTool>,
  abortController?: AbortController,
): Promise<MessageUpdateLazy[]> {
  const context = createToolUseContext([tool], abortController)
  const updates: MessageUpdateLazy[] = []
  for await (const update of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: tool.name,
      input: { value: 'x' },
      caller: { type: 'direct' },
    },
    createAssistantMessage(),
    async () => ({ behavior: 'allow' as const, updatedInput: { value: 'x' } }),
    context,
  )) {
    updates.push(update)
  }
  return updates
}

function additionalContextAttachment(
  update: MessageUpdateLazy,
): { type?: string; content?: string[] } | null {
  const message = update.message as AttachmentMessage
  if (message?.type !== 'attachment') return null
  const attachment = message.attachment as { type?: string; content?: string[] }
  return attachment?.type === 'hook_additional_context' ? attachment : null
}

function additionalContextTexts(updates: MessageUpdateLazy[]): string[] {
  return updates.flatMap(u => additionalContextAttachment(u)?.content ?? [])
}

function additionalContextIndex(updates: MessageUpdateLazy[]): number {
  return updates.findIndex(u => additionalContextAttachment(u) !== null)
}

function toolResultIndices(updates: MessageUpdateLazy[]): number[] {
  const indices: number[] = []
  updates.forEach((u, i) => {
    const content = (u.message as { message?: { content?: unknown } })?.message
      ?.content
    if (
      Array.isArray(content) &&
      content.some(b => (b as { type?: string })?.type === 'tool_result')
    ) {
      indices.push(i)
    }
  })
  return indices
}

afterEach(() => {
  stubsActive = false
  injectedContext = null
  postToolUseHooksThrow = false
})

describe('runToolUse PreToolUse additionalContext', () => {
  test('survives a tool call that throws, exactly once, before the error result', async () => {
    stubsActive = true
    injectedContext = [HOOK_TEXT]

    const updates = await drain(
      makeTool('ThrowingTool', async () => {
        throw new Error('command failed with exit code 1')
      }),
    )

    expect(additionalContextTexts(updates)).toEqual([HOOK_TEXT])

    const errorIndices = toolResultIndices(updates)
    expect(errorIndices).toHaveLength(1)
    // The injected context must precede the tool_result, matching the order
    // the success path produces.
    const contextIndex = additionalContextIndex(updates)
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(contextIndex).toBeLessThan(errorIndices[0]!)

    const errorContent = (
      updates[errorIndices[0]!]!.message as {
        message: { content: { content?: string; is_error?: boolean }[] }
      }
    ).message.content[0]!
    expect(errorContent.is_error).toBe(true)
    expect(errorContent.content).toContain('command failed with exit code 1')
  })

  test('survives an aborted tool call', async () => {
    stubsActive = true
    injectedContext = [HOOK_TEXT]

    const abortController = new AbortController()
    const updates = await drain(
      makeTool('AbortingTool', async () => {
        const { AbortError } = await import('../../utils/errors.js')
        throw new AbortError()
      }),
      abortController,
    )

    expect(additionalContextTexts(updates)).toEqual([HOOK_TEXT])
    expect(toolResultIndices(updates)).toHaveLength(1)
  })

  test('a throw AFTER the tool result was recorded still yields one tool_result', async () => {
    // The error path builds its own tool_result. Carrying the whole
    // accumulator forward (rather than only the pre-call prefix) would emit a
    // second tool_result for the same tool_use_id, which the API rejects.
    stubsActive = true
    injectedContext = [HOOK_TEXT]
    postToolUseHooksThrow = true

    const updates = await drain(
      makeTool('LateThrowTool', async () => ({ data: 'ok' })),
    )

    expect(additionalContextTexts(updates)).toEqual([HOOK_TEXT])
    expect(toolResultIndices(updates)).toHaveLength(1)
  })

  test('success path emits the context once and keeps it before the result', async () => {
    stubsActive = true
    injectedContext = [HOOK_TEXT]

    const updates = await drain(
      makeTool('SucceedingTool', async () => ({ data: 'ok' })),
    )

    expect(additionalContextTexts(updates)).toEqual([HOOK_TEXT])
    const resultIndices = toolResultIndices(updates)
    expect(resultIndices).toHaveLength(1)
    const contextIndex = additionalContextIndex(updates)
    expect(contextIndex).toBeLessThan(resultIndices[0]!)
  })

  test('persists structured Apply_patch failures without leaking telemetry text', async () => {
    const path = '/private/code/secret.ts'
    const error = new FilePatchError(
      `Patch hunk placement is ambiguous in ${path}: there are multiple eligible placements.`,
      {
        code: 'PATCH_ANCHOR_AMBIGUOUS',
        operation: 'update',
        path,
        hunkIndex: 2,
        hunkCount: 3,
        details: [
          {
            code: 'PATCH_ANCHOR_AMBIGUOUS',
            operation: 'update',
            path,
            hunkIndex: 2,
            hunkCount: 3,
            message: 'There are multiple eligible placements.',
          },
        ],
      },
    )
    const updates = await drain(
      makeTool('Apply_patch', async () => {
        throw error
      }),
    )
    const resultUpdate = updates.find(update => toolResultIndices([update]).length > 0)!
    const message = resultUpdate.message as {
      message: {
        content: { content?: string; is_error?: boolean }[]
      }
      toolUseResult?: unknown
    }
    const resultBlock = message.message.content[0]!
    expect(resultBlock.is_error).toBe(true)
    expect(resultBlock.content).toContain('PATCH_ANCHOR_AMBIGUOUS')
    expect(resultBlock.content).toContain('file_patch_error')
    expect(message.toolUseResult).toMatchObject({
      type: 'file_patch_error',
      code: 'PATCH_ANCHOR_AMBIGUOUS',
      operation: 'update',
      path,
      hunkIndex: 2,
      hunkCount: 3,
      mutationOutcome: 'no-mutation',
    })
    expect(classifyToolError(error)).toBe(
      'FilePatchError:PATCH_ANCHOR_AMBIGUOUS',
    )
    expect(classifyToolError(error)).not.toContain(path)
  })
})
