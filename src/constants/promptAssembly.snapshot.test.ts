import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemPrompt } from './prompts.js'
import { clearSystemPromptSections } from './systemPromptSections.js'
import * as outputStyles from './outputStyles.js'
import { getGPTPromptFamily } from './promptStyle.js'
import { mapClaudeModelToCodex } from '../services/api/codex-fetch-adapter.js'
import { buildProviderInstructionAssembly } from '../services/api/instructionAssembly.js'
import {
  getCyberPolicyInstruction,
  HOOK_AUTHORITY_RULE,
  OUTCOME_REPORTING_RULE,
  PROJECT_INSTRUCTION_AUTHORITY_RULE,
  PROMPT_INJECTION_RULE,
  RETRY_RULE,
  RUNTIME_METADATA_RULE,
  TOOL_OUTPUT_IS_DATA_RULE,
} from './corePolicy.js'

// The targeted assertions in prompts.test.ts pin under a quarter of the
// assembled prompt, so a refactor can drop the rest and leave every test green.
// These snapshots hold the whole assembly instead: they prove nothing about
// quality, only that a change moved exactly the text it meant to move.
//
// Regenerate after an intended change, then read the diff:
//   UPDATE_PROMPT_SNAPSHOTS=1 bun test src/constants/promptAssembly.snapshot.test.ts

const SNAPSHOT_DIR = join(import.meta.dir, '__prompt_snapshots__')
const UPDATING = process.env.UPDATE_PROMPT_SNAPSHOTS === '1'

type ToolList = Parameters<typeof getSystemPrompt>[0]

const toolList = (...names: string[]) =>
  names.map(name => ({ name })) as unknown as ToolList

// A representative tool-rich assembly. Task tools and editing fallbacks need
// focused fixtures; this list does not exercise every conditional insertion.
const FULL_TOOLS = toolList(
  'Agent',
  'Apply_patch',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Grep',
  'Read',
  'Skill',
)

// The absence branches: no edit tool, no Agent, no AskUserQuestion, no Skill.
const MINIMAL_TOOLS = toolList('Bash', 'Read')

// Values that differ per machine or per checkout. Anything volatile that is not
// listed here must be added, or the snapshot churns for everyone else.
function normalizeMachine(prompt: string): string {
  return prompt
    .split('\n')
    .filter(line => !line.includes('This is a git worktree'))
    .join('\n')
    .replace(/(Primary working directory: ).*/g, '$1<cwd>')
    .replace(/(Working directory: ).*/g, '$1<cwd>')
    .replace(/(Is a git repository: ).*/g, '$1<is-git>')
    .replace(/(Is directory a git repo: ).*/g, '$1<is-git>')
    .replace(/(Platform: ).*/g, '$1<platform>')
    .replace(/(Shell: ).*/g, '$1<shell>')
    .replace(/(OS Version: ).*/g, '$1<os-version>')
}

function normalizeModelIdentity(prompt: string): string {
  return prompt
    .replace(/You are powered by the model[^\n]*/g, 'You are powered by <model>.')
    .replace(/Assistant knowledge cutoff is[^\n]*/g, 'Assistant knowledge cutoff is <cutoff>.')
}

async function assemble(tools: ToolList, model: string, clearCache = true): Promise<string> {
  const savedOpenAi = process.env.OPENAI_API_KEY
  const savedAnthropic = process.env.ANTHROPIC_API_KEY
  process.env.OPENAI_API_KEY = savedOpenAi ?? 'test-key'
  process.env.ANTHROPIC_API_KEY = savedAnthropic ?? 'test-key'
  try {
    if (clearCache) clearSystemPromptSections()
    return normalizeMachine((await getSystemPrompt(tools, model)).join('\n'))
  } finally {
    restore('OPENAI_API_KEY', savedOpenAi)
    restore('ANTHROPIC_API_KEY', savedAnthropic)
  }
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function checkAgainstSnapshot(name: string, actual: string): void {
  const path = join(SNAPSHOT_DIR, `${name}.txt`)
  if (UPDATING) {
    writeFileSync(path, actual)
    return
  }
  if (!existsSync(path)) {
    throw new Error(`Missing prompt snapshot ${name}. Generate with UPDATE_PROMPT_SNAPSHOTS=1 and review the diff.`)
  }
  const expected = readFileSync(path, 'utf8')
  if (actual === expected) return

  // A whole-prompt string diff is thousands of lines, so report the first
  // divergence and how to accept it instead.
  const actualLines = actual.split('\n')
  const expectedLines = expected.split('\n')
  let i = 0
  while (
    i < actualLines.length &&
    i < expectedLines.length &&
    actualLines[i] === expectedLines[i]
  ) {
    i++
  }
  throw new Error(
    [
      `Assembled prompt "${name}" no longer matches its snapshot.`,
      `First divergence at line ${i + 1} of ${expectedLines.length}:`,
      `  snapshot: ${expectedLines[i] ?? '<end of file>'}`,
      `  built:    ${actualLines[i] ?? '<end of file>'}`,
      `Line count ${expectedLines.length} -> ${actualLines.length}.`,
      'If the change was intended, review the full diff and accept it with:',
      '  UPDATE_PROMPT_SNAPSHOTS=1 bun test src/constants/promptAssembly.snapshot.test.ts',
    ].join('\n'),
  )
}

describe('assembled system prompt', () => {
  let outputStyleSpy: ReturnType<typeof spyOn>
  let savedOpenAi: string | undefined
  let savedAnthropic: string | undefined
  beforeEach(() => {
    savedOpenAi = process.env.OPENAI_API_KEY
    savedAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = savedOpenAi ?? 'test-key'
    process.env.ANTHROPIC_API_KEY = savedAnthropic ?? 'test-key'
    // Snapshots describe product defaults, not the operator's saved style.
    outputStyleSpy = spyOn(outputStyles, 'getOutputStyleConfig').mockResolvedValue(null)
  })
  afterEach(() => {
    outputStyleSpy.mockRestore()
    restore('OPENAI_API_KEY', savedOpenAi)
    restore('ANTHROPIC_API_KEY', savedAnthropic)
    clearSystemPromptSections()
  })

  const cases: [name: string, model: string, tools: ToolList][] = [
    ['gpt-5.6-terra.full', 'gpt-5.6-terra', FULL_TOOLS],
    ['gpt-5.6-terra.minimal', 'gpt-5.6-terra', MINIMAL_TOOLS],
    ['gpt-6-astra.full', 'gpt-6-astra', FULL_TOOLS],
    ['gpt-6-astra.minimal', 'gpt-6-astra', MINIMAL_TOOLS],
    ['claude-opus-5.full', 'claude-opus-5', FULL_TOOLS],
  ]

  for (const [name, model, tools] of cases) {
    test(`${name} matches its checked-in snapshot`, async () => {
      const prompt = await assemble(tools, model)
      checkAgainstSnapshot(name, prompt)
    })
  }

  // A normalization gap would otherwise show up as a snapshot that churns on
  // someone else's machine instead of as a failure here.
  test('no machine-specific value survives normalization', async () => {
    const prompt = await assemble(FULL_TOOLS, 'gpt-5.6-terra')
    expect(prompt).not.toContain(process.cwd())
    expect(prompt).not.toContain('/Users/')
  })

  // The shipped 5.6 templates are identical. Preserve that equivalence while
  // pinning the generation-specific differences in the following test.
  test('Sol, Terra and Luna receive byte-identical instructions', async () => {
    const baseline = normalizeModelIdentity(
      await assemble(FULL_TOOLS, 'gpt-5.6-terra'),
    )
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-luna']) {
      const prompt = normalizeModelIdentity(await assemble(FULL_TOOLS, model))
      expect({ model, prompt }).toEqual({ model, prompt: baseline })
    }
  })

  test('Astra differs only in task execution, actions and tone, with shared contracts intact', async () => {
    const baseline = normalizeModelIdentity(await assemble(FULL_TOOLS, 'gpt-5.6-terra'))
    const astra = normalizeModelIdentity(await assemble(FULL_TOOLS, 'gpt-6-astra'))
    const sharedSections = (prompt: string) => prompt.split(/(?=^# )/m).filter(
      section => !/^# (Getting Work Done|Acting and Asking|Tone and Style)\n/.test(section),
    )
    expect(sharedSections(astra)).toEqual(sharedSections(baseline))
    for (const calibration of [
      'Once those checks pass, broaden or repeat them only',
      'FOLLOW-THROUGH: Infer action intent from context',
      'Check whether a file or skill requirement applies',
      'WRITING: Build connected paragraphs',
    ]) {
      expect(astra).toContain(calibration)
      expect(baseline).not.toContain(calibration)
    }
    for (const prompt of [baseline, astra]) {
      for (const contract of [
        getCyberPolicyInstruction(), TOOL_OUTPUT_IS_DATA_RULE, RUNTIME_METADATA_RULE,
        PROMPT_INJECTION_RULE, HOOK_AUTHORITY_RULE, PROJECT_INSTRUCTION_AUTHORITY_RULE,
        RETRY_RULE, OUTCOME_REPORTING_RULE,
      ]) {
        expect(prompt.split(contract).length - 1).toBe(1)
      }
      expect(prompt).toContain('does not by itself authorize implementation')
      expect(prompt).toContain('confirm first unless the user or loaded durable instructions already authorize that scope')
      expect(prompt).toContain('FORMAT: Prefer prose and light formatting')
    }
  })

  test('model and tool switches rebuild family guidance without clearing section caches', async () => {
    clearSystemPromptSections()
    const first = await assemble(FULL_TOOLS, 'gpt-5.6-terra', false)
    // Keep tools identical here: changing them could hide a missing family key.
    const astra = await assemble(FULL_TOOLS, 'gpt-6-astra', false)
    const last = await assemble(FULL_TOOLS, 'gpt-5.6-terra', false)
    expect(last).toBe(first)
    expect(first).not.toContain('FOLLOW-THROUGH:')
    expect(astra).toContain('FOLLOW-THROUGH:')
    const minimal = await assemble(MINIMAL_TOOLS, 'gpt-6-astra', false)
    // Loaded file/skill instructions can affect work without a current Skill tool.
    expect(minimal).toContain('Check whether a file or skill requirement applies')
    expect(minimal).not.toContain('AGENT TOOL:')
    expect(minimal).not.toContain('Read before modifying:')
    expect(first).toContain('AGENT TOOL:')
  })

  test('family selection matches exact transport identity, including malformed Astra names', async () => {
    for (const model of ['gpt-6-astra', 'GPT-6-ASTRA', 'gpt-6-astra ', 'gpt-6-astra-future', 'claude-opus-5']) {
      const expected = mapClaudeModelToCodex(model) === 'gpt-6-astra'
      expect(getGPTPromptFamily(model) === 'gpt-6-astra').toBe(expected)
      const prompt = (await getSystemPrompt(MINIMAL_TOOLS, model, [], [], 'openai')).join('\n')
      expect(prompt.includes('FOLLOW-THROUGH:')).toBe(expected)
    }
  })

  test('patch evidence does not relax other mutation tools\' Read prerequisites', async () => {
    const patch = await assemble(toolList('Apply_patch', 'Bash'), 'gpt-6-astra')
    expect(patch).toContain('Shell reads can supply the evidence for Apply_patch updates')
    expect(patch).toContain('they do not satisfy recorded-read requirements for deletion or other mutation tools')
    for (const mutationTool of ['Edit', 'Write']) {
      const prompt = await assemble(toolList(mutationTool, 'Read', 'Bash'), 'gpt-6-astra')
      expect(prompt).toContain('Read before modifying:')
      expect(prompt).toContain('Follow the chosen mutation tool\'s Read prerequisites')
      expect(prompt).not.toContain('Shell reads can supply the evidence')
    }
    expect(await assemble(MINIMAL_TOOLS, 'gpt-6-astra')).not.toContain('Read before modifying:')
  })

  test('task tools retain optional routing without repeating their lifecycle descriptions', async () => {
    for (const taskTool of ['TodoWrite', 'TaskCreate']) {
      const prompt = await assemble(toolList(taskTool, 'Bash'), 'gpt-5.6-terra')
      expect(prompt).toContain(`TASK TRACKING: When task tracking helps, use ${taskTool}.`)
      expect(prompt).not.toContain('Do not batch completions')
    }
  })

  test('real family instructions survive final OpenAI request assembly', async () => {
    for (const model of ['gpt-5.6-terra', 'gpt-6-astra']) {
      const systemPrompt = await getSystemPrompt(MINIMAL_TOOLS, model)
      const assembly = buildProviderInstructionAssembly({
        provider: 'openai', messages: [], systemPrompt,
        userContext: { project: 'fixture user instructions' },
        systemContext: { gitStatus: 'fixture volatile status' },
      }).openAIInstructionAssembly!
      expect(assembly.instructions.includes('FOLLOW-THROUGH:')).toBe(model === 'gpt-6-astra')
      expect(assembly.instructions).toContain(OUTCOME_REPORTING_RULE)
      expect(assembly.instructions).toContain('fixture user instructions')
      expect(assembly.instructions).not.toContain('fixture volatile status')
      expect(assembly.developerContext).toContain('fixture volatile status')
    }
  })

  test('family defaults preserve Learning pauses and Explanatory formatting', async () => {
    for (const style of ['Learning', 'Explanatory'] as const) {
      outputStyleSpy.mockResolvedValue(outputStyles.OUTPUT_STYLE_CONFIG[style])
      for (const model of ['gpt-5.6-terra', 'gpt-6-astra']) {
        const prompt = await assemble(MINIMAL_TOOLS, model)
        expect(prompt).toContain(outputStyles.OUTPUT_STYLE_CONFIG[style]!.prompt)
        expect(prompt).toContain('Respect the user\'s requested workflow and intentional pauses in the selected output style')
        expect(prompt).toContain('The requested artifact format and selected output style take precedence')
      }
    }
  })

  // The two providers must not converge silently: if this ever passes, the
  // GPT style stopped being applied.
  test('the GPT and Claude assemblies stay distinct', async () => {
    const gpt = normalizeModelIdentity(await assemble(FULL_TOOLS, 'gpt-5.6-terra'))
    const claude = normalizeModelIdentity(
      await assemble(FULL_TOOLS, 'claude-opus-5'),
    )
    expect(gpt).not.toBe(claude)
  })
})
