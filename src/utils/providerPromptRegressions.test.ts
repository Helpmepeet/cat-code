import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { getSessionProvider, setSessionProvider } from '../bootstrap/state.js'
import { getTools } from '../tools.js'
import { getDefaultAgentPrompt } from '../constants/prompts.js'
import { getGPTDoingTasksSection } from '../constants/promptStyles/gpt.js'
import { buildProviderInstructionAssembly } from '../services/api/instructionAssembly.js'
import { getEditToolDescription } from '../tools/FileEditTool/prompt.js'
import { FilePatchTool } from '../tools/FilePatchTool/FilePatchTool.js'
import { getFilePatchToolDescription } from '../tools/FilePatchTool/prompt.js'
import { getWriteToolDescription } from '../tools/FileWriteTool/prompt.js'
import { GrepTool } from '../tools/GrepTool/GrepTool.js'
import { normalizeToolInput, toolToAPISchema } from './api.js'
import { createUserMessage, normalizeMessagesForAPI } from './messages.js'
import {
  renameOpenAIInputKeysToOriginal,
  renameSchemaPropertiesForOpenAI,
} from './openaiSchemaCompat.js'
import { clearToolSchemaCache, getToolSchemaCache } from './toolSchemaCache.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

const originalSessionProvider = getSessionProvider()

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
  })

  afterEach(() => {
    clearToolSchemaCache()
    setSessionProvider(originalSessionProvider)
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
      model: 'gpt-5.4',
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

  test('OpenAI exports Apply_patch as a custom tool schema', async () => {
    setSessionProvider('openai')

    const schema = await toolToAPISchema(FilePatchTool, {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [FilePatchTool],
      agents: [],
      model: 'gpt-5.4',
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

  test('FileWrite prompt variants keep the same underlying rules', () => {
    expect(
      normalizeConstraintLines(getWriteToolDescription('firstParty')),
    ).toEqual(normalizeConstraintLines(getWriteToolDescription('openai')))
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
          model: 'gpt-5.4',
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
})
