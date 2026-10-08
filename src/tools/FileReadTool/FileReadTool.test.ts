import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAutoMemPath } from '../../memdir/paths.js'
import type { ToolUseContext } from '../../Tool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { FilePatchTool } from '../FilePatchTool/FilePatchTool.js'
import { getFileIdentity } from '../../utils/file.js'
import {
  createFileStateCacheWithSizeLimit,
  isCompleteUnboundedRead,
} from '../../utils/fileStateCache.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import {
  checkApprovedUncReadTarget,
  FileReadTool,
  callFileReadToolWithPreparedCapability,
  formatFileReadTextForModel,
  MaxFileReadTokenExceededError,
  type Output,
  suggestedRetryLimit,
} from './FileReadTool.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from './limits.js'
import { MAX_LINES_TO_READ, OFFSET_INSTRUCTION_TARGETED } from './prompt.js'

const realToolHooks = await import('../../services/tools/toolHooks.js')
const realRunPreToolUseHooks = realToolHooks.runPreToolUseHooks
let preToolUseTestHook: (() => void) | undefined
mock.module('../../services/tools/toolHooks.js', () => ({
  ...realToolHooks,
  async *runPreToolUseHooks(
    ...args: Parameters<typeof realRunPreToolUseHooks>
  ) {
    if (!preToolUseTestHook) {
      yield* realRunPreToolUseHooks(...args)
      return
    }
    preToolUseTestHook()
    yield {
      type: 'hookPermissionResult',
      hookPermissionResult: {
        behavior: 'allow',
        updatedInput: args[2],
      },
    } as never
  },
}))
const { runToolUse } = await import('../../services/tools/toolExecution.js')

let tmpDir: string
let priorSimple: string | undefined
let priorFixturesRoot: string | undefined
const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string }
}
const priorMacro = macroState.MACRO

describe('approved deferred UNC reads', () => {
  const input = { file_path: '//server/share/approved.txt' }
  const permissions = {
    mode: 'default' as const,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: { session: ['Read'] },
    isBypassPermissionsModeAvailable: false,
  }

  test('honors a one-time approval for the unchanged resolved request', () => {
    expect(
      checkApprovedUncReadTarget(
        input,
        input,
        input.file_path,
        '\\\\SERVER\\share\\approved.txt',
        permissions,
      ).behavior,
    ).toBe('allow')
  })

  test('does not extend the one-time approval to a changed resolved route', () => {
    expect(
      checkApprovedUncReadTarget(
        input,
        input,
        input.file_path,
        '//server/share/different.txt',
        permissions,
      ).behavior,
    ).toBe('ask')
  })

  test('honors an explicit deny even for the unchanged approved route', () => {
    expect(
      checkApprovedUncReadTarget(
        input,
        input,
        input.file_path,
        input.file_path,
        { ...permissions, alwaysDenyRules: { session: ['Read'] } },
      ).behavior,
    ).toBe('deny')
  })
})

beforeAll(() => {
  macroState.MACRO = { VERSION: 'test-version' }
  tmpDir = mkdtempSync(join(tmpdir(), 'file-read-tool-'))
  // Skips skill discovery in call(), which would hit the real filesystem.
  priorSimple = process.env.CLAUDE_CODE_SIMPLE
  priorFixturesRoot = process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = tmpDir
})

afterAll(() => {
  if (priorMacro === undefined) delete macroState.MACRO
  else macroState.MACRO = priorMacro
  rmSync(tmpDir, { recursive: true, force: true })
  if (priorSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = priorSimple
  if (priorFixturesRoot === undefined) {
    delete process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT
  } else {
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = priorFixturesRoot
  }
})

/**
 * Real source files end with a newline, and readFileInRange counts a phantom
 * empty final line for those. Fixtures default to that shape so the tests see
 * what production sees.
 */
function writeLines(
  name: string,
  count: number,
  options: { trailingNewline?: boolean; compact?: boolean } = {},
): string {
  const filePath = join(tmpDir, name)
  const lines = Array.from({ length: count }, (_, i) =>
    options.compact ? 'x' : `line ${i + 1}`,
  )
  const trailing = options.trailingNewline === false ? '' : '\n'
  writeFileSync(filePath, lines.join('\n') + trailing, 'utf-8')
  return filePath
}

function createContext(maxTokens?: number) {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    ...(maxTokens === undefined ? {} : { fileReadingLimits: { maxTokens } }),
  }
}

function createLifecycleContext(
  tools: unknown[],
  options: {
    mode?: 'default' | 'bypassPermissions'
    alwaysDenyRules?: Record<string, string[]>
    alwaysAskRules?: Record<string, string[]>
  } = {},
) {
  const appState = {
    toolPermissionContext: {
      mode: options.mode ?? 'bypassPermissions',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: options.alwaysDenyRules ?? {},
      alwaysAskRules: options.alwaysAskRules ?? {},
      isBypassPermissionsModeAvailable: true,
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
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: (updater: (state: typeof appState) => typeof appState) => {
      Object.assign(appState, updater(appState))
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as never
}

async function runRealToolUse(
  tool: typeof FileReadTool | typeof FileWriteTool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<unknown[]> {
  const updates: unknown[] = []
  for await (const _update of runToolUse(
    {
      type: 'tool_use',
      id: `toolu-${tool.name}`,
      name: tool.name,
      input,
      caller: { type: 'direct' },
    },
    createAssistantMessage({ content: [] }),
    async (_tool, authorizedInput) => ({
      behavior: 'allow',
      updatedInput: authorizedInput,
    }),
    context,
  )) {
    updates.push(_update.message)
    // Drain the real lifecycle to complete tool validation, permission, and call.
  }
  return updates
}

describe('missing-file exact function recovery', () => {
  function fixture(name: string, source = 'export function TasksStrip() {\n  return <div />\n}') {
    const directory = join(tmpDir, `function-recovery-${name}`)
    mkdirSync(directory)
    const actual = join(realpathSync(directory), 'App.tsx')
    const requested = join(directory, 'TasksStrip.tsx')
    writeFileSync(actual, `const before = 1;\n${source}\nconst after = 2;\n`)
    const context = createLifecycleContext([FileReadTool, FileWriteTool]) as ToolUseContext
    ;(context as unknown as {
      getAppState(): {
        toolPermissionContext: { additionalWorkingDirectories: Map<string, string> }
      }
    }).getAppState().toolPermissionContext.additionalWorkingDirectories.set(directory, directory)
    return { directory, actual, requested, context }
  }

  async function recover(
    entry: ReturnType<typeof fixture>,
    extra: { offset?: number; limit?: number; pages?: string } = {},
  ) {
    return runWithCwdOverride(entry.directory, () =>
      callFileReadToolWithPreparedCapability(
        { file_path: entry.requested, ...extra },
        entry.context,
      ),
    )
  }

  test('returns only the complete exact function with real path and lines', async () => {
    const entry = fixture('success')
    const result = await recover(entry)
    expect(result.data.type).toBe('text')
    const data = result.data as Extract<Output, { type: 'text' }>
    expect(data.file).toEqual({
      filePath: entry.actual,
      content: 'export function TasksStrip() {\n  return <div />\n}',
      startLine: 2,
      numLines: 3,
      totalLines: 6,
      functionResolution: {
        requestedPath: entry.requested,
        symbol: 'TasksStrip',
        endLine: 4,
      },
    })
    const rendered = formatFileReadTextForModel(data)
    expect(rendered.split('\n').slice(0, 4)).toEqual([
      `Requested file not found: ${JSON.stringify(entry.requested)}`,
      'Returned complete function: TasksStrip',
      `Source: ${JSON.stringify(entry.actual)}, lines 2–4`,
      'The rest of the file is not included.',
    ])
    expect(rendered).not.toContain('const before')
    expect(rendered).not.toContain('const after')
    expect(FileReadTool.outputSchema.safeParse(data).success).toBe(true)
    expect(existsSync(entry.requested)).toBe(false)
  })

  test('an existing requested file takes priority and keeps ordinary text output', async () => {
    const entry = fixture('existing')
    writeFileSync(entry.requested, 'normal requested contents\n')
    const result = await recover(entry)
    const data = result.data as Extract<Output, { type: 'text' }>
    expect(data.file.content).toBe('normal requested contents\n')
    expect(data.file.functionResolution).toBeUndefined()
    expect(data.file.filePath).toBe(entry.requested)
  })

  test.each([
    { offset: 0 },
    { offset: 1 },
    { offset: 3 },
    { limit: 10 },
    { pages: '1' },
  ])('does not reinterpret original range or page parameters: %j', async extra => {
    const entry = fixture(`range-${JSON.stringify(extra)}`)
    await expect(recover(entry, extra)).rejects.toThrow('File does not exist.')
  })

  test('ambiguous definitions in separate direct files keep the missing-file error', async () => {
    const entry = fixture('ambiguous-files')
    writeFileSync(join(entry.directory, 'Other.tsx'), 'const TasksStrip = () => <div />;')
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('ambiguous definitions in a single file keep the missing-file error', async () => {
    const entry = fixture('ambiguous-symbol', 'function TasksStrip() {}\n{\nconst TasksStrip = () => 42;\n}')
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('does not guess prefixes or factory names', async () => {
    const entry = fixture('no-fuzzy', 'function createModelCallRecorder() {}')
    entry.requested = join(entry.directory, 'modelCallRecorder.ts')
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('does not search subdirectories or parent directories', async () => {
    const entry = fixture('local-scope', 'function Unrelated() {}')
    mkdirSync(join(entry.directory, 'nested'))
    writeFileSync(join(entry.directory, 'nested', 'Nested.ts'), 'function TasksStrip() {}')
    writeFileSync(join(tmpDir, 'Outside.ts'), 'function TasksStrip() {}')
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test.each(['TasksStrip.py', 'TasksStrip.txt', 'TasksStrip.test.tsx', 'TasksStrip.d.ts'])(
    'unsupported requested names/formats retain missing-file behavior: %s',
    async name => {
      const entry = fixture(`unsupported-${name}`)
      entry.requested = join(entry.directory, name)
      await expect(recover(entry)).rejects.toThrow('File does not exist.')
    },
  )

  test.each(['alwaysDenyRules', 'alwaysAskRules'] as const)(
    'checks the containing file %s before reading its contents',
    async rules => {
      const entry = fixture(`permissions-${rules}`)
      const state = (entry.context as unknown as {
        getAppState(): {
          toolPermissionContext: Record<string, unknown>
        }
      }).getAppState()
      state.toolPermissionContext[rules] = {
        session: [`Read(//${entry.actual.replace(/^\/+/, '')})`],
      }
      await expect(recover(entry)).rejects.toThrow('File does not exist.')
      expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
    },
  )

  test('an approval for a missing path outside working directories does not approve its source', async () => {
    const entry = fixture('missing-only-approval')
    ;(entry.context as unknown as {
      getAppState(): {
        toolPermissionContext: { additionalWorkingDirectories: Map<string, string> }
      }
    }).getAppState().toolPermissionContext.additionalWorkingDirectories.clear()
    await expect(
      callFileReadToolWithPreparedCapability(
        { file_path: entry.requested },
        entry.context,
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        undefined,
        { userMentioned: true },
      ),
    ).rejects.toThrow('File does not exist.')
  })

  test('skips denied definitions when establishing uniqueness among permitted files', async () => {
    const entry = fixture('permitted-unique')
    writeFileSync(join(entry.directory, 'Denied.tsx'), 'function TasksStrip() {}')
    const state = (entry.context as unknown as {
      getAppState(): { toolPermissionContext: { alwaysDenyRules: Record<string, string[]> } }
    }).getAppState()
    state.toolPermissionContext.alwaysDenyRules = {
      session: [`Read(//${join(entry.directory, 'Denied.tsx').replace(/^\/+/, '')})`],
    }
    expect((await recover(entry)).data.type).toBe('text')
  })

  test('does not follow a sibling symlink to source outside the requested directory', async () => {
    const entry = fixture('sibling-symlink', 'function Unrelated() {}')
    const outside = join(tmpDir, 'SymlinkOutside.ts')
    writeFileSync(outside, 'function TasksStrip() {}')
    symlinkSync(outside, join(entry.directory, 'Link.ts'))
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('does not resolve through an ancestor symlink retargeted after preparation', async () => {
    const entry = fixture('ancestor-swap')
    const outside = join(tmpDir, 'function-recovery-ancestor-outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'App.tsx'), 'function TasksStrip() { return "outside"; }')
    entry.context.getAppState().toolPermissionContext.additionalWorkingDirectories.set(
      outside,
      outside,
    )
    const alias = join(tmpDir, 'function-recovery-ancestor-alias')
    symlinkSync(entry.directory, alias)
    entry.context.getAppState().toolPermissionContext.additionalWorkingDirectories.set(
      alias,
      alias,
    )
    const input = { file_path: join(alias, 'TasksStrip.tsx') }
    const prepared = await FileReadTool.prepareExecution!(input)
    const context = {
      ...entry.context,
      preparedExecution: {
        toolName: FileReadTool.name,
        input,
        state: prepared.state,
      },
    }
    try {
      expect((await FileReadTool.checkPermissions(input, context)).behavior).toBe('allow')
      unlinkSync(alias)
      symlinkSync(outside, alias)
      await expect(FileReadTool.call(input, context)).rejects.toThrow('File does not exist.')
      expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
    } finally {
      await prepared.cleanup()
    }
  })

  test('rechecks a matched source identity after completing the directory scan', async () => {
    const entry = fixture('source-changes-during-scan')
    writeFileSync(join(entry.directory, 'Other.ts'), 'function Other() {}')
    const input = { file_path: entry.requested }
    const prepared = await FileReadTool.prepareExecution!(input)
    const context = {
      ...entry.context,
      preparedExecution: {
        toolName: FileReadTool.name,
        input,
        state: prepared.state,
      },
    }
    const state = prepared.state as { readSiblingNames(): Promise<string[]> }
    state.readSiblingNames = async () => ['App.tsx', 'Other.ts']
    const controller = (entry.context as unknown as ReturnType<typeof createContext>).abortController
    let iteration = 0
    controller.signal.throwIfAborted = () => {
      if (++iteration === 2) {
        writeFileSync(entry.actual, 'function TasksStrip() { return "changed"; }\n')
      }
    }
    try {
      await expect(FileReadTool.call(input, context)).rejects.toThrow('File does not exist.')
      expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
    } finally {
      await prepared.cleanup()
    }
  })

  test('does not resolve if a previously nonmatching source changes after its scan', async () => {
    const entry = fixture('new-ambiguity-during-scan')
    const other = join(entry.directory, 'Other.ts')
    writeFileSync(other, 'function Other() {}')
    const input = { file_path: entry.requested }
    const prepared = await FileReadTool.prepareExecution!(input)
    const context = {
      ...entry.context,
      preparedExecution: {
        toolName: FileReadTool.name,
        input,
        state: prepared.state,
      },
    }
    let listings = 0
    const state = prepared.state as { readSiblingNames(): Promise<string[]> }
    state.readSiblingNames = async () => {
      if (++listings === 2) {
        writeFileSync(other, 'function TasksStrip() {}\n')
      }
      return ['App.tsx', 'Other.ts']
    }
    try {
      await expect(FileReadTool.call(input, context)).rejects.toThrow('File does not exist.')
      expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
    } finally {
      await prepared.cleanup()
    }
  })

  test('keeps a complete function-only view partial even when it occupies the whole file', async () => {
    const entry = fixture('partial-authority')
    const original = 'function TasksStrip() {}\n'
    writeFileSync(entry.actual, original)
    const updates = await runWithCwdOverride(entry.directory, () =>
      runRealToolUse(FileReadTool, { file_path: entry.requested }, entry.context),
    )
    expect(JSON.stringify(updates)).toContain('Returned complete function: TasksStrip')
    const cache = (entry.context as unknown as ReturnType<typeof createContext>).readFileState
    expect(cache.has(entry.requested)).toBe(false)
    expect(cache.get(entry.actual)?.isPartialView).toBe(true)
    expect(cache.get(entry.actual)?.isWriteAuthorizedRead).toBe(true)
    expect(isCompleteUnboundedRead(cache.get(entry.actual))).toBe(false)
    const deleteInput = {
      input: `*** Begin Patch\n*** Delete File: ${entry.actual}\n*** End Patch\n`,
    }
    const deletion = await FilePatchTool.prepareExecution!(deleteInput)
    try {
      const validation = await FilePatchTool.validateInput(deleteInput, {
        ...entry.context,
        preparedExecution: {
          toolName: FilePatchTool.name,
          input: deleteInput,
          state: deletion.state,
        },
      } as never)
      expect(validation.result).toBe(false)
      expect(validation.message).toContain('complete, unbounded model-visible Read')
    } finally {
      await deletion.cleanup()
    }
    await runWithCwdOverride(entry.directory, () =>
      runRealToolUse(FileWriteTool, { file_path: entry.actual, content: 'replaced\n' }, entry.context),
    )
    expect(readFileSync(entry.actual, 'utf8')).toBe(original)
    const normal = await runWithCwdOverride(entry.directory, () =>
      callFileReadToolWithPreparedCapability({ file_path: entry.actual }, entry.context),
    )
    expect(normal.data.type).toBe('text')
    expect((normal.data as Extract<Output, { type: 'text' }>).file.functionResolution).toBeUndefined()
  })

  test('refuses oversized recovery rather than returning an incomplete function', async () => {
    const entry = fixture('bounded-function')
    Object.assign(entry.context, { fileReadingLimits: { maxTokens: 100 } })
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
    expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
  })

  test('refuses recovery when the returned definition cannot fit the byte allowance', async () => {
    const entry = fixture('bounded-source')
    Object.assign(entry.context, { fileReadingLimits: { maxSizeBytes: 10 } })
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('refuses line-capped definitions instead of mislabeling a prefix as complete', async () => {
    const entry = fixture(
      'bounded-lines',
      `function TasksStrip() {\n${'  // body\n'.repeat(MAX_LINES_TO_READ)}  return 1;\n}`,
    )
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
    expect((entry.context as unknown as ReturnType<typeof createContext>).readFileState.size).toBe(0)
  })

  test('does not claim uniqueness when the number of local sources exceeds the scan bound', async () => {
    const entry = fixture('bounded-source-count')
    for (let index = 0; index < 1000; index++) {
      writeFileSync(join(entry.directory, `Other${index}.ts`), 'function Other() {}')
    }
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('recovers in a renderer-sized directory with a large nonmatching source', async () => {
    const entry = fixture('renderer-scale')
    for (let index = 0; index < 450; index++) {
      writeFileSync(
        join(entry.directory, `Other${index}.ts`),
        `// ${'source context '.repeat(900)}\nexport const other${index} = 1;\n`,
      )
    }
    writeFileSync(join(entry.directory, 'Large.tsx'), `// ${'x'.repeat(280_000)}\n`)
    const data = (await recover(entry)).data as Extract<Output, { type: 'text' }>
    expect(data.file.filePath).toBe(entry.actual)
    expect(data.file.functionResolution?.symbol).toBe('TasksStrip')
  })

  test('keeps recovery bounded when a sibling is too large to establish uniqueness', async () => {
    const entry = fixture('oversized-sibling')
    writeFileSync(join(entry.directory, 'Large.ts'), `// ${'x'.repeat(512 * 1024)}\n`)
    await expect(recover(entry)).rejects.toThrow('File does not exist.')
  })

  test('uses the large-context budget for complete recovered definitions', async () => {
    const definition = `function TasksStrip() {\n${'  // body context\n'.repeat(1_800)}  return 1;\n}`
    const entry = fixture('large-context-definition', definition)
    entry.context.options.mainLoopModel = 'gpt-6.1-sol'
    const data = (await recover(entry)).data as Extract<Output, { type: 'text' }>
    expect(data.file.content).toBe(definition)
    expect(Buffer.byteLength(formatFileReadTextForModel(data))).toBeGreaterThan(25_000)
    expect(isCompleteUnboundedRead(entry.context.readFileState.get(entry.actual))).toBe(false)
  })
})

describe('user-mentioned FileRead permissions', () => {
  test('allows explicit mentions outside the working directory in default and bypass modes', async () => {
    const workspace = join(tmpDir, 'mentioned-workspace')
    mkdirSync(workspace, { recursive: true })
    const filePath = writeLines('mentioned-outside.txt', 1)

    await runWithCwdOverride(workspace, async () => {
      for (const mode of ['default', 'bypassPermissions'] as const) {
        const context = createLifecycleContext([FileReadTool], { mode })
        const result = await callFileReadToolWithPreparedCapability(
          { file_path: filePath },
          context as never,
          async () => ({ behavior: 'allow' }) as never,
          undefined,
          { userMentioned: true },
        )
        expect(result.data.type).toBe('text')
      }
    })
  })

  test('retains explicit deny and ask rules for mentioned paths', async () => {
    const filePath = writeLines('mentioned-restricted.txt', 1)
    const absoluteRulePath = `//${filePath.replace(/^\/+/, '')}`
    for (const [ruleKey, rules] of [
      ['alwaysDenyRules', { session: [`Read(${absoluteRulePath})`] }],
      ['alwaysAskRules', { session: [`Read(${absoluteRulePath})`] }],
      ['alwaysDenyRules', { session: ['Read'] }],
      ['alwaysAskRules', { session: ['Read'] }],
    ] as const) {
      const context = createLifecycleContext([FileReadTool], {
        mode: 'bypassPermissions',
        [ruleKey]: rules,
      })
      await expect(
        callFileReadToolWithPreparedCapability(
          { file_path: filePath },
          context as never,
          async () => ({ behavior: 'allow' }) as never,
          undefined,
          { userMentioned: true },
        ),
      ).rejects.toThrow()
    }
  })

  test('checks canonical symlink targets and keeps ordinary helper reads restricted', async () => {
    const workspace = join(tmpDir, 'symlink-workspace')
    mkdirSync(workspace, { recursive: true })
    const target = writeLines('symlink-target.txt', 1)
    const link = join(workspace, 'mentioned-link.txt')
    symlinkSync(target, link)
    const absoluteTargetRule = `//${target.replace(/^\/+/, '')}`

    await runWithCwdOverride(workspace, async () => {
      const restrictedContext = createLifecycleContext([FileReadTool], {
        mode: 'default',
        alwaysDenyRules: { session: [`Read(${absoluteTargetRule})`] },
      })
      await expect(
        callFileReadToolWithPreparedCapability(
          { file_path: link },
          restrictedContext as never,
          async () => ({ behavior: 'allow' }) as never,
          undefined,
          { userMentioned: true },
        ),
      ).rejects.toThrow()

      const ordinaryContext = createLifecycleContext([FileReadTool], {
        mode: 'bypassPermissions',
      })
      await expect(
        callFileReadToolWithPreparedCapability(
          { file_path: target },
          ordinaryContext as never,
          async () => ({ behavior: 'allow' }) as never,
        ),
      ).rejects.toThrow()
    })
  })
})

async function readWith(
  context: ReturnType<typeof createContext>,
  filePath: string,
  input: { offset?: number; limit?: number } = {},
): Promise<Extract<Output, { type: 'text' }>> {
  const toolInput = { file_path: filePath, ...input }
  const result = await callPrepared(context, toolInput)
  const data = result.data as Output
  if (data.type !== 'text') throw new Error(`expected text, got ${data.type}`)
  return data
}

async function callPrepared(
  context: ReturnType<typeof createContext>,
  toolInput: { file_path: string; offset?: number; limit?: number },
  parentMessage?: ReturnType<typeof createAssistantMessage>,
) {
  const prepared = await FileReadTool.prepareExecution!(toolInput as never)
  Object.assign(context, {
    preparedExecution: {
      toolName: FileReadTool.name,
      input: toolInput,
      state: prepared.state,
    },
  })
  try {
    return await FileReadTool.call(
      toolInput as never,
      context as never,
      undefined,
      parentMessage,
    )
  } finally {
    await prepared.cleanup()
  }
}

async function readFile(
  filePath: string,
  input: { offset?: number; limit?: number } = {},
): Promise<Extract<Output, { type: 'text' }>['file']> {
  return (await readWith(createContext(), filePath, input)).file
}

describe('default line limit', () => {
  test('PreToolUse allow cannot redirect a prepared Write through a changed symlink', async () => {
    const allowed = join(tmpDir, 'hook-allowed.txt')
    const outside = join(tmpDir, 'hook-outside.txt')
    const alias = join(tmpDir, 'hook-write-link.txt')
    const marker = join(tmpDir, 'hook-ran.txt')
    writeFileSync(allowed, 'authorized target\n')
    writeFileSync(outside, 'outside marker\n')
    symlinkSync(allowed, alias)
    const context = createLifecycleContext([FileReadTool, FileWriteTool])
    const previousSimple = process.env.CLAUDE_CODE_SIMPLE
    const previousHistory = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    process.env.CLAUDE_CODE_SIMPLE = '1'
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    try {
      await runRealToolUse(FileReadTool, { file_path: alias }, context)
      preToolUseTestHook = () => {
        unlinkSync(alias)
        symlinkSync(outside, alias)
        writeFileSync(marker, 'hook ran')
      }
      const updates = await runRealToolUse(
        FileWriteTool,
        { file_path: alias, content: 'write through prepared object\n' },
        context,
      )
      expect(existsSync(marker), JSON.stringify(updates)).toBe(true)
      expect(readFileSync(allowed, 'utf8')).toBe(
        'write through prepared object\n',
      )
      expect(readFileSync(outside, 'utf8')).toBe('outside marker\n')
    } finally {
      preToolUseTestHook = undefined
      if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = previousSimple
      if (previousHistory === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
      } else {
        process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = previousHistory
      }
    }
  })

  test('real Read then Write lifecycle rejects a retargeted symlink', async () => {
    const allowed = join(tmpDir, 'lifecycle-read-target.txt')
    const outside = join(tmpDir, 'lifecycle-outside-target.txt')
    const alias = join(tmpDir, 'lifecycle-write-link.txt')
    writeFileSync(allowed, 'read before swap\n')
    writeFileSync(outside, 'outside marker\n')
    symlinkSync(allowed, alias)
    const context = createLifecycleContext([FileReadTool, FileWriteTool])
    const previousSimple = process.env.CLAUDE_CODE_SIMPLE
    const previousHistory = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    process.env.CLAUDE_CODE_SIMPLE = '1'
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'

    try {
      await runRealToolUse(FileReadTool, { file_path: alias }, context)
      const readState = (
        context as unknown as {
          readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>
        }
      ).readFileState.get(alias)
      expect(isCompleteUnboundedRead(readState)).toBe(true)
      expect(readState?.fileIdentity?.canonicalPath).toBe(
        getFileIdentity(allowed).canonicalPath,
      )

      unlinkSync(alias)
      symlinkSync(outside, alias)
      await runRealToolUse(
        FileWriteTool,
        { file_path: alias, content: 'must not reach outside\n' },
        context,
      )
      expect(readFileSync(allowed, 'utf8')).toBe('read before swap\n')
      expect(readFileSync(outside, 'utf8')).toBe('outside marker\n')
    } finally {
      if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
      else process.env.CLAUDE_CODE_SIMPLE = previousSimple
      if (previousHistory === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
      } else {
        process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = previousHistory
      }
    }
  })

  test('reads the intentionally safe null device as an empty file', async () => {
    const result = await readWith(createContext(), '/dev/null')
    expect(result.file.content).toBe('')
  })

  test('a missing prepared path keeps the similar-file suggestion', async () => {
    writeLines('missing-neighbor.ts', 1)
    await expect(
      readWith(createContext(), join(tmpDir, 'missing-neighbor.js')),
    ).rejects.toThrow('missing-neighbor.ts')
  })

  test('a missing screenshot path still reads its space-variant alternate', async () => {
    const requested = join(tmpDir, 'Screenshot 1 PM.png')
    const alternate = join(tmpDir, `Screenshot 1${String.fromCharCode(8239)}PM.png`)
    writeFileSync(
      alternate,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=',
        'base64',
      ),
    )

    const input = { file_path: requested }
    const context = createContext()
    const prepared = await FileReadTool.prepareExecution!(input as never)
    Object.assign(context, {
      preparedExecution: {
        toolName: FileReadTool.name,
        input,
        state: prepared.state,
      },
    })
    try {
      const result = await FileReadTool.call(input as never, context as never)
      expect((result.data as Output).type).toBe('image')
    } finally {
      await prepared.cleanup()
    }
  })

  test('prepared reads survive repeated ancestor symlink swaps', async () => {
    const allowed = join(tmpDir, 'read-allowed')
    const outside = join(tmpDir, 'read-outside')
    const ancestor = join(tmpDir, 'read-parent-link')
    mkdirSync(allowed)
    mkdirSync(outside)
    writeFileSync(join(allowed, 'target.txt'), 'authorized bytes\n')
    writeFileSync(join(outside, 'target.txt'), 'outside marker\n')
    symlinkSync('target.txt', join(allowed, 'target-link.txt'))
    symlinkSync(allowed, ancestor)

    for (let index = 0; index < 16; index++) {
      const context = createContext()
      const input = { file_path: join(ancestor, 'target-link.txt') }
      const prepared = await FileReadTool.prepareExecution!(input as never)
      Object.assign(context, {
        preparedExecution: {
          toolName: FileReadTool.name,
          input,
          state: prepared.state,
        },
      })
      try {
        unlinkSync(ancestor)
        symlinkSync(outside, ancestor)
        unlinkSync(join(allowed, 'target-link.txt'))
        symlinkSync(join(outside, 'target.txt'), join(allowed, 'target-link.txt'))
        const result = await FileReadTool.call(input as never, context as never)
        expect((result.data as Extract<Output, { type: 'text' }>).file.content).toBe(
          'authorized bytes\n',
        )
      } finally {
        await prepared.cleanup()
      }
      unlinkSync(ancestor)
      symlinkSync(allowed, ancestor)
      unlinkSync(join(allowed, 'target-link.txt'))
      symlinkSync('target.txt', join(allowed, 'target-link.txt'))
    }
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe(
      'outside marker\n',
    )
  })

  test('a no-limit read stops at MAX_LINES_TO_READ', async () => {
    const filePath = writeLines('long.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })

    const file = await readFile(filePath)

    // Before the clamp existed this returned every line, so the read only
    // discovered it had blown maxTokens after paying for the whole file.
    expect(file.numLines).toBe(MAX_LINES_TO_READ)
    expect(file.content.endsWith('x')).toBe(true)
    // +1: readFileInRange counts a phantom empty line for the trailing
    // newline. Pre-existing, and why the notice cannot derive truncation
    // from these totals.
    expect(file.totalLines).toBe(MAX_LINES_TO_READ + 500 + 1)
  })

  test('an explicit limit still wins over the default', async () => {
    const filePath = writeLines('long-explicit.txt', MAX_LINES_TO_READ + 500)

    const file = await readFile(filePath, { limit: 10 })

    expect(file.numLines).toBe(10)
  })

  test('a file shorter than the default is returned whole', async () => {
    const filePath = writeLines('short.txt', 12, { trailingNewline: false })

    const file = await readFile(filePath)

    expect(file.numLines).toBe(12)
    expect(file.totalLines).toBe(12)
    expect(file.content.endsWith('line 12')).toBe(true)
  })
})

describe('partial read notice', () => {
  function render(data: Extract<Output, { type: 'text' }>): string {
    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    return typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content)
  }

  async function renderRead(
    filePath: string,
    input: { offset?: number; limit?: number } = {},
  ): Promise<string> {
    return render(await readWith(createContext(), filePath, input))
  }

  test('a clamped read is marked partial and names the next offset', async () => {
    const filePath = writeLines('notice.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })

    const rendered = await renderRead(filePath)

    // Without this the model sees 2000 numbered lines and no signal that the
    // file continues, so it concludes it read the whole thing.
    expect(rendered).toContain('partial view')
    expect(rendered).toContain(`offset ${MAX_LINES_TO_READ + 1}`)
  })

  test('a complete read carries no notice', async () => {
    const filePath = writeLines('complete.txt', 12)

    expect(await renderRead(filePath)).not.toContain('partial view')
  })

  test('a range ending exactly at the last line carries no notice', async () => {
    const filePath = writeLines('exact.txt', 12)

    const rendered = await renderRead(filePath, { offset: 3, limit: 10 })

    expect(rendered).not.toContain('partial view')
  })

  test('a file of exactly the cap length is not called partial', async () => {
    // The trailing newline makes readFileInRange report totalLines = 2001, so
    // deriving truncation from the line totals alone claims a 2001st line the
    // model can never read.
    const filePath = writeLines('exactly-cap.txt', MAX_LINES_TO_READ, {
      compact: true,
    })

    const rendered = await renderRead(filePath)

    expect(rendered).not.toContain('partial view')
  })

  test('a real line beyond the cap is still called partial', async () => {
    const filePath = writeLines('cap-plus-one.txt', MAX_LINES_TO_READ + 1, {
      trailingNewline: false,
      compact: true,
    })

    const rendered = await renderRead(filePath)

    expect(rendered).toContain('partial view')
  })
})

describe('truncated reads are not proof the file was read', () => {
  test('a clamped read records isTruncatedView', async () => {
    const filePath = writeLines('write-gate.txt', MAX_LINES_TO_READ + 500, {
      compact: true,
    })
    const context = createContext()

    await readWith(context, filePath)

    // FileWriteTool rejects on this flag: a write replaces the whole file, so
    // having seen only its head must not satisfy the read-before-write gate.
    expect(context.readFileState.get(filePath)?.isTruncatedView).toBe(true)
  })

  test('a complete read does not', async () => {
    const filePath = writeLines('write-gate-full.txt', 12)
    const context = createContext()

    await readWith(context, filePath)

    expect(context.readFileState.get(filePath)?.isTruncatedView).toBeUndefined()
  })

  test('an explicit range does not, since the caller chose it', async () => {
    const filePath = writeLines('write-gate-explicit.txt', 500)
    const context = createContext()

    await readWith(context, filePath, { limit: 10 })

    expect(context.readFileState.get(filePath)?.isTruncatedView).toBeUndefined()
  })
})

describe('byte cap applies only to no-limit reads', () => {
  // 300 KB spread over many short lines, so a small explicit range stays well
  // under maxTokens and the byte cap is the only thing under test.
  function writeOversizedFile(name: string): string {
    const filePath = join(tmpDir, name)
    const line = 'x'.repeat(99)
    writeFileSync(filePath, `${line}\n`.repeat(3200), 'utf-8')
    return filePath
  }

  test('an explicit range reads a file past the byte cap', async () => {
    // This bypass is what makes huge files (session transcripts) readable at
    // all, and the line clamp had to leave it intact, so it is pinned here.
    const file = await readFile(writeOversizedFile('huge.txt'), { limit: 5 })

    expect(file.numLines).toBe(5)
  })

  test('a no-limit read of the same file still throws pre-read', async () => {
    const filePath = writeOversizedFile('huge-nolimit.txt')

    await expect(readFile(filePath)).rejects.toThrow(/exceeds maximum/i)
  })
})

describe('prompt steers the model to targeted ranges', () => {
  test('the default prompt asks for the needed range, not the whole file', async () => {
    // GrowthBook is inert in this fork, so this arm is a hardcoded default. A
    // future upstream merge of limits.ts is what would silently revert it.
    const prompt = await FileReadTool.prompt()

    expect(prompt).toContain(OFFSET_INSTRUCTION_TARGETED)
    expect(prompt).not.toContain('recommended to read the whole file')
  })

  test('the offset and limit parameter text agrees with that prompt', () => {
    // These two descriptions used to say "only provide if the file is too
    // large to read at once", which told the model the opposite of both
    // OFFSET_INSTRUCTION_TARGETED and the system prompt's READ DISCIPLINE.
    const shape = FileReadTool.inputSchema.shape
    const offset = shape.offset.description ?? ''
    const limit = shape.limit.description ?? ''

    expect(offset).not.toContain('Only provide if the file is too large')
    expect(limit).not.toContain('Only provide if the file is too large')
    expect(offset).toContain('when you already know which part of the file')
    expect(limit).toContain('when you already know how much of the file')
  })
})

describe('suggestedRetryLimit', () => {
  test('scales the line count down by the token overshoot', () => {
    // 1000 lines cost 50k tokens against a 25k cap, so about half fit, less
    // the 10% headroom.
    expect(suggestedRetryLimit(1000, 25_000, 50_000)).toBe(450)
  })

  test('returns 0 when even one line cannot fit', () => {
    // A minified bundle: one line, far over the cap. Suggesting limit 1 would
    // send the model back into the identical failure.
    expect(suggestedRetryLimit(1, 25_000, 125_000)).toBe(0)
  })

  test('returns 0 for a degenerate range instead of dividing by zero', () => {
    expect(suggestedRetryLimit(0, 25_000, 50_000)).toBe(0)
    expect(suggestedRetryLimit(10, 25_000, 0)).toBe(0)
  })
})

describe('MaxFileReadTokenExceededError', () => {
  test('names a concrete retry range when the line range is known', () => {
    const error = new MaxFileReadTokenExceededError(50_000, 25_000, {
      startLine: 1,
      totalLines: 8_000,
      suggestedLimit: 900,
    })

    expect(error.message).toContain('8000 lines')
    expect(error.message).toContain('offset 1')
    expect(error.message).toContain('limit 900')
  })

  test('falls back to generic advice without a line range', () => {
    const error = new MaxFileReadTokenExceededError(50_000, 25_000)

    expect(error.message).toContain('offset and limit')
    expect(error.tokenCount).toBe(50_000)
    expect(error.maxTokens).toBe(25_000)
  })
})

describe('token overflow prefixes', () => {
  test('a large-context model receives the complete requested document range', async () => {
    const filePath = join(tmpDir, 'large-context-map.txt')
    const lines = Array.from({ length: 245 }, (_, index) =>
      `| ${index + 1} | ${'owner and routing notes '.repeat(11)} |`,
    )
    writeFileSync(filePath, lines.join('\n'), 'utf-8')
    const context = Object.assign(createContext(), {
      options: { mainLoopModel: 'gpt-6.1-sol' },
    })
    const data = await readWith(context, filePath, { offset: 1, limit: 160 })
    expect(data.file.numLines).toBe(160)
    expect(data.file.content).toBe(lines.slice(0, 160).join('\n'))
    expect(Buffer.byteLength(formatFileReadTextForModel(data))).toBeGreaterThan(25_000)
    expect(context.readFileState.get(filePath)?.isTruncatedView).toBeUndefined()
  })

  test('overflow on a large-context model retains a substantial bounded prefix', async () => {
    const filePath = join(tmpDir, 'large-context-overflow.txt')
    writeFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(1_000), 'utf-8')
    const context = Object.assign(createContext(), {
      options: { mainLoopModel: 'gpt-6.1-sol' },
    })
    const data = await readWith(context, filePath)
    const renderedBytes = Buffer.byteLength(formatFileReadTextForModel(data))
    expect(renderedBytes).toBeGreaterThan(80_000)
    expect(renderedBytes).toBeLessThanOrEqual(100_000)
    expect(context.readFileState.get(filePath)?.isTruncatedView).toBe(true)
  })

  test('a narrower explicit budget still limits a large-context model', async () => {
    const filePath = join(tmpDir, 'large-context-override.txt')
    writeFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(300), 'utf-8')
    const context = Object.assign(createContext(4_000), {
      options: { mainLoopModel: 'gpt-6.1-sol' },
    })
    const data = await readWith(context, filePath)
    expect(Buffer.byteLength(formatFileReadTextForModel(data))).toBeLessThanOrEqual(4_000)
    expect(context.readFileState.get(filePath)?.isTruncatedView).toBe(true)
  })

  test('an operator-narrowed context also narrows the live text read', async () => {
    const previous = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '64000'
    try {
      const filePath = join(tmpDir, 'large-context-clamped.txt')
      writeFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(300), 'utf-8')
      const context = Object.assign(createContext(), {
        options: { mainLoopModel: 'gpt-6.1-sol' },
      })
      const data = await readWith(context, filePath)
      expect(Buffer.byteLength(formatFileReadTextForModel(data))).toBeLessThanOrEqual(8_000)
      expect(context.readFileState.get(filePath)?.isTruncatedView).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = previous
    }
  })

  test('returns a complete-line prefix with continuation and search guidance', async () => {
    const filePath = join(tmpDir, 'token-prefix.txt')
    writeFileSync(filePath, `${'x'.repeat(100)}\n`.repeat(100), 'utf-8')

    const data = await readWith(createContext(1_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''

    expect(data.file.numLines).toBeLessThan(100)
    expect(data.file.content.endsWith('\n')).toBe(false)
    expect(text).toContain('partial view')
    expect(text).toContain('offset ')
    expect(text).toContain('Search for specific content')
  })

  test('still errors when one complete line cannot fit', async () => {
    const filePath = join(tmpDir, 'token-single-line.txt')
    writeFileSync(filePath, 'x'.repeat(20_000), 'utf-8')

    await expect(readWith(createContext(1_000), filePath)).rejects.toBeInstanceOf(
      MaxFileReadTokenExceededError,
    )
  })

  test('keeps a small first line when a much larger later line overflows', async () => {
    const filePath = join(tmpDir, 'token-skewed-lines.txt')
    writeFileSync(filePath, `ok\n${'x'.repeat(20_000)}`, 'utf-8')

    const data = await readWith(createContext(1_000), filePath)

    expect(data.file.content).toBe('ok')
    expect(data.file.numLines).toBe(1)
  })

  test('budgets line-number gutters as part of the returned prefix', async () => {
    const filePath = join(tmpDir, 'token-line-gutters.txt')
    writeFileSync(filePath, `${'x'}\n`.repeat(500), 'utf-8')

    const data = await readWith(createContext(1_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''

    expect(data.file.numLines).toBeLessThan(500)
    expect(text).toContain('partial view')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000)
  })

  test('keeps the rendered overflow prefix below the hard cap', async () => {
    const filePath = join(tmpDir, 'token-hard-cap.txt')
    writeFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(1_000), 'utf-8')

    // Without a known model, a larger override cannot lift the fallback budget.
    const data = await readWith(createContext(50_000), filePath)
    const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
      data,
      'toolu-file-read',
    )
    const text = typeof rendered.content === 'string' ? rendered.content : ''
    expect(data.file.numLines).toBeLessThan(1_000)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      DEFAULT_MAX_OUTPUT_TOKENS,
    )
  })
})

describe('read deduplication follows file identity', () => {
  const sameMtime = new Date('2026-01-01T00:00:00.000Z')

  function writeVersion(name: string, content: string): string {
    const filePath = join(tmpDir, name)
    writeFileSync(filePath, content, 'utf-8')
    utimesSync(filePath, sameMtime, sameMtime)
    return filePath
  }

  test('an unchanged file still returns the compact cached-read result', async () => {
    const filePath = writeVersion('dedup-unchanged.txt', 'original')
    const context = createContext()
    await readWith(context, filePath)

    const result = await callPrepared(context, { file_path: filePath })

    expect(result.data.type).toBe('file_unchanged')
  })

  test('a same-size replacement with the same mtime returns its new contents', async () => {
    const filePath = writeVersion('dedup-replaced.txt', 'original')
    const replacement = writeVersion('dedup-replacement.txt', 'modified')
    const context = createContext()
    await readWith(context, filePath)
    renameSync(replacement, filePath)

    const result = await readWith(context, filePath)

    expect(result.file.content).toBe('modified')
    expect(context.readFileState.get(filePath)?.fileIdentity).toEqual(
      getFileIdentity(filePath),
    )
  })

  test('a same-mtime symlink retarget returns the newly addressed file', async () => {
    const first = writeVersion('dedup-first.txt', 'original')
    const second = writeVersion('dedup-second.txt', 'modified')
    const link = join(tmpDir, 'dedup-link.txt')
    symlinkSync(first, link)
    const context = createContext()
    await readWith(context, link)
    unlinkSync(link)
    symlinkSync(second, link)

    const result = await readWith(context, link)

    expect(result.file.content).toBe('modified')
    expect(context.readFileState.get(link)?.fileIdentity?.canonicalPath).toBe(
      getFileIdentity(second).canonicalPath,
    )
  })

  test('a cached read without a stable identity is read again', async () => {
    const filePath = writeVersion('dedup-no-identity.txt', 'original')
    const context = createContext()
    await readWith(context, filePath)
    delete context.readFileState.get(filePath)!.fileIdentity

    const result = await readWith(context, filePath)

    expect(result.file.content).toBe('original')
    expect(context.readFileState.get(filePath)?.fileIdentity).toEqual(
      getFileIdentity(filePath),
    )
  })
})

describe('whole-file Write authorization provenance', () => {
  test('internal reads do not authorize Write, but model-visible reads do', async () => {
    const filePath = writeLines('authorization.txt', 2)
    const internalContext = createContext()
    await readWith(internalContext, filePath)

    expect(
      isCompleteUnboundedRead(internalContext.readFileState.get(filePath)),
    ).toBe(false)

    const visibleContext = createContext()
    await callPrepared(
      visibleContext,
      { file_path: filePath },
      createAssistantMessage({ content: [] }),
    )

    const visibleState = visibleContext.readFileState.get(filePath)
    expect(isCompleteUnboundedRead(visibleState)).toBe(true)
    expect(visibleState?.fileIdentity?.canonicalPath).toBe(
      getFileIdentity(filePath).canonicalPath,
    )
  })
})

describe('memory freshness token budget', () => {
  test('includes a stale-memory reminder in the hard rendered limit', async () => {
    const memoryDir = join(tmpDir, 'memory')
    const filePath = join(memoryDir, 'stale.md')
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(filePath, `${'x'.repeat(100)}\n`.repeat(30), 'utf-8')
    const old = new Date(Date.now() - 3 * 86_400_000)
    utimesSync(filePath, old, old)

    const priorDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    const priorOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
    getAutoMemPath.cache.clear()

    try {
      const data = await readWith(createContext(1_000), filePath)
      const rendered = FileReadTool.mapToolResultToToolResultBlockParam(
        data,
        'toolu-stale-memory',
      )
      const text = typeof rendered.content === 'string' ? rendered.content : ''

      expect(text).toContain('days old')
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_000)
    } finally {
      if (priorDisable === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      } else {
        process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = priorDisable
      }
      if (priorOverride === undefined) {
        delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      } else {
        process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = priorOverride
      }
      getAutoMemPath.cache.clear()
    }
  })
})
