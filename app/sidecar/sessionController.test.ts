import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import {
  getMainLoopModelOverride,
  getSessionProvider,
  setMainLoopModelOverride,
  setSessionProvider,
} from '../../src/bootstrap/state.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import { clearCommandMemoizationCaches, isHeadlessSafeCommand } from '../../src/commands.js'
import { clearAgentDefinitionsCache } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { hasProviderBoundHistory } from '../../src/utils/model/providers.js'
import {
  buildDesktopSystemPrompt,
  buildPeerDoctrine,
  DESKTOP_SYSTEM_PROMPT_ADDENDUM,
} from './desktopSystemPrompt.js'
import { readPeerIdentity } from './peerHostRequester.js'
import {
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
  initializeSidecarModelProvider,
  loadAgentDefinitionsForRuntime,
  loadSidecarToolPermissionContext,
  readSpawnEffort,
  readSpawnModel,
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

/**
 * Run `body` with a user settings.json holding `settings`, no model env lever,
 * and the given `CLAUDE_CODE_USE_*` var set. Restores every global it moves.
 */
function withSettingsFileStartup(
  settings: Record<string, unknown>,
  providerEnvVar: 'CLAUDE_CODE_USE_OPENAI' | 'CLAUDE_CODE_USE_BEDROCK',
  body: () => void,
): void {
  const configDir = mkdtempSync(join(tmpdir(), 'catcode-w3f-model-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousModel = process.env.CAT_CODE_MODEL
  const previousAnthropicModel = process.env.ANTHROPIC_MODEL
  const previousProviderEnv = process.env[providerEnvVar]
  const previousProvider = getSessionProvider()
  const previousOverride = getMainLoopModelOverride()
  try {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CAT_CODE_MODEL
    delete process.env.ANTHROPIC_MODEL
    process.env[providerEnvVar] = '1'
    // undefined, not null: a null override IS the provider-local Default and
    // would mask the settings file this test is about.
    setMainLoopModelOverride(undefined)
    setSessionProvider(null)
    resetSettingsCache()

    body()
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    if (previousModel === undefined) delete process.env.CAT_CODE_MODEL
    else process.env.CAT_CODE_MODEL = previousModel
    if (previousAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = previousAnthropicModel
    if (previousProviderEnv === undefined) delete process.env[providerEnvVar]
    else process.env[providerEnvVar] = previousProviderEnv
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  }
}

// The desktop half of the CLI rule fixed in `c20ce67` (`src/main.tsx:2147`).
// The flag came from getUserSpecifiedModelSetting(), which folds in the
// settings FILE, so `{"model":"sonnet"}` counted as a provider-selection event
// and pulled a CLAUDE_CODE_USE_OPENAI=1 desktop session onto Anthropic while
// the user had asked for OpenAI. Env levers outrank saved settings.
test('a settings-file model does not beat CLAUDE_CODE_USE_OPENAI on desktop startup', () => {
  withSettingsFileStartup({ model: 'sonnet' }, 'CLAUDE_CODE_USE_OPENAI', () => {
    expect(initializeSidecarModelProvider()).toBe('sonnet')
    expect(getSessionProvider()).toBe('openai')
  })
})

// The trap in narrowing the flag: a settings-file GPT id must KEEP its implied
// provider. Request routing sends every `gpt-*` id to OpenAI regardless of the
// session provider, so a session left on the implicit provider here would pick
// the Anthropic-shaped tool set (Edit) for requests the Codex adapter serves
// (Apply_patch). Bedrock is the implicit provider because an env var is
// deterministic where the saved startup preference is not.
test('a settings-file GPT model still selects OpenAI on desktop startup', () => {
  withSettingsFileStartup(
    { model: 'gpt-5.6-terra' },
    'CLAUDE_CODE_USE_BEDROCK',
    () => {
      expect(initializeSidecarModelProvider()).toBe('gpt-5.6-terra')
      expect(getSessionProvider()).toBe('openai')
    },
  )
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

test('normal startup appends the desktop file-reference instruction', async () => {
  // The engine's tone section teaches the TERMINAL convention
  // (`src/constants/prompts.ts:502` — bare `file_path:line_number`, an OSC 8
  // hyperlink in the TUI). A renderer has no OSC 8, so a desktop session must
  // carry the markdown-link instruction its transcript can resolve exactly.
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
    process.cwd(),
  )

  // The addendum now leads a longer appended prompt (the peer doctrine follows
  // it), so this asserts it is carried and still first, not that it is alone.
  expect(queryEngineConfig.appendSystemPrompt).toStartWith(
    DESKTOP_SYSTEM_PROMPT_ADDENDUM,
  )
  expect(DESKTOP_SYSTEM_PROMPT_ADDENDUM).toContain('[foo.ts](src/utils/foo.ts)')
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
    // Pick a real headless-safe command out of the live catalog rather than
    // naming one: `/help` used to serve here and is `local-jsx`, so it is now
    // correctly absent (see the local-jsx exclusion assertion below).
    const safeCommand = commands.find(
      command =>
        command.userInvocable !== false &&
        isHeadlessSafeCommand(command) &&
        typeof command.description === 'string' &&
        command.description.length > 0,
    )
    expect(safeCommand).toBeDefined()
    const projected = slashCatalog.find(
      entry => entry.name === safeCommand?.name,
    )
    expect(projected).toBeDefined()
    // The picker's description column — a non-empty string, not just the name.
    expect(typeof projected?.description).toBe('string')
    expect(projected?.description.length).toBeGreaterThan(0)

    // A `local-jsx` command renders an Ink component and resolves to nothing in
    // a non-interactive sidecar session, so it must never reach the picker.
    // Live-path: taken from the real loaded catalog, not a hand-authored stub.
    const inkCommand = commands.find(
      command => command.userInvocable !== false && command.type === 'local-jsx',
    )
    expect(inkCommand).toBeDefined()
    expect(
      slashCatalog.some(entry => entry.name === inkCommand?.name),
    ).toBe(false)

    // SLASH-9: pin a real argumentHint projection, not just help.description.
    // Find any loaded command that actually carries one and prove the
    // projected catalog entry preserved it verbatim (breaking/dropping the
    // `...(command.argumentHint ? { argumentHint } : {})` spread must fail
    // this, unlike the hand-authored stub in sidecarServer.test.ts).
    const commandWithHint = commands.find(
      command =>
        typeof command.argumentHint === 'string' &&
        command.argumentHint.length > 0 &&
        // Must also survive the catalog's headless-safety filter: the first
        // hint-carrying command overall is `local-jsx` and no longer projects.
        command.userInvocable !== false &&
        isHeadlessSafeCommand(command),
    )
    expect(commandWithHint).toBeDefined()
    const projectedHintEntry = slashCatalog.find(
      entry => entry.name === commandWithHint?.name,
    )
    expect(projectedHintEntry?.argumentHint).toBe(commandWithHint?.argumentHint)

    // SLASH-9: exact name-set parity with the engine's own filters applied to
    // the SAME `commands` array — not a re-derivation, so a drift between the
    // independent call sites is caught rather than assumed to stay in sync.
    // Two filters now: `userInvocable !== false`
    // (src/utils/messages/systemInit.ts:69-71) and headless-safety, the shared
    // predicate the engine's own `commandsHeadless` path uses in src/main.tsx.
    const engineSlashCommandNames = commands
      .filter(c => c.userInvocable !== false)
      .filter(isHeadlessSafeCommand)
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

test('resumed startup reuses its agent snapshot and preserves durable app state', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'catcode-resume-bootstrap-'))
  mkdirSync(join(cwd, '.cat-code', 'agents'), { recursive: true })
  writeFileSync(
    join(cwd, '.cat-code', 'agents', 'resume-reviewer.md'),
    `---
name: resume-reviewer
description: "Review a restored session"
tools: Read, Grep
---

Review the restored session.
`,
  )
  const goal = {
    threadId: 'resume-thread',
    goalId: 'resume-goal',
    objective: 'Finish the restored task',
    status: 'active' as const,
    tokensUsed: 12,
    timeUsedSeconds: 3,
    createdAtMs: 1,
    updatedAtMs: 2,
  }
  try {
    clearAgentDefinitionsCache()
    const agentDefinitions = await loadAgentDefinitionsForRuntime(cwd)
    const resumedInitialState = {
      ...getDefaultAppState(),
      agent: 'resume-reviewer',
      agentDefinitions,
      threadGoal: goal,
    }

    const session = await createSidecarSessionController({
      probe: false,
      cwd,
      agentDefinitions,
      resumedInitialState,
    })

    // The supplied catalog is the one QueryEngine and the Agent read seam use;
    // a resume must not reload an independently drifting set after restoration.
    expect(
      session.agentConfig?.getSnapshot()?.definitions.some(
        definition => definition.agentType === 'resume-reviewer' && definition.active,
      ),
    ).toBe(true)
    expect(session.goals?.getSnapshot()).toMatchObject({
      threadId: goal.threadId,
      goalId: goal.goalId,
      objective: goal.objective,
      status: goal.status,
    })
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
  expect(tasks?.getSnapshot()).toEqual({
    items: [],
    subagents: [],
    hasForegroundTask: false,
  })
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
    expect(context.isBypassPermissionsModeAvailable).toBe(true)
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

// The launch flag is gone (§3, amended 2026-08-11), so setting it here proves
// the removed lever cannot re-enable bypass against managed policy.
test('PERMISSION-BOUNDARY §3 — managed bypass policy disables the mode, legacy launch flag or not', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'catcode-bypass-policy-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousAllowBypass = process.env.CATCODE_ALLOW_BYPASS
  try {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: { disableBypassPermissionsMode: 'disable' },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CATCODE_ALLOW_BYPASS = '1'
    resetSettingsCache()

    const context = await loadSidecarToolPermissionContext()

    expect(context.isBypassPermissionsModeAvailable).toBe(false)
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    if (previousAllowBypass === undefined) delete process.env.CATCODE_ALLOW_BYPASS
    else process.env.CATCODE_ALLOW_BYPASS = previousAllowBypass
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('PEER-SESSIONS §4 — a desktop session carries the peer tools the terminal never sees', async () => {
  // The unwired-feature check (CLAUDE.md §8 rule 7). The tools exist only
  // because this list appends them after the engine's own; if that append is
  // dropped, the tools compile, their tests pass, and no model can call them.
  const { queryEngineConfig, tools } = await createNormalSidecarQueryEngineConfig(
    process.cwd(),
  )

  const names = queryEngineConfig.tools.map(tool => tool.name)
  // All FOUR, not just the pair a given session happened to build. A tool that
  // is exported but never appended here compiles, passes its own tests, and is
  // unreachable by any model: that is the failure this test exists for, and it
  // has to be able to see every tool the feature ships.
  expect(names).toContain('ListPeers')
  expect(names).toContain('CreatePeer')
  expect(names).toContain('SendToPeer')
  expect(names).toContain('ReadPeer')
  // Appended, not substituted: the engine's own tools are still there.
  expect(names).toContain('Bash')
  // The same array the session-actions export and the context breakdown read,
  // so those describe one session rather than two.
  expect(tools.map(tool => tool.name)).toEqual(names)
})

test('the spawn run defaults treat an empty env value as absent, never as a value', () => {
  // The contract the supervisor states on `SpawnConfig`: all five peer keys are
  // written on EVERY spawn, empty when the host had no value, because a key
  // merely left unset would be inherited from main's own environment. A reader
  // that tests for presence starts the session on the empty-string model.
  expect(readSpawnModel({ CATCODE_SIDECAR_MODEL: '' })).toBeUndefined()
  expect(readSpawnModel({})).toBeUndefined()
  expect(readSpawnModel({ CATCODE_SIDECAR_MODEL: 'gpt-5.6-luna' })).toBe(
    'gpt-5.6-luna',
  )
  expect(readSpawnEffort({ CATCODE_SIDECAR_EFFORT: '' })).toBeUndefined()
  expect(readSpawnEffort({ CATCODE_SIDECAR_EFFORT: 'high' })).toBe('high')
  // An unrecognised value degrades to the user's saved effort rather than
  // failing the boot or reaching the engine as a level it does not know.
  expect(readSpawnEffort({ CATCODE_SIDECAR_EFFORT: 'whatever' })).toBeUndefined()
})

test('a created peer boots on the spawn model, and a resumed session keeps its own', () => {
  // PEER-SESSIONS R7 / HOST-REQUEST-PLANE §5. Precedence, top down: a resumed
  // transcript's model, then the spawn model, then the saved setting. The first
  // two are mutually exclusive in practice (main sends run defaults only on the
  // create spawn, never on a restart), so the order records which one owns the
  // choice rather than resolving a live tie.
  const previousOverride = getMainLoopModelOverride()
  const previousProvider = getSessionProvider()
  try {
    setMainLoopModelOverride(undefined)
    setSessionProvider(null)
    expect(
      initializeSidecarModelProvider(undefined, 'claude-haiku-4-5-20251001'),
    ).toBe('claude-haiku-4-5-20251001')
    expect(getMainLoopModelOverride()).toBe('claude-haiku-4-5-20251001')

    setMainLoopModelOverride(undefined)
    setSessionProvider(null)
    expect(
      initializeSidecarModelProvider('claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'),
    ).toBe('claude-sonnet-4-5-20250929')
  } finally {
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
  }
})

test('a spawn model decides the provider, exactly as a resumed one does', () => {
  // A model chosen for THIS session is a provider-selection event. Without
  // that, a peer created on a Claude model inside an OpenAI-flagged environment
  // would boot pointed at the wrong provider.
  const previousOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
  const previousOverride = getMainLoopModelOverride()
  const previousProvider = getSessionProvider()
  try {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    setMainLoopModelOverride(undefined)
    setSessionProvider(null)

    initializeSidecarModelProvider(undefined, 'claude-haiku-4-5-20251001')

    expect(getSessionProvider()).toBe('firstParty')
  } finally {
    if (previousOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
    else process.env.CLAUDE_CODE_USE_OPENAI = previousOpenAI
    setMainLoopModelOverride(previousOverride)
    setSessionProvider(previousProvider)
  }
})

test('PEER-SESSIONS §5 — the doctrine names this session and its creator, or says neither', () => {
  const both = buildPeerDoctrine({
    name: 'Bear',
    createdByName: 'Alex',
    createdById: 'alex-app-session-id',
  })
  expect(both).toStartWith(
    "You are Bear. Alex created you.\n\nWhen you are working from a peer's request",
  )

  // A user-created session omits the creator sentence (§5). It must not gain a
  // sentence about a creator that does not exist.
  const userCreated = buildPeerDoctrine({
    name: 'Bear',
    createdByName: null,
    createdById: null,
  })
  expect(userCreated).toStartWith(
    "You are Bear.\n\nWhen you are working from a peer's request",
  )
  // The guideline paragraph says "who created you" to every session, so what
  // must be absent is the identity SENTENCE, not the words.
  expect(userCreated.split('\n\n')[0]).toBe('You are Bear.')

  // No name at all: no name sentence, rather than a sentence with a hole in it.
  // The block then opens on the guideline itself, with no empty first line.
  const unnamed = buildPeerDoctrine({
    name: null,
    createdByName: null,
    createdById: null,
  })
  expect(unnamed).toStartWith(
    "When you are working from a peer's request",
  )
  expect(unnamed).not.toContain('You are ')
  // The rest of the doctrine still applies: an unnamed session still gets the
  // whole guideline, including the create-only-when-asked rule.
  expect(unnamed).toContain(
    'nothing obliges an acknowledgment; a short okay or silence can both be right',
  )
  // The relay to the user carries the outcome, not the peer's evidence: one
  // creator reproduced its peer's whole command list and the user read the
  // same commit twice (docs/prompts/2026-09-06-peer-exchange-register.md §8).
  expect(unnamed).toContain(
    'summarize it faithfully as an outcome, not as evidence: the commands and their results belong in the tab of the session that ran them',
  )
  expect(unnamed).toContain("the run is in Bear's tab")
  expect(unnamed).toContain(
    'when they ask for a prompt, write text; do not create one unasked',
  )

  // Paragraph breaks only. The decision document's hard wraps are its own
  // 80-column layout, not part of the text, and a sentence broken mid-clause is
  // not what the appended prompt should carry.
  for (const paragraph of both.split('\n\n')) {
    expect(paragraph).not.toContain('\n')
  }
})

test('PEER-SESSIONS §5 — a peer report replaces the local final without cancelling user replies', () => {
  const doctrine = buildPeerDoctrine({
    name: 'Bear',
    createdByName: 'Alex',
    createdById: 'alex-app-session-id',
  })

  expect(doctrine).toContain(
    "that peer is your audience. Send the requested answer, result, blocker, or completion report with SendToPeer",
  )
  expect(doctrine).toContain(
    'After SendToPeer succeeds, STOP. Do not repeat, summarize, or reproduce that report in your own final response',
  )
  expect(doctrine).toContain(
    'This rule overrides the ordinary instruction to give the user a self-contained final report',
  )
  expect(doctrine).toContain(
    'answer that message normally here too. This does not cancel or redirect the report to the peer',
  )
  expect(doctrine).toContain(
    'A message from another peer does not count as the user speaking to you',
  )
})

test('the doctrine is assembled from the spawn env, empty strings and all', () => {
  // The only source it can have: the appended prompt is fixed when the
  // controller is built, before there is a socket to ask main anything on.
  expect(readPeerIdentity({})).toEqual({
    name: null,
    createdByName: null,
    createdById: null,
  })
  expect(
    readPeerIdentity({
      CATCODE_SIDECAR_NAME: '',
      CATCODE_SIDECAR_CREATED_BY_NAME: '',
      CATCODE_SIDECAR_CREATED_BY: '',
    }),
  ).toEqual({ name: null, createdByName: null, createdById: null })
  expect(
    readPeerIdentity({
      CATCODE_SIDECAR_NAME: 'Bear',
      CATCODE_SIDECAR_CREATED_BY_NAME: 'Alex',
      CATCODE_SIDECAR_CREATED_BY: 'alex-app-session-id',
    }),
  ).toEqual({
    name: 'Bear',
    createdByName: 'Alex',
    // F17 — the id is read beside the name, and by the same empty-is-absent
    // rule. It is what a send to the creator is checked against; the name is
    // only what the model writes.
    createdById: 'alex-app-session-id',
  })

  const prompt = buildDesktopSystemPrompt({
    name: 'Bear',
    createdByName: 'Alex',
    createdById: 'alex-app-session-id',
  })
  expect(prompt).toStartWith(DESKTOP_SYSTEM_PROMPT_ADDENDUM)
  expect(prompt).toContain('You are Bear.')
})
