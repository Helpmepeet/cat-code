import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import {
  getMainLoopModelOverride,
  getSessionProvider,
  setMainLoopModelOverride,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import { clearCommandMemoizationCaches } from '../../src/commands.js'
import { clearAgentDefinitionsCache } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { hasProviderBoundHistory } from '../../src/utils/model/providers.js'
import {
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
  initializeSidecarModelProvider,
  loadSidecarToolPermissionContext,
  selectResumedProviderModel,
} from './sessionController.js'

test('desktop startup routes an explicit Claude model away from an OpenAI implicit provider', () => {
  const previousModel = process.env.CAT_CODE_MODEL
  const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  const previousProvider = getSessionProvider()
  const previousOverride = getMainLoopModelOverride()
  try {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CAT_CODE_MODEL = 'haiku'
    setMainLoopModelOverride(undefined)
    setSessionProvider(null)

    expect(initializeSidecarModelProvider()).toBe('haiku')
    expect(getMainLoopModelOverride()).toBe('haiku')
    expect(getSessionProvider()).toBe('firstParty')
  } finally {
    if (previousModel === undefined) delete process.env.CAT_CODE_MODEL
    else process.env.CAT_CODE_MODEL = previousModel
    if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
  }
})

test('desktop startup preserves an implicit OpenAI provider when no model is configured', () => {
  const previousModel = process.env.CAT_CODE_MODEL
  const previousAnthropicModel = process.env.ANTHROPIC_MODEL
  const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  const previousProvider = getSessionProvider()
  const previousOverride = getMainLoopModelOverride()
  try {
    delete process.env.CAT_CODE_MODEL
    delete process.env.ANTHROPIC_MODEL
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    // A provider-local Default masks any developer-machine settings.model so
    // this test exercises the implicit startup path deterministically.
    setMainLoopModelOverride(null)
    setSessionProvider(null)

    expect(initializeSidecarModelProvider()).toBeNull()
    expect(getMainLoopModelOverride()).toBeNull()
    expect(getSessionProvider()).toBe('openai')
  } finally {
    if (previousModel === undefined) delete process.env.CAT_CODE_MODEL
    else process.env.CAT_CODE_MODEL = previousModel
    if (previousAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = previousAnthropicModel
    if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
  }
})

test('desktop resume restores the transcript model instead of today’s provider default', async () => {
  const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  const previousProvider = getSessionProvider()
  const previousOverride = getMainLoopModelOverride()
  try {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    setSessionProvider(null)
    setMainLoopModelOverride(null)

    const { appStateStore } = await createNormalSidecarQueryEngineConfig(
      process.cwd(),
      [
        {
          type: 'assistant',
          uuid: 'resume-model-message',
          message: {
            role: 'assistant',
            model: 'claude-haiku-4-5-20251001',
            content: [],
          },
        },
      ],
    )

    expect(appStateStore.getState().mainLoopModel).toBe(
      'claude-haiku-4-5-20251001',
    )
    expect(getMainLoopModelOverride()).toBe('claude-haiku-4-5-20251001')
    expect(getSessionProvider()).toBe('firstParty')
  } finally {
    if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
  }
})

test('desktop resume ignores a synthetic command-output tail and keeps the latest real provider model', () => {
  const messages = [
    {
      type: 'assistant' as const,
      uuid: 'real-model',
      message: {
        role: 'assistant' as const,
        model: 'claude-haiku-4-5-20251001',
        content: [],
      },
    },
    {
      type: 'assistant' as const,
      uuid: 'cost-output',
      message: {
        role: 'assistant' as const,
        model: '<synthetic>',
        content: [],
      },
    },
  ]

  expect(selectResumedProviderModel(messages)).toBe(
    'claude-haiku-4-5-20251001',
  )
  expect(hasProviderBoundHistory(messages)).toBe(true)
})

test('normal startup exposes the permission-context tools to the model', async () => {
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
    process.cwd(),
  )

  expect(queryEngineConfig.tools.length).toBeGreaterThan(0)
  expect(queryEngineConfig.tools.some(tool => tool.name === 'Bash')).toBe(true)
})

test('normal startup loads the real command catalog (P3-7: commands: [] retired)', async () => {
  // Same defect class as P1-3's `tools: []`: the sidecar shipped `commands: []`,
  // so the engine could parse no slash command AND the `system/init` frame's
  // `slash_commands` (built from these, `systemInit.ts:69`) arrived empty — the
  // desktop slash typeahead had nothing real to show. The catalog now loads via
  // getCommands(cwd), surfaced through the EXISTING init frame (no new wire).
  //
  // In `NODE_ENV=test` the eager `login()` command factory throws unless an
  // Anthropic credential is present (auth.ts:272 CI/test guard — a test-only
  // artifact; production never throws here). Provide a dummy key and clear the
  // command memoization so this proves the REAL populated path, not the
  // fail-soft `[]` degradation the credential-less tests below exercise.
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-p3-7-catalog-test'
  clearCommandMemoizationCaches()
  try {
    const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
      process.cwd(),
    )

    expect(queryEngineConfig.commands.length).toBeGreaterThan(0)
    // A stable, always-available, user-invocable built-in the picker must see.
    const names = queryEngineConfig.commands.map(command => command.name)
    expect(names).toContain('help')
    // The init frame filters to userInvocable !== false — assert at least one
    // such command survives (what slash_commands carries to the renderer).
    expect(
      queryEngineConfig.commands.some(
        command => command.userInvocable !== false,
      ),
    ).toBe(true)
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    // Don't leak the credentialed catalog into the fail-soft degradation tests.
    clearCommandMemoizationCaches()
  }
})

test('fresh session builds the rich slash catalog with descriptions (drift: picker was name-only)', async () => {
  // The engine's `system/init.slash_commands` is NAMES ONLY (the locked SDK
  // shape), so the P3-7 picker rendered bare `/name` rows — no descriptions or
  // arg hints, unlike the prototype. The sidecar now projects the SAME
  // user-invocable set into a rich display catalog (name + description +
  // argumentHint) from the `Command` objects it already loads, delivered as
  // `slash-catalog.snapshot`. Prove it carries a real description. Needs a
  // credential (the test-only login() guard, see the catalog test above).
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-slash-catalog-test'
  clearCommandMemoizationCaches()
  try {
    const { slashCatalog, commands } = await createNormalSidecarQueryEngineConfig(
      process.cwd(),
    )
    expect(slashCatalog.length).toBeGreaterThan(0)
    const help = slashCatalog.find(entry => entry.name === 'help')
    expect(help).toBeDefined()
    // The picker's description column — a non-empty string, not just the name.
    expect(typeof help?.description).toBe('string')
    expect(help?.description.length).toBeGreaterThan(0)

    // SLASH-9: pin a real argumentHint projection, not just help.description.
    // Find any loaded command that actually carries one and prove the
    // projected catalog entry preserved it verbatim (breaking/dropping the
    // `...(command.argumentHint ? { argumentHint } : {})` spread must fail
    // this, unlike the hand-authored stub in sidecarServer.test.ts).
    const commandWithHint = commands.find(
      command => typeof command.argumentHint === 'string' && command.argumentHint.length > 0,
    )
    expect(commandWithHint).toBeDefined()
    const projectedHintEntry = slashCatalog.find(
      entry => entry.name === commandWithHint?.name,
    )
    expect(projectedHintEntry?.argumentHint).toBe(commandWithHint?.argumentHint)

    // SLASH-9: exact userInvocable name-set parity with the engine's own
    // filter (src/utils/messages/systemInit.ts:69-71) applied to the SAME
    // `commands` array — not a re-derivation, a literal copy of that filter,
    // so a drift between the two independent `userInvocable !== false`
    // call sites is caught rather than assumed to stay in sync.
    const engineSlashCommandNames = commands
      .filter(c => c.userInvocable !== false)
      .map(c => c.name)
      .sort()
    expect(slashCatalog.map(entry => entry.name).sort()).toEqual(
      engineSlashCommandNames,
    )
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    clearCommandMemoizationCaches()
  }
})

test('command catalog load degrades to [] instead of throwing (session-safety)', async () => {
  // The credential-less path (no ANTHROPIC_API_KEY in this test env) makes the
  // eager login() factory throw; session construction must swallow it and run
  // WITHOUT slash commands rather than crash. This is the production-safety
  // guarantee: a catalog-load failure is never fatal.
  const previousKey = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  clearCommandMemoizationCaches()
  try {
    const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
      process.cwd(),
    )
    expect(queryEngineConfig.commands).toEqual([])
    // The rest of the config is unaffected by the empty catalog.
    expect(queryEngineConfig.tools.length).toBeGreaterThan(0)
  } finally {
    if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey
    clearCommandMemoizationCaches()
  }
})

test('normal startup roots the engine config at the caller-supplied cwd (P1_1_CWD retired)', async () => {
  // The P1-1 hardcode is gone: the cwd is now an argument threaded from the
  // sidecar's CATCODE_SIDECAR_CWD env, not a pinned literal.
  const cwd = process.cwd()
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(cwd)
  expect(queryEngineConfig.cwd).toBe(cwd)
})

test('normal startup passes real active agents into runtime config and the snapshot', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'catcode-p4-7-agents-'))
  mkdirSync(join(cwd, '.cat-code', 'agents'), { recursive: true })
  writeFileSync(
    join(cwd, '.cat-code', 'agents', 'p4-reviewer.md'),
    `---
name: p4-reviewer
description: "Review P4 changes"
tools: Read, Grep
---

Review P4 changes.
`,
  )
  try {
    clearAgentDefinitionsCache()
    const { queryEngineConfig, agentDefinitions } =
      await createNormalSidecarQueryEngineConfig(cwd)

    expect(
      queryEngineConfig.agents.some(agent => agent.agentType === 'p4-reviewer'),
    ).toBe(true)
    expect(
      agentDefinitions.activeAgents.some(agent => agent.agentType === 'p4-reviewer'),
    ).toBe(true)

    const session = await createSidecarSessionController({ probe: false, cwd })
    const snapshot = session.agentConfig?.getSnapshot()
    expect(
      snapshot?.definitions.some(
        definition => definition.agentType === 'p4-reviewer' && definition.active,
      ),
    ).toBe(true)
  } finally {
    clearAgentDefinitionsCache()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('normal startup constructs a real runtime-backed controller without starting a turn', async () => {
  const { controller, permissions, goals, memory, tasks } =
    await createSidecarSessionController({
    probe: false,
    cwd: process.cwd(),
  })

  expect(controller).toBeInstanceOf(AppSessionController)
  expect(permissions).not.toBeNull()
  expect(goals?.getSnapshot()).toBeNull()
  expect(memory).not.toBeNull()
  expect(tasks?.getSnapshot()).toEqual({ items: [] })
  expect(controller.getAbortState()).toEqual({ status: 'idle' })
  expect(controller.getGoalSnapshot()).toBeNull()
  expect(controller.getPendingPermissionRequests()).toEqual([])
})

test('probe startup has no read domains (no engine app-state store)', async () => {
  const { permissions, settings, agentConfig, goals, memory, tasks } =
    await createSidecarSessionController({
    probe: true,
    cwd: process.cwd(),
  })
  expect(permissions).toBeNull()
  expect(settings).toBeNull()
  expect(agentConfig).toBeNull()
  expect(goals).toBeNull()
  expect(memory).toBeNull()
  expect(tasks).toBeNull()
})

test('PERMISSION-BOUNDARY §8 fix — settings rules and defaultMode actually load', async () => {
  // The P1-2..P2-3 sidecar built its context from getEmptyToolPermissionContext,
  // so settings-file rules were silently never in effect (same defect class as
  // P1-3's `tools: []`). Prove the loader reads real settings: inject a user
  // settings file via CLAUDE_CONFIG_DIR (the engine's own override, memoize-keyed
  // on the env var) and assert the rules and defaultMode land in the context.
  const configDir = mkdtempSync(join(tmpdir(), 'catcode-p2-4-settings-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(catcode-p2-4-proof:*)'],
          deny: ['WebSearch'],
          defaultMode: 'acceptEdits',
        },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetSettingsCache()

    const context = await loadSidecarToolPermissionContext()

    expect(context.alwaysAllowRules.userSettings).toContain(
      'Bash(catcode-p2-4-proof:*)',
    )
    expect(context.alwaysDenyRules.userSettings).toContain('WebSearch')
    expect(context.mode).toBe('acceptEdits')
    // §3 pin: no trusted desktop grant surface exists for bypass, so the
    // loader must keep the engine-side availability backstop OFF regardless
    // of what settings policy alone would report.
    expect(context.isBypassPermissionsModeAvailable).toBe(false)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  }
})
