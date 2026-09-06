import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAgentModePromptInjections } from './roleFiles.js'

// Temporary source-level assertions: importing the runtime prompt builders in
// this repo snapshot currently trips a pre-existing initialization issue in the
// broader tool graph, so this file verifies prompt doctrine presence only.
const promptSource = await Bun.file(
  new URL('./rolePrompts.ts', import.meta.url),
).text()

describe('Agent Mode role prompts', () => {
  test('coding worker prompt builder stays aligned with the built-in agent definition', () => {
    expect(promptSource).toContain('function getCodingWorkerSystemPrompt(provider: APIProvider): string')
    expect(promptSource).toContain('return getCodingWorkerSystemPrompt(')
  })

  test('coding worker treats worktree lifecycle as orchestrator-owned', () => {
    expect(promptSource).toContain('worktree or isolation lifecycle is orchestrator-owned')
    expect(promptSource).toContain('Do not ask the user to manage worktree cleanup')
    expect(promptSource).toContain('ready for orchestrator synthesis')
  })

  test('worker role descriptions make coding and verification defaults concrete', () => {
    expect(promptSource).toContain('default implementation owner once a patch stops being a tiny single-file tweak')
    expect(promptSource).toContain('default implementation owner for prompt, session-state, worker-control, and orchestration patches even when they stay in one file')
    expect(promptSource).toContain('default review path for non-trivial implementation batches')
    expect(promptSource).toContain('default review path whenever a coding worker changed more than one file')
    expect(promptSource).toContain('especially when prompt, session-state, worker-control, or orchestration behavior changed')
  })

  test('coding worker prompt names the edit tool the worker pool actually carries', async () => {
    // Dynamic import after the tool graph is warm — see the note above.
    await import('../tools.js')
    const { AGENT_MODE_CODING_WORKER } = await import('./rolePrompts.js')
    const { setSessionProvider, resetStateForTests } = await import(
      '../bootstrap/state.js'
    )
    const promptFor = (model: string, provider: string) =>
      AGENT_MODE_CODING_WORKER.getSystemPrompt({
        toolUseContext: {
          options: { mainLoopModel: model, mainLoopProvider: provider },
        },
      } as never)

    try {
      // The worker's pool comes from getProviderFileEditTool(), which reads the
      // SESSION provider — so that is what decides the tool name, even when the
      // request provider (which selects the prose variant) differs.
      setSessionProvider('openai')
      expect(promptFor('gpt-5.6-terra', 'openai')).toContain(
        'Use Apply_patch and Write for code changes.',
      )
      // Request routed to OpenAI by model string, session still Anthropic: the
      // pool holds Edit, so the prompt must say Edit even in the GPT variant.
      setSessionProvider('firstParty')
      const mixed = promptFor('gpt-5.6-terra', 'openai')
      expect(mixed).toContain('Use Edit and Write for code changes.')
      expect(mixed).not.toContain('Apply_patch')

      expect(promptFor('claude-opus-4-1', 'firstParty')).toContain(
        'Use Edit and Write for code changes.',
      )
    } finally {
      resetStateForTests()
    }
  })

  test('coding worker prompt states nothing about nested delegation', async () => {
    await import('../tools.js')
    const { AGENT_MODE_CODING_WORKER } = await import('./rolePrompts.js')
    const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../constants/tools.js')
    const { AGENT_TOOL_NAME } = await import('../tools/AgentTool/constants.js')
    const prompt = AGENT_MODE_CODING_WORKER.getSystemPrompt({
      toolUseContext: {
        options: {
          mainLoopModel: 'claude-opus-4-1',
          mainLoopProvider: 'firstParty',
        },
      },
    } as never)

    // USER_TYPE is not 'ant' here (nor in repo builds, where scripts/build.ts
    // defines it as 'external'), so ALL_AGENT_DISALLOWED_TOOLS strips Agent
    // from every subagent. The role prompt must neither promise the tool nor
    // deny it: getAgentSystemPrompt appends the denial for every worker from
    // the pool the worker actually received, and a second hand-written copy
    // here is the drift this replaced.
    expect(ALL_AGENT_DISALLOWED_TOOLS.has(AGENT_TOOL_NAME)).toBe(true)
    expect(prompt).not.toContain('spawn the Explore agent')
    expect(prompt).not.toContain('You do not have Agent')
    expect(promptSource).not.toContain('canDelegate')
  })

  test('verifier judges isolated worktree result safety', () => {
    expect(promptSource).toContain('If verifying an isolated worktree result')
    expect(promptSource).toContain('safe to apply')
    expect(promptSource).toContain('should be discarded')
    expect(promptSource).toContain('Do not expose raw paths unless needed for evidence')
  })
})

// Source-text assertions only: importing implementorAgent.ts (or any agent
// definition) trips the same pre-existing circular tool-graph init issue noted
// at the top of this file (`Cannot access 'FILE_READ_TOOL_NAME' before
// initialization`). We verify the source directly so the coverage actually
// runs; the runtime wiring is exercised by the build.
const implementorSource = await Bun.file(
  new URL('../tools/AgentTool/built-in/implementorAgent.ts', import.meta.url),
).text()

describe('Normal-mode implementor prompt', () => {
  test('uses a normal-mode-native contract instead of orchestrator framing', () => {
    expect(implementorSource).toContain("agentType: 'implementor'")
    // Reports to the main agent, not an orchestrator.
    expect(implementorSource).toContain('You report to the main agent')
    expect(implementorSource).toContain('main agent decides what to report to the user')
    // Block-and-return-don't-widen discipline is present.
    expect(implementorSource).toContain('block and return the exact question')
    expect(implementorSource).toContain('do not widen the task')
    // No orchestrator framing or orchestrator tool anywhere in the source.
    expect(implementorSource).not.toContain('orchestrator')
    expect(implementorSource).not.toContain('ask_orchestrator')
    expect(implementorSource).not.toContain('ASK_ORCHESTRATOR_TOOL')
  })

  test('does not map the implementor type to .cat-code/roles/implementor.md injection', async () => {
    // getAgentModePromptInjections is keyed by agentType; it must NOT inject the
    // Agent-Mode implementor role file for the normal-mode 'implementor' type.
    const tempProjectDir = mkdtempSync(join(tmpdir(), 'normal-implementor-role-'))
    mkdirSync(join(tempProjectDir, '.cat-code', 'roles'), { recursive: true })
    writeFileSync(
      join(tempProjectDir, '.cat-code', 'roles', 'implementor.md'),
      'Agent Mode-only role file',
    )

    try {
      const injections = await getAgentModePromptInjections(
        'implementor',
        tempProjectDir,
      )

      expect(injections.join('\n')).not.toContain(
        '.cat-code/roles/implementor.md',
      )
      expect(injections.join('\n')).not.toContain('Agent Mode-only role file')
    } finally {
      await rm(tempProjectDir, { recursive: true, force: true })
    }
  })

  test('exposes implementation tools without nested delegation or worker routing tools', () => {
    // Tools are listed by constant name in source; assert on the constant
    // identifiers rather than resolved string values.
    const toolsBlock = implementorSource.slice(
      implementorSource.indexOf('tools: ['),
    )
    expect(toolsBlock).toContain('BASH_TOOL_NAME')
    expect(toolsBlock).toContain('FILE_READ_TOOL_NAME')
    expect(toolsBlock).toContain('FILE_EDIT_TOOL_NAME')
    expect(toolsBlock).toContain('FILE_PATCH_TOOL_NAME')
    expect(toolsBlock).toContain('FILE_WRITE_TOOL_NAME')
    expect(toolsBlock).toContain('GLOB_TOOL_NAME')
    expect(toolsBlock).toContain('GREP_TOOL_NAME')
    // The implementor must NOT carry Agent or ClaudeCli (no nested model
    // delegation), nor the orchestrator/peer-worker routing tools.
    expect(implementorSource).not.toContain('AGENT_TOOL_NAME')
    expect(implementorSource).not.toContain('CLAUDE_CLI_TOOL_NAME')
    expect(implementorSource).not.toContain('ClaudeCli')
    expect(implementorSource).toContain('disallowedTools: [')
    expect(implementorSource).toContain('SEND_MESSAGE_TOOL_NAME')
    expect(implementorSource).toContain('TEAM_CREATE_TOOL_NAME')
    expect(implementorSource).toContain('TEAM_DELETE_TOOL_NAME')
  })
})

describe('AskOrchestrator tool-name resolution', () => {
  // Regression: two constants both named ASK_ORCHESTRATOR_TOOL_NAME used to hold
  // different values ('ask_orchestrator' in prompt.ts, 'AskOrchestrator' in
  // constants.ts). The tool registers under the prompt.ts value, but the role
  // `tools` arrays import the constants.ts value, so exact-match tool lookup
  // missed and the Agent Mode workers never received the orchestrator tool.
  test('both constant modules export the same canonical tool name', async () => {
    const promptConst = await import('../tools/AskOrchestratorTool/prompt.js')
    const defConst = await import('../tools/AskOrchestratorTool/constants.js')
    expect(promptConst.ASK_ORCHESTRATOR_TOOL_NAME).toBe('ask_orchestrator')
    expect(defConst.ASK_ORCHESTRATOR_TOOL_NAME).toBe(
      promptConst.ASK_ORCHESTRATOR_TOOL_NAME,
    )
  })

  test('the tool registers under the same name the role arrays reference', async () => {
    const { AskOrchestratorTool } = await import(
      '../tools/AskOrchestratorTool/AskOrchestratorTool.js'
    )
    const { ASK_ORCHESTRATOR_TOOL_NAME: roleArrayName } = await import(
      '../tools/AskOrchestratorTool/constants.js'
    )
    // The value the role `tools` arrays use must equal the tool's runtime name,
    // or exact-match resolution drops the tool from the workers' tool set.
    expect(AskOrchestratorTool.name).toBe(roleArrayName)
  })

  test('role tool arrays reference the orchestrator constant', () => {
    // The coding worker and verifier definitions both list the orchestrator tool
    // via ASK_ORCHESTRATOR_TOOL_DEF_NAME in their `tools` arrays.
    const occurrences = promptSource.split('ASK_ORCHESTRATOR_TOOL_DEF_NAME,').length - 1
    expect(occurrences).toBe(2)
  })
})
