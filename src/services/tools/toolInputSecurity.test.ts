import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { buildTool, type ToolUseContext, type ValidationResult } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  registerTransferredTrustedSedEditApproval,
  registerTrustedSedEditApproval,
  takeTrustedSedEditApprovalForTransfer,
} from '../../tools/BashTool/sedEditCapability.js'
import {
  authorizeFinalToolInput,
  freezeCanonicalToolInput,
  ToolInputPreparation,
} from './toolInputSecurity.js'

const schema = z.strictObject({
  command: z.string(),
  path: z.string(),
  nested: z.strictObject({ value: z.string() }),
})

type Input = z.infer<typeof schema>

const assistantMessage = {
  type: 'assistant',
  uuid: 'security-test',
  timestamp: '2026-10-05T00:00:00.000Z',
  requestId: 'security-test',
  message: {
    id: 'security-test',
    model: 'test-model',
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

function createTool(
  validateInput: (input: Input) => Promise<ValidationResult> = async () => ({
    result: true,
  }),
  prepareExecution?: (input: Input) => Promise<{
    state: unknown
    cleanup(): void
  }>,
) {
  return buildTool({
    name: 'SecurityBoundaryTool',
    inputSchema: schema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async description() {
      return 'test'
    },
    async prompt() {
      return 'test'
    },
    async validateInput(input) {
      return validateInput(input)
    },
    ...(prepareExecution ? { prepareExecution } : {}),
    renderToolUseMessage: () => null,
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    maxResultSizeChars: 1000,
    mapToolResultToToolResultBlockParam(_output, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: 'ok' }
    },
    async call() {
      return { data: 'ok' }
    },
  })
}

function context(): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: { tools: [] },
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
  } as unknown as ToolUseContext
}

const original: Input = {
  command: 'safe',
  path: '/safe',
  nested: { value: 'before' },
}
const previewIdentity = {
  canonicalPath: '/previewed/file',
  device: 1,
  inode: 2,
  size: 10,
  modifiedAtMs: 3,
  changedAtMs: 4,
}
const previewChallenge = {
  toolUseID: 'tool-use',
  command: original.command,
  filePath: '/previewed/file',
  previewId: 'preview-1',
  identity: previewIdentity,
}

describe('authorizeFinalToolInput', () => {
  test('freezes nested children under a pre-frozen cyclic root', () => {
    const child = { value: 'unchanged' }
    const rootValue: { child: typeof child; self?: unknown } = { child }
    rootValue.self = rootValue
    const root = Object.freeze(rootValue)
    freezeCanonicalToolInput(root)
    expect(Object.isFrozen(root)).toBe(true)
    expect(Object.isFrozen(child)).toBe(true)
    expect(() => {
      child.value = 'mutated'
    }).toThrow()
    expect(root.self).toBe(root)
  })

  test('rejects schema-invalid input before requesting authorization', async () => {
    const tool = createTool()
    let authorizations = 0
    const result = await authorizeFinalToolInput(
      tool,
      { ...original, unexpected: true },
      original,
      { behavior: 'allow' },
      'tool-use',
      context(),
      assistantMessage,
      new ToolInputPreparation(),
      async () => null,
      async () => {
        authorizations++
        return { behavior: 'allow' }
      },
    )
    expect(result.allowed).toBe(false)
    expect(authorizations).toBe(0)
  })

  test('re-authorizes changed command and path, then returns its final canonical object', async () => {
    let authorizations = 0
    let preparedInput: Record<string, unknown> | undefined
    const tool = createTool(undefined, async input => {
      preparedInput = input
      return { state: 'prepared', cleanup() {} }
    })
    const changed = { ...original, command: 'changed', path: '/changed' }
    const preparation = new ToolInputPreparation()
    const result = await authorizeFinalToolInput(
      tool,
      changed,
      original,
      { behavior: 'allow' },
      'tool-use',
      context(),
      assistantMessage,
      preparation,
      async () => null,
      async (_tool, input) => {
        authorizations++
        return { behavior: 'allow', updatedInput: input }
      },
    )
    expect(result.allowed).toBe(true)
    expect(authorizations).toBe(1)
    if (result.allowed) {
      expect(result.input).toEqual(changed)
      expect(result.context.preparedExecution?.input).toBe(result.input)
      expect(preparedInput).toBe(result.input)
      expect(Object.isFrozen(result.input.nested)).toBe(true)
    }
    await preparation.dispose()
  })

  test('a parsed clone from fresh authorization retains the authorized preparation', async () => {
    let preparations = 0
    let authorizedInput: Record<string, unknown> | undefined
    const tool = createTool(undefined, async () => ({
      state: ++preparations,
      cleanup() {},
    }))
    const preparation = new ToolInputPreparation()
    try {
      const result = await authorizeFinalToolInput(
        tool,
        { ...original, command: 'changed', path: '/changed' },
        original,
        { behavior: 'allow' },
        'tool-use',
        context(),
        assistantMessage,
        preparation,
        async () => null,
        async (_tool, input) => {
          authorizedInput = input
          return {
            behavior: 'allow',
            updatedInput: schema.parse(input),
          }
        },
      )
      expect(result.allowed).toBe(true)
      expect(preparations).toBe(1)
      if (result.allowed) {
        expect(result.input).toBe(authorizedInput)
        expect(result.context.preparedExecution?.input).toBe(authorizedInput)
        expect(result.context.preparedExecution?.state).toBe(1)
      }
    } finally {
      await preparation.dispose()
    }
  })

  test('rejects semantically invalid input before re-authorization', async () => {
    const tool = createTool(async input =>
      input.path === '/blocked'
        ? { result: false, message: 'blocked', errorCode: 1 }
        : { result: true },
    )
    let authorizations = 0
    const result = await authorizeFinalToolInput(
      tool,
      { ...original, path: '/blocked' },
      original,
      { behavior: 'allow' },
      'tool-use',
      context(),
      assistantMessage,
      new ToolInputPreparation(),
      async () => null,
      async () => {
        authorizations++
        return { behavior: 'allow' }
      },
    )
    expect(result.allowed).toBe(false)
    expect(authorizations).toBe(0)
  })

  test('uses a matching trusted SedEdit approval out of band and once', async () => {
    const tool = buildTool({ ...createTool(), name: 'Bash' })
    const approved = { ...original }
    registerTrustedSedEditApproval(approved, 'tool-use', {
      toolUseID: 'tool-use',
      command: approved.command,
      filePath: '/previewed/file',
      previewId: 'preview-1',
      identity: previewIdentity,
    })
    const preparation = new ToolInputPreparation()
    const args = [
      tool,
      approved,
      original,
      { behavior: 'allow' as const },
      'tool-use',
      context(),
      assistantMessage,
      preparation,
      async () => null,
      async () => {
        throw new Error('trusted approval must not prompt again')
      },
    ] as const
    const first = await authorizeFinalToolInput(...args)
    expect(first.allowed).toBe(true)
    if (first.allowed) {
      expect(first.input).toBe(approved)
      expect(first.input).not.toHaveProperty('_simulatedSedEdit')
      expect(first.trustedSedEdit).toEqual({
        toolUseID: 'tool-use',
        command: approved.command,
        filePath: '/previewed/file',
        previewId: 'preview-1',
        identity: previewIdentity,
      })
    }
    const replay = await authorizeFinalToolInput(...args)
    expect(replay.allowed).toBe(true)
    if (replay.allowed) expect(replay.trustedSedEdit).toBeUndefined()
    await preparation.dispose()
  })

  test('transfers trusted SedEdit authority only to correlated canonical input', async () => {
    const tool = buildTool({ ...createTool(), name: 'Bash' })
    const leaderInput = { ...original }
    registerTrustedSedEditApproval(leaderInput, 'tool-use', {
      toolUseID: 'tool-use',
      command: leaderInput.command,
      filePath: '/previewed/file',
      previewId: 'preview-1',
      identity: previewIdentity,
    })
    const transfer = takeTrustedSedEditApprovalForTransfer(
      leaderInput,
      'tool-use',
    )
    expect(transfer.previewApproved).toBe(true)
    const payload = transfer.payload!
    const workerInput = structuredClone(leaderInput)
    registerTransferredTrustedSedEditApproval(
      workerInput,
      'other-tool-use',
      payload,
      previewChallenge,
    )
    const deniedReplay = await authorizeFinalToolInput(
      tool,
      workerInput,
      original,
      { behavior: 'allow' },
      'other-tool-use',
      context(),
      assistantMessage,
      new ToolInputPreparation(),
      async () => null,
      async () => ({ behavior: 'allow' }),
    )
    expect(deniedReplay.allowed).toBe(true)
    if (deniedReplay.allowed) expect(deniedReplay.trustedSedEdit).toBeUndefined()

    const correlatedInput = structuredClone(leaderInput)
    registerTransferredTrustedSedEditApproval(
      correlatedInput,
      'tool-use',
      payload,
      previewChallenge,
    )
    const approved = await authorizeFinalToolInput(
      tool,
      correlatedInput,
      original,
      { behavior: 'allow' },
      'tool-use',
      context(),
      assistantMessage,
      new ToolInputPreparation(),
      async () => null,
      async () => {
        throw new Error('correlated user approval must not prompt again')
      },
    )
    expect(approved.allowed).toBe(true)
    if (approved.allowed) {
      expect(approved.trustedSedEdit).toEqual({
        toolUseID: 'tool-use',
        command: original.command,
        filePath: '/previewed/file',
        previewId: 'preview-1',
        identity: previewIdentity,
      })
    }
  })
})
