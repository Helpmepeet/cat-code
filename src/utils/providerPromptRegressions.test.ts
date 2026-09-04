import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../Tool.js'
import {
  getIsInteractive,
  getSessionProvider,
  setIsInteractive,
  setSessionProvider,
} from '../bootstrap/state.js'
import { getTools } from '../tools.js'
import {
  getAgentModeSystemPromptSections,
  getDefaultAgentPrompt,
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../constants/prompts.js'
import {
  getGPTDoingTasksSection,
  getGPTSessionGuidanceSection,
  getGPTUsingToolsSection,
} from '../constants/promptStyles/gpt.js'
import { FILE_PATCH_TOOL_NAME } from '../tools/FilePatchTool/constants.js'
import { buildProviderInstructionAssembly } from '../services/api/instructionAssembly.js'
import { getEditToolDescription } from '../tools/FileEditTool/prompt.js'
import { FilePatchTool } from '../tools/FilePatchTool/FilePatchTool.js'
import { getFilePatchToolDescription } from '../tools/FilePatchTool/prompt.js'
import { getWriteToolDescription } from '../tools/FileWriteTool/prompt.js'
import { GrepTool } from '../tools/GrepTool/GrepTool.js'
import { getDescription as getGrepDescription } from '../tools/GrepTool/prompt.js'
import { getPrompt as getPowerShellPrompt } from '../tools/PowerShellTool/prompt.js'
import { getImplementorSystemPrompt } from '../tools/AgentTool/built-in/implementorAgent.js'
import { normalizeToolInput, splitSysPromptPrefix, toolToAPISchema } from './api.js'
import { createUserMessage, normalizeMessagesForAPI } from './messages.js'
import {
  renameOpenAIInputKeysToOriginal,
  renameSchemaPropertiesForOpenAI,
} from './openaiSchemaCompat.js'
import { clearToolSchemaCache, getToolSchemaCache } from './toolSchemaCache.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

const originalSessionProvider = getSessionProvider()
const originalIsInteractive = getIsInteractive()

function normalizeConstraintLines(description: string): string[] {
  return description
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(2)
    .map(line => line.replace(/^(?:-\s+|\d+\.\s+)/, ''))
}

describe('provider and prompt regressions', () => {
  beforeEach(() => {
    clearToolSchemaCache()
    setSessionProvider(originalSessionProvider)
    setIsInteractive(originalIsInteractive)
  })

  afterEach(() => {
    clearToolSchemaCache()
    setSessionProvider(originalSessionProvider)
    setIsInteractive(originalIsInteractive)
  })

  test('tool schema cache keeps provider-specific Grep schemas separate', async () => {
    setSessionProvider('firstParty')

    const commonOptions = {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [GrepTool],
      agents: [],
    }

    const openaiSchema = await toolToAPISchema(GrepTool, {
      ...commonOptions,
      model: 'gpt-5.6-luna',
    })
    const firstPartySchema = await toolToAPISchema(GrepTool, {
      ...commonOptions,
      model: 'claude-sonnet-4-6',
    })

    const openaiProps =
      ((openaiSchema as { input_schema?: { properties?: Record<string, unknown> } })
        .input_schema?.properties ?? {})
    const firstPartyProps =
      ((firstPartySchema as {
        input_schema?: { properties?: Record<string, unknown> }
      }).input_schema?.properties ?? {})

    expect(openaiProps).toHaveProperty('lines_after')
    expect(openaiProps).not.toHaveProperty('-A')
    expect(firstPartyProps).toHaveProperty('-A')
    expect(firstPartyProps).not.toHaveProperty('lines_after')
    expect(getToolSchemaCache().size).toBe(2)
  })

  test('OpenAI key remap round-trips through schema export and input normalization', () => {
    const exportedSchema = renameSchemaPropertiesForOpenAI(
      zodToJsonSchema(GrepTool.inputSchema) as Record<string, unknown>,
    ) as {
      properties?: Record<string, unknown>
      required?: string[]
    }

    expect(exportedSchema.properties).toHaveProperty('lines_after')
    expect(exportedSchema.properties).not.toHaveProperty('-A')

    const normalizedInput = renameOpenAIInputKeysToOriginal({
      pattern: 'needle',
      lines_after: 2,
      lines_before: 1,
      context_lines: 3,
      show_line_numbers: false,
      case_insensitive: true,
    })

    expect(normalizedInput).toEqual({
      pattern: 'needle',
      '-A': 2,
      '-B': 1,
      '-C': 3,
      '-n': false,
      '-i': true,
    })

    setSessionProvider('openai')
    const apiNormalizedInput = normalizeToolInput(GrepTool, {
      pattern: 'needle',
      lines_after: 2,
      show_line_numbers: false,
    } as never) as Record<string, unknown>

    expect(apiNormalizedInput).toHaveProperty('-A', 2)
    expect(apiNormalizedInput).toHaveProperty('-n', false)
    expect(apiNormalizedInput).not.toHaveProperty('lines_after')
    expect(apiNormalizedInput).not.toHaveProperty('show_line_numbers')
  })

  test('getDefaultAgentPrompt emits the OpenAI identity text', () => {
    const prompt = getDefaultAgentPrompt('openai')

    expect(prompt).toContain("OpenAI's Codex/GPT models")
    expect(prompt).not.toContain('powered by Claude')
  })

  test('OpenAI agent-mode instructions retain the non-interactive identity prefix', async () => {
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey ?? 'test-key'

    try {
      setSessionProvider('openai')
      setIsInteractive(false)

      const systemPrompt = await getAgentModeSystemPromptSections(
        [],
        'gpt-5.6-luna',
        [],
        [],
      )
      const assembly = buildProviderInstructionAssembly({
        provider: 'openai',
        messages: [],
        systemPrompt,
        userContext: {},
        systemContext: {},
      })

      expect(assembly.openAIInstructionAssembly?.instructions).toStartWith(
        'You are an agent for Cat Code.',
      )
    } finally {
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
      }
    }
  })

  test('an OpenAI worker on an ambiguous model gets the OpenAI prompt style', async () => {
    setSessionProvider('firstParty')

    const prompt = await (
      getSystemPrompt as (
        tools: Parameters<typeof getSystemPrompt>[0],
        model: string,
        additionalWorkingDirectories?: string[],
        mcpClients?: [],
        provider?: 'openai',
      ) => ReturnType<typeof getSystemPrompt>
    )([], 'claude-opus-5', [], [], 'openai')

    expect(prompt.join('\n')).toContain(
      'This session is running through the OpenAI Codex provider.',
    )
  })

  test('OpenAI exports Apply_patch as a custom tool schema', async () => {
    setSessionProvider('openai')

    const schema = await toolToAPISchema(FilePatchTool, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [FilePatchTool],
      agents: [],
      model: 'gpt-5.6-luna',
    })

    expect(schema).toMatchObject({
      name: 'Apply_patch',
      openai_tool_type: 'custom',
      openai_tool_format: {
        type: 'grammar',
        syntax: 'lark',
        definition: 'start: /(.|\\n)*/',
      },
    })
  })

  test('FileWrite prompt names the provider-specific edit tool', () => {
    expect(getWriteToolDescription('firstParty')).toContain(
      'check whether Edit is the better tool. Prefer Edit',
    )
    expect(getWriteToolDescription('openai')).toContain(
      'check whether Apply_patch is the better tool. Prefer Apply_patch',
    )
  })

  test('FileWrite requires a complete Read before whole-file replacement', () => {
    const prompt = getWriteToolDescription('openai')

    expect(prompt).toContain('without offset or limit')
    expect(prompt).toContain('complete, untruncated contents')
    expect(prompt).toContain('targeted edit tool instead of Write')
  })

  test('OpenAI uses Apply_patch prompt instead of FileEdit prompt', () => {
    expect(getFilePatchToolDescription()).toContain('*** Begin Patch')
    expect(getFilePatchToolDescription()).toContain('*** Update File')
    expect(getFilePatchToolDescription()).toContain('*** End of File')
    expect(normalizeConstraintLines(getEditToolDescription('firstParty'))).not.toEqual(
      normalizeConstraintLines(getFilePatchToolDescription()),
    )
  })

  test('GPT doing-tasks guidance references Apply_patch when available', () => {
    const section = getGPTDoingTasksSection(new Set(['Read', 'Apply_patch']))

    expect(section).toContain('prior Read tool result before emitting an Apply_patch')
    expect(section).not.toContain('prior Read tool result before emitting an Edit')
  })

  test('normalizeMessagesForAPI preserves raw Apply_patch tool_use input for executable handoff', () => {
    const normalized = normalizeMessagesForAPI([
      {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_apply_patch_1',
              name: 'Apply_patch',
              input: '*** Begin Patch\n*** Update File: src/example.ts\n@@ line\n-line\n+line changed\n*** End Patch',
            },
          ],
        },
      },
    ] as never, [FilePatchTool])

    const toolUse = normalized[0]?.message.content[0] as { input?: unknown }
    expect(toolUse.input).toBe(
      '*** Begin Patch\n*** Update File: src/example.ts\n@@ line\n-line\n+line changed\n*** End Patch',
    )
  })

  test('normalizeMessagesForAPI keeps synthetic meta context separate from the user-authored turn', () => {
    const normalized = normalizeMessagesForAPI([
      createUserMessage({ content: 'real user prompt' }),
      createUserMessage({
        content: 'Context for this session:\n# currentDate\n2026-04-21',
        isMeta: true,
      }),
    ])

    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toMatchObject({
      type: 'user',
      isMeta: undefined,
      message: { content: 'real user prompt' },
    })
    expect(normalized[1]).toMatchObject({
      type: 'user',
      isMeta: true,
      message: {
        content: 'Context for this session:\n# currentDate\n2026-04-21',
      },
    })
  })

  test('OpenAI instruction assembly keeps volatile system context out of user input messages', () => {
    const userMessage = createUserMessage({ content: 'real user prompt' })
    const assembly = buildProviderInstructionAssembly({
      provider: 'openai',
      messages: [userMessage],
      systemPrompt: ['base instructions'],
      userContext: { currentDate: '2026-04-25' },
      systemContext: {
        gitStatus: 'Current branch: phase1',
        cacheBreaker: 'cache nonce',
      },
    })

    expect(assembly.openAIInstructionAssembly?.instructions).toContain(
      '# currentDate\n2026-04-25',
    )
    expect(assembly.openAIInstructionAssembly?.instructions).not.toContain(
      'Current branch: phase1',
    )
    expect(assembly.openAIInstructionAssembly?.developerContext).toContain(
      '<gitStatus>\nCurrent branch: phase1\n</gitStatus>',
    )
    expect(assembly.openAIInstructionAssembly?.developerContext).toContain(
      '<cacheBreaker>\ncache nonce\n</cacheBreaker>',
    )
    expect(assembly.openAIInstructionAssembly?.inputMessages).toEqual([
      userMessage,
    ])
    expect(assembly.messages).toEqual([userMessage])
  })

  test('provider instruction paths omit the dynamic boundary marker', () => {
    const systemPrompt = ['base instructions', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'dynamic']
    const assembly = buildProviderInstructionAssembly({
      provider: 'openai',
      messages: [],
      systemPrompt,
      userContext: {},
      systemContext: {},
    })

    expect(assembly.openAIInstructionAssembly?.instructions).toBe(
      'base instructions\n\ndynamic',
    )

    setSessionProvider('openai')
    expect(splitSysPromptPrefix(systemPrompt).map(block => block.text)).toEqual([
      'base instructions\n\ndynamic',
    ])
  })

  test('normalizeMessagesForAPI preserves trailing thinking blocks for OpenAI replay', () => {
    setSessionProvider('openai')

    const normalized = normalizeMessagesForAPI([
      {
        type: 'assistant',
        uuid: 'assistant-thinking-openai',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_openai_reasoning',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5.6-luna',
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            { type: 'text', text: 'I am about to call a tool.' },
            { type: 'thinking', thinking: '', signature: 'opaque-replay-signature' },
          ],
        },
      },
    ] as never)

    expect(normalized).toHaveLength(1)
    expect(normalized[0]?.message.content).toEqual([
      { type: 'text', text: 'I am about to call a tool.' },
      { type: 'thinking', thinking: '', signature: 'opaque-replay-signature' },
    ])
  })

  test('tool registry switches Edit vs Apply_patch by provider, including simple mode', () => {
    const originalSimple = process.env.CLAUDE_CODE_SIMPLE

    try {
      setSessionProvider('openai')
      const openaiTools = getTools(getEmptyToolPermissionContext()).map(tool => tool.name)
      expect(openaiTools).toContain('Apply_patch')
      expect(openaiTools).not.toContain('Edit')

      process.env.CLAUDE_CODE_SIMPLE = '1'
      const openaiSimpleTools = getTools(getEmptyToolPermissionContext()).map(
        tool => tool.name,
      )
      expect(openaiSimpleTools).toContain('Apply_patch')
      expect(openaiSimpleTools).not.toContain('Edit')

      setSessionProvider('firstParty')
      delete process.env.CLAUDE_CODE_SIMPLE
      const claudeTools = getTools(getEmptyToolPermissionContext()).map(tool => tool.name)
      expect(claudeTools).toContain('Edit')
      expect(claudeTools).not.toContain('Apply_patch')

      process.env.CLAUDE_CODE_SIMPLE = '1'
      const claudeSimpleTools = getTools(getEmptyToolPermissionContext()).map(
        tool => tool.name,
      )
      expect(claudeSimpleTools).toContain('Edit')
      expect(claudeSimpleTools).not.toContain('Apply_patch')
    } finally {
      if (originalSimple === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = originalSimple
      }
    }
  })
  // The patch format mandates relative paths without naming the base, so a
  // session rooted below the project root resolves them one level too deep.
  test('GPT tool rules state where patch paths resolve, only when that tool is live', () => {
    const withPatchTool = getGPTUsingToolsSection(new Set([FILE_PATCH_TOOL_NAME]))
    expect(withPatchTool).toContain('resolved against the session working directory')

    const withoutPatchTool = getGPTUsingToolsSection(new Set())
    expect(withoutPatchTool).not.toContain('resolved against the session working directory')
  })

  test('GPT tool rules carry the Apply_patch mutation rule and the diff check', () => {
    const section = getGPTUsingToolsSection(new Set([FILE_PATCH_TOOL_NAME]))

    expect(section).toContain('Use Apply_patch for local file edits.')
    expect(section).toContain(
      'Do not create or edit files with cat, heredocs, or other shell write tricks.',
    )
    expect(section).toContain(
      'Formatting commands and bulk mechanical rewrites do not need Apply_patch.',
    )
    expect(section).toContain(
      'Do not use Python to read or write files when a simple shell command or Apply_patch is enough.',
    )
    expect(section).toContain(
      'After any file mutation performed by a command rather than by Apply_patch, Write, or NotebookEdit',
    )
    expect(section).toContain('show the resulting git diff before moving on')
    expect(section).toContain(
      'show git diff --stat and git status --short instead',
    )
    expect(section).toContain('Never skip the check.')

    expect(section).not.toContain('no dedicated tool')
  })

  test('GPT read discipline permits shell reads and states why Read is the default', () => {
    const guidance = getGPTSessionGuidanceSection(new Set(['Grep', 'Read']), [])

    expect(guidance).toContain('`rg`')
    expect(guidance).toContain('`sed -n` line ranges')
    expect(guidance).toContain('`git blame`')
    expect(guidance).toContain('bounded (offset/limit) and numbered')
  })

  test('the Claude system prompt keeps its own dedicated-tool wording', async () => {
    setSessionProvider('firstParty')

    const prompt = (await getSystemPrompt([], 'claude-opus-5')).join('\n')

    expect(prompt).toContain('To edit files use Edit instead of sed or awk')
    expect(prompt).toContain(
      'To read files use Read instead of cat, head, tail, or sed',
    )
    expect(prompt).not.toContain('Use Apply_patch for local file edits')
    expect(prompt).not.toContain('show the resulting git diff before moving on')
  })

  test('GrepTool prompt on GPT allows rg in Bash while Claude strictly forbids it', () => {
    const gptPrompt = getGrepDescription('openai')
    expect(gptPrompt).toContain('Targeted `rg` commands through Bash are also permitted')
    expect(gptPrompt).not.toContain('NEVER invoke `grep` or `rg` as a Bash command')

    const claudePrompt = getGrepDescription('firstParty')
    expect(claudePrompt).toContain('NEVER invoke `grep` or `rg` as a Bash command')
  })

  test('FilePatchTool prompt refers to Apply_patch as a tool, not a shell command', () => {
    const desc = getFilePatchToolDescription()
    expect(desc).toContain('Use the `Apply_patch` tool to edit files')
    expect(desc).not.toContain('shell command')
    expect(desc).toContain(
      'Patch paths resolve relative to the current session working directory.',
    )
    expect(desc).toContain(
      'Later tools, including `Apply_patch`, use the updated directory',
    )
  })

  test('PowerShellTool prompt distinguishes GPT hybrid policy from Claude strict policy', async () => {
    const gptPsPrompt = await getPowerShellPrompt('openai')
    expect(gptPsPrompt).toContain('FILE MUTATIONS: Use Apply_patch for local file edits')
    expect(gptPsPrompt).toContain('READS AND SEARCH: `rg`, `rg --files`')
    expect(gptPsPrompt).toContain('Edit files: Use Apply_patch')

    const claudePsPrompt = await getPowerShellPrompt('firstParty')
    expect(claudePsPrompt).toContain('DO NOT use it for file operations')
    expect(claudePsPrompt).toContain('Edit files: Use Edit')
    expect(claudePsPrompt).not.toContain('Apply_patch')
  })

  test('Implementor prompt names the session edit tool rather than both aliases simultaneously', () => {
    setSessionProvider('openai')
    const openaiPrompt = getImplementorSystemPrompt('openai')
    expect(openaiPrompt).toContain('Use Apply_patch and Write for code changes')
    expect(openaiPrompt).not.toContain('Use Edit, Apply_patch, and Write')

    setSessionProvider('firstParty')
    const claudePrompt = getImplementorSystemPrompt('firstParty')
    expect(claudePrompt).toContain('Use Edit and Write for code changes')
    expect(claudePrompt).not.toContain('Apply_patch')
  })

  test('--dump-system-prompt renders the tool-gated rules a session gets', async () => {
    setSessionProvider('openai')

    const withTools = (
      await getSystemPrompt(
        getTools(getEmptyToolPermissionContext()),
        'gpt-5.6-sol',
      )
    ).join('\n')
    const withoutTools = (await getSystemPrompt([], 'gpt-5.6-sol')).join('\n')

    // The dump used to pass an empty tool list, so these gated rules were
    // missing and file routing named Edit instead of Apply_patch — evals built
    // on the dump measured a prompt no session runs.
    expect(withTools).toContain('AGENT TOOL:')
    expect(withTools).toContain('TASK TRACKING:')
    expect(withTools).toContain(`File editing → ${FILE_PATCH_TOOL_NAME}`)
    expect(withoutTools).not.toContain('AGENT TOOL:')
    expect(withoutTools).not.toContain(`File editing → ${FILE_PATCH_TOOL_NAME}`)

    // Guard the call site itself: the dump path is an entrypoint fast path
    // with no other coverage.
    const cliSource = await Bun.file(
      new URL('../entrypoints/cli.tsx', import.meta.url).pathname,
    ).text()
    expect(cliSource).not.toContain('getSystemPrompt([], model)')
    expect(cliSource).toContain(
      'getSystemPrompt(getTools(getEmptyToolPermissionContext()), model)',
    )
  })

  test('restricted GPT tool sets do not leak mutation or unheld routing rules', () => {
    const restrictedSection = getGPTUsingToolsSection(new Set(['Bash', 'Read']))
    expect(restrictedSection).not.toContain('File editing →')
    expect(restrictedSection).not.toContain('File creation →')
    expect(restrictedSection).not.toContain('File search →')
    expect(restrictedSection).not.toContain('Content search →')
    expect(restrictedSection).not.toContain('RULE — File mutations')
    expect(restrictedSection).toContain('File reading → Read')
    expect(restrictedSection).toContain('Shell execution → Bash')
  })
})
