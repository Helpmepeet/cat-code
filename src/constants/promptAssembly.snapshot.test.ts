import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemPrompt } from './prompts.js'
import { clearSystemPromptSections } from './systemPromptSections.js'

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

// Every tool name the GPT builders branch on, so one snapshot exercises all of
// the tool-conditional insertion points at once.
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

async function assemble(
  tools: ToolList,
  model: string,
  { agentMode = false }: { agentMode?: boolean } = {},
): Promise<string> {
  const savedAgentMode = process.env.CLAUDE_CODE_AGENT_MODE
  const savedOpenAi = process.env.OPENAI_API_KEY
  const savedAnthropic = process.env.ANTHROPIC_API_KEY
  process.env.OPENAI_API_KEY = savedOpenAi ?? 'test-key'
  process.env.ANTHROPIC_API_KEY = savedAnthropic ?? 'test-key'
  if (agentMode) {
    process.env.CLAUDE_CODE_AGENT_MODE = '1'
  } else {
    delete process.env.CLAUDE_CODE_AGENT_MODE
  }
  try {
    clearSystemPromptSections()
    return normalizeMachine((await getSystemPrompt(tools, model)).join('\n'))
  } finally {
    restore('CLAUDE_CODE_AGENT_MODE', savedAgentMode)
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
  if (UPDATING || !existsSync(path)) {
    writeFileSync(path, actual)
    return
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
  afterEach(() => {
    clearSystemPromptSections()
  })

  const cases: [name: string, model: string, tools: ToolList, agentMode: boolean][] = [
    ['gpt-5.6-terra.full', 'gpt-5.6-terra', FULL_TOOLS, false],
    ['gpt-5.6-terra.minimal', 'gpt-5.6-terra', MINIMAL_TOOLS, false],
    ['gpt-5.6-terra.agent-mode', 'gpt-5.6-terra', FULL_TOOLS, true],
    ['claude-opus-5.full', 'claude-opus-5', FULL_TOOLS, false],
  ]

  for (const [name, model, tools, agentMode] of cases) {
    test(`${name} matches its checked-in snapshot`, async () => {
      const prompt = await assemble(tools, model, { agentMode })
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

  // Assembly keys on the provider, never on the model, so every GPT model gets
  // the same instructions and differs only in the line naming it. Adding a
  // per-family layer is expected to fail this test: record the intended
  // divergence here rather than deleting the check.
  test('every GPT family receives byte-identical instructions', async () => {
    const baseline = normalizeModelIdentity(
      await assemble(FULL_TOOLS, 'gpt-5.6-terra'),
    )
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra']) {
      const prompt = normalizeModelIdentity(await assemble(FULL_TOOLS, model))
      expect({ model, prompt }).toEqual({ model, prompt: baseline })
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
