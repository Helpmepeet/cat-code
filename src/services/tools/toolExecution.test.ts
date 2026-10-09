import { afterEach, describe, expect, mock, test } from 'bun:test'
import z from 'zod/v4'
import { buildTool, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import type { MessageUpdateLazy } from './toolExecution.js'
import {
  classifyReturnedToolExecution,
  classifyToolError,
} from './toolExecution.js'
import { runTools } from './toolOrchestration.js'
import { StreamingToolExecutor } from './StreamingToolExecutor.js'
import { ASK_PARENT_SESSION_TOOL_NAME } from '../../tools/AskParentSessionTool/prompt.js'
import { FilePatchError, serializeFilePatchError } from '../../tools/FilePatchTool/types.js'
import { asAgentId } from '../../types/ids.js'
import {
  consumeTrustedSedEditForExecution,
  registerTrustedSedEditApproval,
} from '../../tools/BashTool/sedEditCapability.js'
import { createPermissionContext } from '../../hooks/toolPermission/PermissionContext.js'

// Only runPreToolUseHooks is stubbed, and only while this file's tests run:
// mock.module is installed during the import phase of every file in the
// invocation and never restored, so an always-live stub would rewrite hook
// behaviour for unrelated suites. The real implementation is captured before
// the mock is installed, because mock.module rewrites the live namespace
// object and reading it back afterwards yields the stub.
let stubsActive = false
let injectedContext: string[] | null = null
let postToolUseHooksThrow = false
let injectedPreToolResult: unknown | null = null

const actualToolHooks = await import('./toolHooks.js')
const realRunPreToolUseHooks = actualToolHooks.runPreToolUseHooks
const realRunPostToolUseHooks = actualToolHooks.runPostToolUseHooks
mock.module('./toolHooks.js', () => ({
  ...actualToolHooks,
  runPreToolUseHooks: async function* (
    ...args: Parameters<typeof realRunPreToolUseHooks>
  ) {
    if (!stubsActive) {
      yield* realRunPreToolUseHooks(...args)
      return
    }
    if (injectedContext === null && injectedPreToolResult === null) {
      yield* realRunPreToolUseHooks(...args)
      return
    }
    if (injectedContext !== null) {
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
    }
    if (injectedPreToolResult !== null) {
      const injected =
        typeof injectedPreToolResult === 'function'
          ? (
              injectedPreToolResult as (
                ...args: Parameters<typeof realRunPreToolUseHooks>
              ) => unknown
            )(...args)
          : injectedPreToolResult
      yield injected as never
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
      alwaysAskRules: {},
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

function makeTool(
  name: string,
  call: (
    input: Record<string, unknown>,
    context: ToolUseContext,
  ) => Promise<{ data: unknown }>,
  aliases?: string[],
  validateInput: () => Promise<ValidationResult> = async () => ({
    result: true as const,
  }),
  lifecycle?: {
    backfillObservableInput?(input: Record<string, unknown>): void
    prepareExecution?(
      input: Record<string, unknown>,
      context: ToolUseContext,
    ): Promise<{ state: unknown; cleanup(): void }>
  },
) {
  return buildTool({
    name,
    aliases,
    inputSchema: z.strictObject({
      value: z.string(),
      command: z.string().optional(),
      path: z.string().optional(),
      nested: z.strictObject({ value: z.string() }).optional(),
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: (): boolean => false,
    async description() {
      return name
    },
    async prompt() {
      return name
    },
    async validateInput(): Promise<ValidationResult> {
      return validateInput()
    },
    ...lifecycle,
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
  input: Record<string, unknown> = { value: 'x' },
  canUseTool: Parameters<typeof runToolUse>[2] = async (
    _tool,
    authorizedInput,
  ) => ({ behavior: 'allow' as const, updatedInput: authorizedInput }),
): Promise<MessageUpdateLazy[]> {
  const context = createToolUseContext([tool], abortController)
  const updates: MessageUpdateLazy[] = []
  for await (const update of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: tool.name,
      input,
      caller: { type: 'direct' },
    },
    createAssistantMessage(),
    canUseTool as never,
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
  injectedPreToolResult = null
  postToolUseHooksThrow = false
})

describe('runToolUse PreToolUse additionalContext', () => {
  test('classifies returned tool errors as failed executions', () => {
    expect(classifyReturnedToolExecution({})).toBe('succeeded')
    expect(classifyReturnedToolExecution({ is_error: false })).toBe(
      'succeeded',
    )
    expect(classifyReturnedToolExecution({ is_error: true })).toBe('failed')
  })

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
    const model = JSON.parse(resultBlock.content!.replace('<tool_use_error>', '').replace('</tool_use_error>', ''))
    expect(model.failures).toHaveLength(1)
    expect(model.failures[0]).toMatchObject({ code: 'PATCH_ANCHOR_AMBIGUOUS', hunk: 2 })
    expect(model).not.toHaveProperty('details')
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

describe('runToolUse final input authorization', () => {
  test('rejects schema-invalid passthrough PreToolUse updatedInput', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: { value: 'changed', _simulatedSedEdit: { filePath: '/x' } },
    }
    let calls = 0
    let authorizations = 0
    const tool = makeTool('SchemaMutationTool', async () => {
      calls++
      return { data: 'unexpected' }
    })
    await drain(
      tool,
      undefined,
      { value: 'original' },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(calls).toBe(0)
    expect(authorizations).toBe(0)
  })

  test('preserves PreToolUse context before a schema-invalid mutation error', async () => {
    stubsActive = true
    injectedContext = [HOOK_TEXT]
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: { value: 'changed', untrusted: true },
    }
    let calls = 0
    const tool = makeTool('ContextAndInvalidInputTool', async () => {
      calls++
      return { data: 'unexpected' }
    })
    const updates = await drain(tool, undefined, { value: 'original' })
    expect(calls).toBe(0)
    expect(additionalContextTexts(updates)).toEqual([HOOK_TEXT])
    const toolResults = updates.filter(update => toolResultIndices([update]).length)
    expect(toolResults).toHaveLength(1)
    expect(additionalContextIndex(updates)).toBeLessThan(
      updates.indexOf(toolResults[0]!),
    )
  })

  test('rejects model-provided internal SedEdit fields at the input schema', async () => {
    let calls = 0
    let authorizations = 0
    const tool = makeTool('Bash', async () => {
      calls++
      return { data: 'unexpected' }
    })
    await drain(
      tool,
      undefined,
      {
        value: 'x',
        command: 'safe',
        _simulatedSedEdit: {
          filePath: '/unapproved/file',
          newContent: 'unapproved',
        },
      },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(calls).toBe(0)
    expect(authorizations).toBe(0)
  })

  test('rejects schema-invalid PreToolUse allow updatedInput before permission checks', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookPermissionResult',
      hookPermissionResult: {
        behavior: 'allow',
        updatedInput: { value: 'changed', untrusted: true },
      },
    }
    let calls = 0
    let authorizations = 0
    const tool = makeTool('HookSchemaMutationTool', async () => {
      calls++
      return { data: 'unexpected' }
    })
    await drain(
      tool,
      undefined,
      { value: 'original' },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(calls).toBe(0)
    expect(authorizations).toBe(0)
  })

  test('rejects semantically invalid PreToolUse allow updatedInput before permission checks', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookPermissionResult',
      hookPermissionResult: {
        behavior: 'allow',
        updatedInput: { value: 'blocked' },
      },
    }
    let calls = 0
    let authorizations = 0
    const tool = makeTool(
      'HookSemanticMutationTool',
      async () => {
        calls++
        return { data: 'unexpected' }
      },
      undefined,
      async () => ({ result: false, message: 'blocked', errorCode: 1 }),
    )
    await drain(
      tool,
      undefined,
      { value: 'original' },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(calls).toBe(0)
    expect(authorizations).toBe(0)
  })

  test('rejects semantic-invalid passthrough mutation before canUseTool', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: { value: 'blocked' },
    }
    let calls = 0
    let authorizations = 0
    const tool = makeTool(
      'SemanticMutationTool',
      async () => {
        calls++
        return { data: 'unexpected' }
      },
      undefined,
      async () => ({ result: false, message: 'blocked', errorCode: 1 }),
    )
    await drain(
      tool,
      undefined,
      { value: 'original' },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(calls).toBe(0)
    expect(authorizations).toBe(0)
  })

  test('re-authorizes a changed hook input and calls with the final object', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: {
        value: 'changed',
        command: 'different',
        path: '/different',
      },
    }
    let calls = 0
    let authorizations = 0
    let executedInput: Record<string, unknown> | undefined
    let finalAuthorizedInput: Record<string, unknown> | undefined
    const tool = makeTool('ChangedInputTool', async () => ({ data: 'ok' }))
    tool.call = async input => {
      calls++
      executedInput = input as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(
      tool,
      undefined,
      { value: 'original', command: 'safe', path: '/safe' },
      async (_tool, input) => {
        authorizations++
        finalAuthorizedInput = input
        return { behavior: 'allow' as const, updatedInput: input }
      },
    )
    expect(authorizations).toBe(1)
    expect(calls).toBe(1)
    expect(executedInput).toEqual({
      value: 'changed',
      command: 'different',
      path: '/different',
    })
    expect(executedInput).toBe(finalAuthorizedInput)
  })

  test.each(['allow', 'ask'] as const)(
    'handles PreToolUse %s updatedInput',
    async behavior => {
      stubsActive = true
      injectedPreToolResult = {
        type: 'hookPermissionResult',
        hookPermissionResult: {
          behavior,
          updatedInput: { value: `${behavior}-input` },
          message: 'Permission needed',
        },
      }
      let calls = 0
      let authorizations = 0
      let executedInput: Record<string, unknown> | undefined
      const tool = makeTool('HookDecisionTool', async () => ({ data: 'ok' }))
      tool.call = async input => {
        calls++
        executedInput = input as Record<string, unknown>
        return { data: 'ok' }
      }
      await drain(
        tool,
        undefined,
        { value: 'original' },
        async (_tool, input) => {
          authorizations++
          return { behavior: 'allow' as const, updatedInput: input }
        },
      )
      expect(calls).toBe(1)
      expect(executedInput).toEqual({ value: `${behavior}-input` })
      expect(authorizations).toBe(1)
    },
  )

  test('keeps hook-satisfied interactive input without a second prompt', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookPermissionResult',
      hookPermissionResult: {
        behavior: 'allow',
        updatedInput: { value: 'hook-answer' },
      },
    }
    let calls = 0
    let authorizations = 0
    let executedInput: Record<string, unknown> | undefined
    const tool = makeTool('InteractiveHookTool', async () => ({ data: 'ok' }))
    tool.requiresUserInteraction = () => true
    tool.call = async input => {
      calls++
      executedInput = input as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(
      tool,
      undefined,
      { value: 'original' },
      async () => {
        authorizations++
        return { behavior: 'allow' as const }
      },
    )
    expect(authorizations).toBe(0)
    expect(calls).toBe(1)
    expect(executedInput).toEqual({ value: 'hook-answer' })
  })

  test.each([
    ['PermissionRequest hook', false],
    ['coordinator approval', false],
    ['bridge approval', false],
    ['userModified-only approval marker', true],
  ] as const)(
    'revalidates %s updatedInput from the permission boundary',
    async (_path, userModified) => {
      stubsActive = true
      let calls = 0
      let authorizations = 0
      let executedInput: Record<string, unknown> | undefined
      const tool = makeTool('PermissionMutationTool', async () => ({ data: 'ok' }))
      tool.call = async input => {
        calls++
        executedInput = input as Record<string, unknown>
        return { data: 'ok' }
      }
      await drain(
        tool,
        undefined,
        { value: 'original', command: 'safe', path: '/safe' },
        async () => {
          authorizations++
          return {
            behavior: 'allow' as const,
            updatedInput: {
              value: 'authorized replacement',
              command: 'different',
              path: '/different',
            },
            userModified,
          }
        },
      )
      expect(authorizations).toBe(2)
      expect(calls).toBe(1)
      expect(executedInput).toEqual({
        value: 'authorized replacement',
        command: 'different',
        path: '/different',
      })
    },
  )

  test('userModified flag cannot override a final tool-policy denial', async () => {
    stubsActive = true
    let calls = 0
    const tool = makeTool('PolicyDeniedInputTool', async () => {
      calls++
      return { data: 'unexpected' }
    })
    tool.checkPermissions = async input =>
      input.path === '/blocked'
        ? {
            behavior: 'deny',
            message: 'blocked path',
            decisionReason: { type: 'other', reason: 'blocked path' },
          }
        : { behavior: 'allow', updatedInput: input }
    await drain(
      tool,
      undefined,
      { value: 'original', command: 'safe', path: '/safe' },
      async () => ({
        behavior: 'allow' as const,
        updatedInput: {
          value: 'user-selected',
          command: 'different',
          path: '/blocked',
        },
        userModified: true,
      }),
    )
    expect(calls).toBe(0)
  })

  test('changed input from a second canUseTool result needs its own receipt', async () => {
    stubsActive = true
    let calls = 0
    let authorizations = 0
    const tool = makeTool('UnstablePermissionInputTool', async () => {
      calls++
      return { data: 'unexpected' }
    })
    await drain(
      tool,
      undefined,
      { value: 'original', command: 'safe', path: '/safe' },
      async () => {
        authorizations++
        return {
          behavior: 'allow' as const,
          updatedInput:
            authorizations === 1
              ? { value: 'first', command: 'first', path: '/first' }
              : { value: 'second', command: 'second', path: '/second' },
          userModified: true,
        }
      },
    )
    expect(authorizations).toBe(2)
    expect(calls).toBe(0)
  })

  test('accepts edited input once only with a local user-approval receipt', async () => {
    stubsActive = true
    let calls = 0
    let authorizations = 0
    let executedInput: Record<string, unknown> | undefined
    const approvedInput = {
      value: 'user-approved',
      command: 'edited',
      path: '/edited',
    }
    const tool = makeTool('UserEditedInputTool', async () => ({ data: 'ok' }))
    tool.call = async input => {
      calls++
      executedInput = input as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(
      tool,
      undefined,
      { value: 'original', command: 'safe', path: '/safe' },
      async (currentTool, input, context, message, toolUseID) => {
        authorizations++
        const permissionContext = createPermissionContext(
          currentTool,
          input,
          context,
          message,
          toolUseID,
          () => {},
        )
        const decision = await permissionContext.handleUserAllow(
          approvedInput,
          [],
        )
        expect(decision.updatedInput).toBe(approvedInput)
        return decision
      },
    )
    expect(authorizations).toBe(1)
    expect(calls).toBe(1)
    expect(executedInput).toEqual(approvedInput)
    expect(executedInput).toBe(approvedInput)
  })

  test('no-op hooks over backfilled metadata preserve prepared canonical input', async () => {
    stubsActive = true
    const modelInput = {
      value: 'same',
      path: '/model/path',
      nested: { value: 'model' },
    }
    let preparedInput: Record<string, unknown> | undefined
    let hookInput: Record<string, unknown> | undefined
    let authorizedInput: Record<string, unknown> | undefined
    let executedInput: Record<string, unknown> | undefined
    let prepareCount = 0
    let cleanupCount = 0
    injectedPreToolResult = (...args: unknown[]) => {
      hookInput = args[2] as Record<string, unknown>
      return {
        type: 'hookUpdatedInput',
        updatedInput: structuredClone(hookInput),
      }
    }
    const tool = makeTool(
      'PreparedNoOpTool',
      async () => ({ data: 'ok' }),
      undefined,
      undefined,
      {
        backfillObservableInput(input) {
          input.path = '/expanded/path'
          ;(input.nested as { value: string }).value = 'expanded'
        },
        async prepareExecution(input) {
          prepareCount++
          preparedInput = input
          return {
            state: input.path,
            cleanup() {
              cleanupCount++
            },
          }
        },
      },
    )
    tool.call = async input => {
      executedInput = input as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(tool, undefined, modelInput, async (_tool, input) => {
      authorizedInput = input
      return { behavior: 'allow' as const, updatedInput: input }
    })
    expect(hookInput?.path).toBe('/expanded/path')
    expect((hookInput?.nested as { value: string }).value).toBe('expanded')
    expect(modelInput.path).toBe('/model/path')
    expect(modelInput.nested.value).toBe('model')
    expect(prepareCount).toBe(1)
    expect(cleanupCount).toBe(1)
    expect(preparedInput).toBe(authorizedInput)
    expect(executedInput).toBe(preparedInput)
    expect(executedInput?.path).toBe('/model/path')
  })

  test('user-approved parsed clone keeps the original prepared handle', async () => {
    stubsActive = true
    const modelInput = {
      value: 'same',
      command: 'safe',
      path: '/same/path',
      nested: { value: 'same' },
    }
    let preparedInput: Record<string, unknown> | undefined
    let executedInput: Record<string, unknown> | undefined
    let prepareCount = 0
    let cleanupCount = 0
    const tool = makeTool(
      'PreparedApprovalTool',
      async () => ({ data: 'ok' }),
      undefined,
      undefined,
      {
        async prepareExecution(input) {
          prepareCount++
          preparedInput = input
          return {
            state: input.path,
            cleanup() {
              cleanupCount++
            },
          }
        },
      },
    )
    tool.call = async input => {
      executedInput = input as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(
      tool,
      undefined,
      modelInput,
      async (currentTool, input, context, message, toolUseID) => {
        const permissionContext = createPermissionContext(
          currentTool,
          input,
          context,
          message,
          toolUseID,
          () => {},
        )
        return permissionContext.handleUserAllow(structuredClone(input), [])
      },
    )
    expect(prepareCount).toBe(1)
    expect(cleanupCount).toBe(1)
    expect(executedInput).toBe(preparedInput)
    expect(executedInput).toEqual(modelInput)
  })

  test('permission wait cannot retarget prepared input after a hook changes its path', async () => {
    stubsActive = true
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: {
        value: 'changed',
        command: 'safe',
        path: '/approved/path',
      },
    }
    let prepareCount = 0
    let cleanupCount = 0
    let authorizedPath: unknown
    let executedPath: unknown
    let executedPreparedPath: unknown
    let currentFilesystemTarget = '/approved/path'
    const tool = makeTool(
      'PreparedPathChangeTool',
      async () => ({ data: 'ok' }),
      undefined,
      undefined,
      {
        async prepareExecution(input) {
          prepareCount++
          const handle = { path: input.path }
          return {
            state: handle,
            cleanup() {
              cleanupCount++
            },
          }
        },
      },
    )
    tool.call = async (input, context) => {
      executedPath = input.path
      executedPreparedPath = (
        context.preparedExecution?.state as { path: string } | undefined
      )?.path
      return { data: 'ok' }
    }
    await drain(
      tool,
      undefined,
      { value: 'original', command: 'safe', path: '/model/path' },
      async (_tool, input) => {
        authorizedPath = input.path
        await Promise.resolve()
        currentFilesystemTarget = '/attacker-switched-target'
        return { behavior: 'allow' as const, updatedInput: structuredClone(input) }
      },
    )
    expect(authorizedPath).toBe('/approved/path')
    expect(currentFilesystemTarget).toBe('/attacker-switched-target')
    expect(executedPath).toBe('/approved/path')
    expect(executedPreparedPath).toBe('/approved/path')
    expect(prepareCount).toBe(2)
    expect(cleanupCount).toBe(2)
  })

  test('freezes nested canonical input across asynchronous authorization', async () => {
    stubsActive = true
    const input = { value: 'original', nested: { value: 'before' } }
    injectedPreToolResult = {
      type: 'hookUpdatedInput',
      updatedInput: input,
    }
    let executedInput: Record<string, unknown> | undefined
    const tool = makeTool('NestedMutationTool', async () => ({ data: 'ok' }))
    tool.call = async callInput => {
      executedInput = callInput as Record<string, unknown>
      return { data: 'ok' }
    }
    await drain(tool, undefined, input, async (_tool, authorizedInput) => {
      const nested = authorizedInput.nested as { value: string }
      expect(Object.isFrozen(nested)).toBe(true)
      expect(() => {
        nested.value = 'mutated during authorization'
      }).toThrow()
      await Promise.resolve()
      return { behavior: 'allow' as const, updatedInput: authorizedInput }
    })
    expect((executedInput?.nested as { value: string }).value).toBe('before')
  })

  test('passes trusted SedEdit capability out of band to Bash call once', async () => {
    stubsActive = true
    let calls = 0
    let executedInput: Record<string, unknown> | undefined
    let executedCapability: unknown
    const tool = makeTool('Bash', async () => ({ data: 'ok' }))
    tool.call = async (input, context) => {
      calls++
      executedInput = input as Record<string, unknown>
      executedCapability = consumeTrustedSedEditForExecution(context)
      return { data: 'ok' }
    }
    await drain(tool, undefined, { value: 'x', command: 'safe' }, async (_tool, input) => {
      registerTrustedSedEditApproval(
        input,
        'toolu_1',
        {
          toolUseID: 'toolu_1',
          command: 'safe',
          filePath: '/previewed/file',
          previewId: 'preview-1',
          identity: {
            canonicalPath: '/previewed/file',
            device: 1,
            inode: 2,
            size: 10,
            modifiedAtMs: 3,
            changedAtMs: 4,
          },
        },
      )
      return { behavior: 'allow' as const, updatedInput: input }
    })
    expect(calls).toBe(1)
    expect(executedInput).toEqual({ value: 'x', command: 'safe' })
    expect(executedInput).not.toHaveProperty('_simulatedSedEdit')
    expect(executedCapability).toEqual({
      toolUseID: 'toolu_1',
      command: 'safe',
      filePath: '/previewed/file',
      previewId: 'preview-1',
      identity: {
        canonicalPath: '/previewed/file',
        device: 1,
        inode: 2,
        size: 10,
        modifiedAtMs: 3,
        changedAtMs: 4,
      },
    })
  })
})

describe('patch error path parity', () => {
  test('keeps non-patch validation errors on their existing path even with a code', async () => {
    const tool = makeTool('OtherTool', async () => { throw new Error('must not execute') })
    tool.validateInput = async () => ({ result: false, message: 'Other validation failed.', errorCode: 1, meta: { code: 'OTHER_CODE' } })
    const updates = await drain(tool)
    const result = updates.find(update => toolResultIndices([update]).length > 0)!.message as {
      message: { content: { content: string }[] }; toolUseResult: unknown
    }
    expect(result.message.content[0]!.content).toBe('<tool_use_error>Other validation failed.</tool_use_error>')
    expect(result.toolUseResult).toMatchObject({
      type: 'validation_error', content: 'Error: Other validation failed.', meta: { code: 'OTHER_CODE' },
    })
  })

  test('execution and validation share the projection while retaining their storage envelopes', async () => {
    const error = new FilePatchError('Diagnostic detail repeated. '.repeat(50), {
      code: 'PATCH_ANCHOR_AMBIGUOUS', operation: 'update', path: '/tmp/parity',
      hunkCount: 2, patchSourceSpan: { startLine: 3, endLine: 5 }, omittedFailureCount: 2,
      diagnostics: {
        code: 'PATCH_ANCHOR_AMBIGUOUS', kind: 'ambiguity', path: '/tmp/parity',
        hunkCount: 2, nearMatches: [], diagnosticsTruncated: true, candidateCoordinatesOmitted: 4,
        completePlanWitnesses: [
          { placements: [{ hunk: 1, start: 0, end: 1 }, { hunk: 2, start: 9, end: 10 }], placementsOmitted: 0 },
          { placements: [{ hunk: 1, start: 1, end: 2 }, { hunk: 2, start: 9, end: 10 }], placementsOmitted: 0 },
        ],
        candidateCoordinates: Array.from({ length: 10 }, (_, index) => ({
          start: index, end: index + 1, hunk: index < 9 ? 1 : 2,
        })),
      },
    })
    const persisted = serializeFilePatchError(error)
    const execution = makeTool('Apply_patch', async () => { throw error })
    const validation = makeTool('Apply_patch', async () => { throw new Error('must not execute') })
    validation.validateInput = async () => ({ result: false, message: error.message, errorCode: 1, meta: { ...persisted } })
    const results = []
    for (const tool of [execution, validation]) {
      const updates = await drain(tool)
      const result = updates.find(update => toolResultIndices([update]).length > 0)!.message as {
        message: { content: { content: string }[] }; toolUseResult: unknown
      }
      results.push(result)
    }
    expect(results[0]!.message.content[0]!.content).toBe(results[1]!.message.content[0]!.content)
    expect(results[0]!.toolUseResult).toEqual(persisted)
    expect(results[1]!.toolUseResult).toMatchObject({
      type: 'validation_error', meta: persisted,
    })
    expect(JSON.parse((results[1]!.toolUseResult as { content: string }).content.slice('Error: '.length))).toEqual(persisted)
    const model = JSON.parse(results[1]!.message.content[0]!.content.replace('<tool_use_error>', '').replace('</tool_use_error>', ''))
    expect(model.failures[0].evidence.omittedCandidateCount).toBe(8)
    expect(model.omittedFailureCount).toBe(2)
    expect(model.failures[0].witnesses).toHaveLength(2)
    expect(model.failures[0].witnesses[0].kind).toBe('complete-plan-witness')
    expect(model.failures[0].patchSourceSpan.kind).toBe('patch-envelope-lines')
  })
})

describe('tool execution authority', () => {
  for (const executorKind of ['batch', 'streaming'] as const) {
    for (const agentId of [undefined, 'worker-fixture']) {
      const scope = agentId ? 'worker' : 'foreground'

      test(`${executorKind} ${scope} resolves canonical and alias names only inside its pool`, async () => {
        let calls = 0
        const tool = makeTool(
          'CanonicalFixture',
          async () => {
            calls++
            return { data: 'ok' }
          },
          ['LegacyFixture'],
        )

        for (const name of ['CanonicalFixture', 'LegacyFixture']) {
          const block = {
            type: 'tool_use' as const,
            id: `${executorKind}-${scope}-${name}`,
            name,
            input: { value: 'x' },
            caller: { type: 'direct' as const },
          }
          const assistant = createAssistantMessage()
          assistant.message.content = [block]
          const context = createToolUseContext([tool])
          context.agentId = agentId ? asAgentId(agentId) : undefined
          const canUseTool = async () => ({
            behavior: 'allow' as const,
            updatedInput: { value: 'x' },
          })
          if (executorKind === 'batch') {
            for await (const _ of runTools(
              [block],
              [assistant],
              canUseTool,
              context,
            )) {
              // drain the real batch executor
            }
          } else {
            const executor = new StreamingToolExecutor(
              context.options.tools,
              canUseTool,
              context,
            )
            executor.addTool(block, assistant)
            for await (const _ of executor.getRemainingResults()) {
              // drain the real streaming executor
            }
          }
        }
        expect(calls).toBe(2)

        const deniedContext = createToolUseContext([tool])
        deniedContext.agentId = agentId ? asAgentId(agentId) : undefined
        const deniedAssistant = createAssistantMessage()
        const deniedBlock = {
          type: 'tool_use' as const,
          id: `${executorKind}-${scope}-denied-alias`,
          name: 'LegacyFixture',
          input: { value: 'x' },
          caller: { type: 'direct' as const },
        }
        deniedAssistant.message.content = [deniedBlock]
        const deny = async () => ({
          behavior: 'deny' as const,
          message: 'fixture deny',
          decisionReason: { type: 'other' as const, reason: 'fixture' },
        })
        if (executorKind === 'batch') {
          for await (const _ of runTools(
            [deniedBlock],
            [deniedAssistant],
            deny,
            deniedContext,
          )) {
            // drain
          }
        } else {
          const executor = new StreamingToolExecutor(
            deniedContext.options.tools,
            deny,
            deniedContext,
          )
          executor.addTool(deniedBlock, deniedAssistant)
          for await (const _ of executor.getRemainingResults()) {
            // drain
          }
        }
        expect(calls).toBe(2)
      })
    }
  }
})

describe('streaming terminal handoff', () => {
  test('waits for a started sibling effect before publishing the handoff', async () => {
    let releaseEffect!: () => void
    const effectGate = new Promise<void>(resolve => {
      releaseEffect = resolve
    })
    let effectStarted = false
    let effectFinished = false
    const ask = makeTool(ASK_PARENT_SESSION_TOOL_NAME, async () => ({ data: 'handed off' }))
    const effect = makeTool('OwnedEffect', async () => {
      effectStarted = true
      await effectGate
      effectFinished = true
      return { data: 'settled' }
    })
    const context = createToolUseContext([ask, effect])
    const assistant = createAssistantMessage()
    const blocks = [
      { type: 'tool_use' as const, id: 'ask', name: ask.name, input: { value: 'x' }, caller: { type: 'direct' as const } },
      { type: 'tool_use' as const, id: 'effect', name: effect.name, input: { value: 'x' }, caller: { type: 'direct' as const } },
    ]
    assistant.message.content = blocks
    const executor = new StreamingToolExecutor(
      context.options.tools,
      async (_tool, input) => ({ behavior: 'allow' as const, updatedInput: input }),
      context,
    )
    for (const block of blocks) executor.addTool(block, assistant)

    const draining = (async () => {
      const messages: Message[] = []
      for await (const update of executor.getRemainingResults()) {
        if (update.message) messages.push(update.message)
      }
      return messages
    })()
    for (let i = 0; i < 100 && !effectStarted; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(effectStarted).toBe(true)
    let published = false
    void draining.then(() => {
      published = true
    })
    await Promise.resolve()
    expect(published).toBe(false)
    releaseEffect()
    const messages = await draining
    expect(effectFinished).toBe(true)
    expect(JSON.stringify(messages)).toContain('handed off')
  })

  test('does not wait forever for permission and prevents the effect from starting later', async () => {
    let releasePermission!: () => void
    const permissionGate = new Promise<void>(resolve => {
      releasePermission = resolve
    })
    let effectCalls = 0
    const ask = makeTool(ASK_PARENT_SESSION_TOOL_NAME, async () => ({ data: 'handed off' }))
    const effect = makeTool('PermissionWait', async () => {
      effectCalls++
      return { data: 'ran' }
    })
    const context = createToolUseContext([ask, effect])
    const assistant = createAssistantMessage()
    const blocks = [
      { type: 'tool_use' as const, id: 'ask', name: ask.name, input: { value: 'x' }, caller: { type: 'direct' as const } },
      { type: 'tool_use' as const, id: 'waiting', name: effect.name, input: { value: 'x' }, caller: { type: 'direct' as const } },
    ]
    assistant.message.content = blocks
    const executor = new StreamingToolExecutor(
      context.options.tools,
      async (tool, input) => {
        if (tool.name === effect.name) await permissionGate
        return { behavior: 'allow' as const, updatedInput: input }
      },
      context,
    )
    for (const block of blocks) executor.addTool(block, assistant)
    const iterator = executor.getRemainingResults()
    const firstResult = await iterator.next()
    expect(firstResult.done).toBe(false)
    expect(effectCalls).toBe(0)
    releasePermission()
    for await (const _ of { [Symbol.asyncIterator]: () => iterator }) {
      // drain the remaining results
    }
    expect(effectCalls).toBe(0)
  })
})

describe('toolExecution modelResultContent handling', () => {
  test('uses modelResultContent for tool_result block while preserving result.data on message.toolUseResult', async () => {
    const metadata = { filePath: '/tmp/test.png', size: '100x100', bytes: 1234 }
    const modelContent = [
      { type: 'text' as const, text: 'Custom metadata text' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: 'ZmFrZQ==',
        },
      },
    ]

    let mappedToolResultCalled = false
    const tool = buildTool({
      name: 'CustomModelResultTool',
      inputSchema: z.strictObject({ value: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      description: async () => 'test',
      prompt: async () => 'test',
      validateInput: async () => ({ result: true as const }),
      renderToolUseMessage: () => null,
      maxResultSizeChars: 10_000,
      mapToolResultToToolResultBlockParam(_output: unknown, toolUseID: string) {
        mappedToolResultCalled = true
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: 'fallback',
        }
      },
      call: async () => ({
        data: metadata,
        modelResultContent: modelContent,
      }),
    })

    const updates = await drain(tool as any)
    const userMsg = updates.find(u => u.message.type === 'user')?.message
    expect(userMsg).toBeDefined()
    if (userMsg?.type !== 'user') throw new Error('expected user message')

    // 1. Content uses modelResultContent
    const block = userMsg.message.content[0]
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: modelContent,
    })

    // 2. toolUseResult receives only result.data (no base64 image data)
    expect(userMsg.toolUseResult).toEqual(metadata)

    // 3. mapToolResultToToolResultBlockParam was NOT called because modelResultContent took precedence
    expect(mappedToolResultCalled).toBe(false)
  })

  test('normal tool without modelResultContent calls mapToolResultToToolResultBlockParam', async () => {
    const data = { count: 42 }
    let mappedToolResultCalled = false

    const tool = buildTool({
      name: 'NormalTool',
      inputSchema: z.strictObject({ value: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      description: async () => 'test',
      prompt: async () => 'test',
      validateInput: async () => ({ result: true as const }),
      renderToolUseMessage: () => null,
      maxResultSizeChars: 10_000,
      mapToolResultToToolResultBlockParam(output: unknown, toolUseID: string) {
        mappedToolResultCalled = true
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `normal content: ${(output as { count: number }).count}`,
        }
      },
      call: async () => ({
        data,
      }),
    })

    const updates = await drain(tool as any)
    const userMsg = updates.find(u => u.message.type === 'user')?.message
    expect(userMsg).toBeDefined()
    if (userMsg?.type !== 'user') throw new Error('expected user message')

    // mapToolResultToToolResultBlockParam was called
    expect(mappedToolResultCalled).toBe(true)

    const block = userMsg.message.content[0]
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'normal content: 42',
    })
    expect(userMsg.toolUseResult).toEqual(data)
  })
})
