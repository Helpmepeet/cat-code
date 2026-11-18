// Run via verify-model-replacement.ts, which supplies disposable settings and a
// catalog-only source mutation. Pin the substituted release and exact wire
// behavior; unrelated families follow the catalog.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCurrentUsageModel, isRetiredUsageModel } from '../app/shared/usageModelStatus.js'
import { buildRunControlsSnapshot } from '../app/sidecar/runControlsDomain.js'
import { setMainLoopModelOverride, setSessionProvider } from '../src/bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../src/Tool.js'
import { getSystemPrompt } from '../src/constants/prompts.js'
import { CURRENT_MIGRATION_VERSION, runEngineMigrations } from '../src/migrations/runEngineMigrations.js'
import { queryModelWithStreaming } from '../src/services/api/claude.js'
import { mapClaudeModelToCodex, requireExactCodexModel, translateToCodexBody } from '../src/services/api/codex-fetch-adapter.js'
import { inputSchema as agentInputSchema } from '../src/tools/AgentTool/AgentTool.js'
import { getDefaultAppState } from '../src/state/AppStateStore.js'
import { enableConfigs } from '../src/utils/config.js'
import { getVertexRegionForModel } from '../src/utils/envUtils.js'
import { getGlobalClaudeFile } from '../src/utils/env.js'
import { getModelMaxOutputTokens, modelSupports1M, resolveNativeContextWindow } from '../src/utils/context.js'
import { getSupportedEffortLevels, modelSupportsEffort } from '../src/utils/effort.js'
import { getFastModeModel } from '../src/utils/fastMode.js'
import { createUserMessage } from '../src/utils/messages.js'
import { AGENT_MODEL_OPTIONS, resolveAgentModel } from '../src/utils/model/agent.js'
import { getBedrockInferenceProfiles } from '../src/utils/model/bedrock.js'
import { currentClaudeRelease, currentCodexRelease, getClaudeFamilyKey, getClaudeRelease } from '../src/utils/model/configs.js'
import { ensureModelStringsInitialized } from '../src/utils/model/modelStrings.js'
import {
  getDefaultCodexModel, getMarketingNameForModel, getRuntimeMainLoopModel,
  getSmallFastModelForProvider, normalizeModelStringForAPI, parseUserSpecifiedModel, renderDefaultModelSetting,
} from '../src/utils/model/model.js'
import { getModelCosts } from '../src/utils/modelCost.js'
import { EMPTY_USAGE } from '../src/services/api/emptyUsage.js'
import { getConfiguredStandardModelCosts } from '../src/utils/modelCostRates.js'
import { getModelOptions } from '../src/utils/model/modelOptions.js'
import { validateModel } from '../src/utils/model/validateModel.js'
import { _forTest as classifier, YOLO_CLASSIFIER_TOOL_NAME } from '../src/utils/permissions/yoloClassifier.js'
import { getAutoModeClassifierAttempts } from '../src/utils/permissions/autoModeProviderLadder.js'
import { updateSettingsForSource } from '../src/utils/settings/settings.js'
import { asSystemPrompt } from '../src/utils/systemPromptType.js'
import { modelSupportsAdaptiveThinking } from '../src/utils/thinking.js'

const scenario = process.argv[2]
const model = 'gpt-catalog-fixture-sol'
const wire = 'Catalog-Fixture.Responses'
const predecessor = 'gpt-6.2-sol'
const priorWire = 'Catalog-Prior.Responses'
const label = 'Catalog Fixture Sol'
const configDir = process.env.CLAUDE_CONFIG_DIR
assert.ok(configDir && configDir.startsWith(process.cwd() + '/.home/'))
mkdirSync(configDir, { recursive: true })
writeFileSync(getGlobalClaudeFile(), JSON.stringify({
  migrationVersion: CURRENT_MIGRATION_VERSION,
  codexOAuth: {
    accountId: 'offline-fixture', accessToken: 'offline-fixture',
    refreshToken: 'offline-fixture', expiresAt: Date.now() + 3_600_000,
  },
}))
globalThis.fetch = Object.assign(async () => {
  throw new Error('Offline fixture attempted a network request')
}, { preconnect: globalThis.fetch.preconnect })
enableConfigs()
setSessionProvider(scenario === 'codex' ? 'openai' : 'firstParty')

let failures = 0
async function check(name: string, run: () => void | Promise<void>) {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${name}`, error)
  }
}

function request(selection: string | null, thinking = false) {
  return translateToCodexBody({
    model: selection,
    thinking,
    _openaiInstructionAssembly: { instructions: 'Offline fixture', inputMessages: [] },
  }).codexBody
}

async function verifyCodex() {
  const astra = currentCodexRelease('astra')
  const terra = currentCodexRelease('terra')
  const luna = currentCodexRelease('luna')
  await check('new Codex chat and terminal model selection', async () => {
    assert.equal(getDefaultCodexModel(), model)
    assert.deepEqual(getModelOptions().slice(1, 5).map(({ value, label }) => [value, label]), [
      [astra.id, astra.label], [model, label], [terra.id, terra.label], [luna.id, luna.label],
    ])
    assert.deepEqual(await validateModel(model), { valid: true })
  })

  await check('desktop run controls', () => {
    const state = buildRunControlsSnapshot(getDefaultAppState())
    assert.equal(state.model.current, model)
    assert.equal(state.model.currentLabel, label)
    assert.equal(resolveNativeContextWindow(model).window, 618_000)
    assert.equal(resolveNativeContextWindow(wire).window, 618_000)
    assert.equal(resolveNativeContextWindow(model + '[1m]').window, 618_000)
    assert.deepEqual(getSupportedEffortLevels(wire), ['low', 'medium'])
    assert.equal(state.model.contextWindow, 598_000)
    assert.deepEqual(state.effort.options, ['low', 'medium'])
  })

  await check('Agent tool schema and child provider request', () => {
    assert.ok(AGENT_MODEL_OPTIONS.some((value: string) => value === model))
    const selection = agentInputSchema().safeParse({ prompt: 'Offline child', description: 'Offline child', model })
    assert.ok(selection.success)
    const child = resolveAgentModel('inherit', 'claude-sonnet-5-5', selection.data.model, undefined, 'firstParty')
    assert.deepEqual(child, { model, provider: 'openai' })
    assert.equal(request(child.model).model, wire)
    assert.deepEqual(request(child.model).reasoning, { effort: 'none' })
  })

  await check('outbound model and disabled thinking', () => {
    const body = request(model)
    assert.equal(body.model, wire)
    assert.deepEqual(body.reasoning, { effort: 'none' })
  })

  await check('purpose-specific defaults and legacy adapter members', () => {
    assert.equal(getSmallFastModelForProvider(), luna.id)
    assert.equal(getFastModeModel(), model)
    assert.equal(request(null).model, terra.wireId ?? terra.id)
    assert.equal(request('sonnet').model, luna.wireId ?? luna.id)
    assert.equal(request('opus').model, wire)
    assert.equal(request('gpt-5.1-codex').model, 'gpt-5.1-codex')
    assert.deepEqual(getAutoModeClassifierAttempts('sonnet', 4, 'firstParty'), [
      { provider: 'firstParty', model: 'sonnet' },
      { provider: 'openai', model },
      { provider: 'openai', model: terra.id },
      { provider: 'openai', model: luna.id },
    ])
  })

  await check('recorded model identity in prompts and Usage', async () => {
    assert.equal(getMarketingNameForModel(predecessor), 'GPT-6.2 Sol')
    assert.equal(getMarketingNameForModel(priorWire), 'Catalog Prior Sol')
    const usage = (id: string) => ({ id, kind: 'named' as const, label: id })
    assert.ok(isCurrentUsageModel(usage(model)))
    assert.ok(isCurrentUsageModel(usage(wire)))
    assert.ok(isRetiredUsageModel(usage('gpt-6.1-sol')))
    assert.equal(isRetiredUsageModel(usage(priorWire)), false)
    const prompt = (await getSystemPrompt([], model, [], [], 'openai')).join('\n')
    assert.match(prompt, /You are powered by the model named Catalog Fixture Sol\. The exact model ID is gpt-catalog-fixture-sol\./)
    const historical = (await getSystemPrompt([], predecessor, [], [], 'openai')).join('\n')
    assert.match(historical, /You are powered by the model named GPT-6\.2 Sol\. The exact model ID is gpt-6\.2-sol\./)
  })

  await check('retired selections and persisted settings on current migration version', async () => {
    const file = join(configDir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      model: predecessor,
      availableModels: ['gpt-6.1-sol', predecessor, model, priorWire, luna.id],
      modelOverrides: { [predecessor]: 'old-override', [model]: 'successor-override' },
    }))
    await runEngineMigrations()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      model,
      availableModels: [model, luna.id],
      modelOverrides: { [model]: 'successor-override' },
    })
    const before = statSync(file, { bigint: true })
    await runEngineMigrations()
    assert.equal(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs)
    assert.equal(mapClaudeModelToCodex(predecessor), wire)
    assert.equal(mapClaudeModelToCodex(priorWire), wire)
    assert.throws(() => requireExactCodexModel(predecessor), /Expected exact Codex model gpt-6\.2-sol; this engine routes it to Catalog-Fixture\.Responses/)
    assert.throws(() => requireExactCodexModel(priorWire), /Expected exact Codex model Catalog-Prior\.Responses/)
    requireExactCodexModel('gpt-5.1-codex')
  })

}

async function verifyClaude() {
  const successor = 'claude-catalog-sonnet'
  const opus = currentClaudeRelease('opus')
  const haiku = currentClaudeRelease('haiku')
  const fable = currentClaudeRelease('fable')
  const cloudFableWire = getClaudeRelease(getClaudeFamilyKey('fable', true)).wire
  await check('Claude picker, first-party defaults, and independent pin', async () => {
    assert.equal(parseUserSpecifiedModel('sonnet'), successor)
    assert.equal(parseUserSpecifiedModel('opus'), opus.wire.firstParty)
    assert.equal(parseUserSpecifiedModel('haiku'), haiku.wire.firstParty)
    assert.equal(parseUserSpecifiedModel('best'), fable.wire.firstParty)
    assert.equal(getModelOptions().find(row => row.value === 'fable')?.label, fable.label)
    assert.equal(parseUserSpecifiedModel('claude-sonnet-5-5'), 'claude-sonnet-5-5')
    const price = getConfiguredStandardModelCosts(successor)
    assert.equal(price?.inputTokens, 2)
    assert.equal(price?.outputTokens, 10)
    assert.equal(getModelOptions().find(row => row.value === 'sonnet')?.label, 'Catalog Fixture Sonnet')
    assert.equal(buildRunControlsSnapshot(getDefaultAppState()).model.currentLabel, 'Catalog Fixture Sonnet')
    assert.equal(parseUserSpecifiedModel('opusplan'), successor)
    assert.equal(renderDefaultModelSetting('opusplan'), `${opus.label} in plan mode, else Catalog Fixture Sonnet`)
    assert.equal(getMarketingNameForModel(successor + '[1m]'), 'Catalog Fixture Sonnet (with 1M context)')
    setMainLoopModelOverride('opusplan')
    assert.equal(getRuntimeMainLoopModel({ permissionMode: 'plan', mainLoopModel: successor }), opus.wire.firstParty)
    setMainLoopModelOverride(undefined)
    const child = resolveAgentModel('sonnet', opus.wire.firstParty, undefined, 'default', 'firstParty')
    assert.deepEqual(child, { model: successor, provider: 'firstParty' })
    assert.equal(resolveAgentModel('sonnet', 'claude-sonnet-5-5[1m]').model, 'claude-sonnet-5-5[1m]')
    const prompt = (await getSystemPrompt([], successor, [], [], 'firstParty')).join('\n')
    assert.match(prompt, /Catalog Fixture Sonnet: 'claude-catalog-sonnet'/)
  })

  await check('Claude provider request sends the successor and its thinking contract', async () => {
    process.env.ANTHROPIC_API_KEY = 'offline-fixture'
    process.env.CLAUDE_CODE_SIMPLE = '1'
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO = { VERSION: 'fixture' }
    const bodies: Record<string, unknown>[] = []
    const fetchOverride = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      return Response.json({
        id: 'msg_catalog', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'Offline fixture response' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      })
    }) as typeof fetch
    // The transport response can be a stream or a recovery response. Both must
    // preserve the same model and required thinking fields.
    for await (const _event of queryModelWithStreaming({
      messages: [createUserMessage({ content: 'Offline catalog verification' })],
      systemPrompt: asSystemPrompt(['Offline verification']),
      thinkingConfig: { type: 'disabled' }, tools: [], signal: AbortSignal.timeout(5_000),
      options: {
        model: parseUserSpecifiedModel('sonnet'), provider: 'firstParty', querySource: 'sdk',
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        isNonInteractiveSession: true, agents: [], mcpTools: [],
        hasAppendSystemPrompt: false, fetchOverride,
      },
    })) {}
    assert.ok(bodies.length)
    for (const body of bodies) {
      assert.equal(body.model, successor)
      assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    }
  })

  await check('Vertex, Foundry, and Bedrock defaults, overrides and child pins', async () => {
    setSessionProvider('vertex')
    assert.equal(parseUserSpecifiedModel('sonnet[1m]'), 'claude-sonnet-4-5@20250929[1m]')
    assert.equal(parseUserSpecifiedModel('opus'), 'claude-opus-4-6')
    assert.equal(parseUserSpecifiedModel('haiku'), 'claude-haiku-4-5@20251001')
    assert.equal(parseUserSpecifiedModel('fable'), cloudFableWire.vertex)
    process.env.VERTEX_REGION_CLAUDE_4_5_SONNET = 'europe-west1'
    process.env.CLOUD_ML_REGION = 'europe-west4'
    assert.equal(getVertexRegionForModel('claude-sonnet-4-5@20250929'), 'europe-west1')
    assert.equal(getVertexRegionForModel('tenant-claude-sonnet-4-5-custom'), 'europe-west4')

    setSessionProvider('foundry')
    assert.equal(parseUserSpecifiedModel('sonnet'), 'claude-sonnet-4-5')
    assert.equal(parseUserSpecifiedModel('haiku'), 'claude-haiku-4-5')
    assert.equal(parseUserSpecifiedModel('fable'), cloudFableWire.foundry)
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'CustomDeployment'
    assert.equal(parseUserSpecifiedModel('sonnet'), 'CustomDeployment')
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    assert.equal(parseUserSpecifiedModel(' CustomDeployment[1M] '), 'CustomDeployment[1m]')
    assert.deepEqual(getSupportedEffortLevels('tenant-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(modelSupportsEffort('tenant-opus-5-5'), true)
    assert.equal(modelSupportsAdaptiveThinking('tenant-opus-5-5'), true)
    assert.deepEqual(getModelMaxOutputTokens('tenant-opus-5-5'), { default: 64_000, upperLimit: 128_000 })
    assert.equal(modelSupports1M('tenant-opus-4-6'), true)

    getBedrockInferenceProfiles.cache.set(undefined, Promise.resolve([
      'us.anthropic.claude-opus-4-6-v1', 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    ]))
    setSessionProvider('bedrock')
    await ensureModelStringsInitialized()
    assert.equal(parseUserSpecifiedModel('sonnet'), 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0')
    assert.equal(parseUserSpecifiedModel('opus'), 'us.anthropic.claude-opus-4-6-v1')
    assert.equal(parseUserSpecifiedModel('haiku'), 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
    assert.equal(parseUserSpecifiedModel('fable'), cloudFableWire.bedrock)
    setMainLoopModelOverride('opusplan')
    assert.deepEqual(resolveAgentModel('inherit', successor, undefined, 'plan', 'firstParty'), {
      model: opus.wire.firstParty, provider: 'firstParty',
    })
    setMainLoopModelOverride(undefined)
    setSessionProvider('openai')
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    assert.deepEqual(resolveAgentModel('sonnet ', 'gpt-6.2-sol', undefined, 'default', 'openai'), {
      model: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', provider: 'bedrock',
    })
    assert.deepEqual(resolveAgentModel('haiku[1m]', 'gpt-6.2-sol', undefined, 'default', 'openai'), {
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0[1m]', provider: 'bedrock',
    })
    assert.deepEqual(resolveAgentModel('sonnet', opus.wire.firstParty, undefined, 'default', 'firstParty'), {
      model: successor, provider: 'firstParty',
    })
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gpt-6.2-sol'
    assert.deepEqual(resolveAgentModel('sonnet', opus.wire.firstParty, undefined, 'default', 'firstParty'), {
      model: 'gpt-6.2-sol', provider: 'openai',
    })
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    setSessionProvider('bedrock')
    const parent = 'eu.anthropic.claude-opus-4-6-v1[1m]'
    assert.deepEqual(resolveAgentModel('opus', parent, undefined, 'default', 'bedrock'), {
      model: parent, provider: 'bedrock',
    })
    const pinned = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    assert.equal(resolveAgentModel(pinned, parent, undefined, 'default', 'bedrock').model, pinned)
    assert.equal(normalizeModelStringForAPI(parent), 'eu.anthropic.claude-opus-4-6-v1')

    const profile = 'arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/catalog-fixture'
    const { error } = updateSettingsForSource('userSettings', {
      modelOverrides: { 'claude-sonnet-4-5-20250929': profile },
    })
    if (error) throw error
    assert.equal(parseUserSpecifiedModel('sonnet'), profile)
    assert.equal(getMarketingNameForModel(profile), 'Sonnet 4.5')
  })
}

async function verifyTerra() {
  await check('Terra successor preserves exact live and retained pricing', () => {
    const current = 'gpt-catalog-fixture-terra'
    const original = 'gpt-6.1-terra'
    assert.equal(request(null).model, current)
    assert.equal(getConfiguredStandardModelCosts(current)?.inputTokens, 1)
    assert.equal(getConfiguredStandardModelCosts(original)?.inputTokens, 1)
    assert.equal(getConfiguredStandardModelCosts(current + '-unknown'), undefined)
    assert.equal(getModelCosts(current, { ...EMPTY_USAGE, input_tokens: 272_001 }).outputTokens, 7.5)
  })
}

async function verifyStartup() {
  await check('startup preserves pins when user settings configure a cloud provider', async () => {
    const file = join(configDir, 'settings.json')
    const settings = { model: 'claude-sonnet-4-6', env: { CLAUDE_CODE_USE_VERTEX: '1' } }
    writeFileSync(file, JSON.stringify(settings))
    const { init } = await import('../src/entrypoints/init.js')
    await init()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), settings)
  })
}

async function verifyReviewer() {
  const successor = 'gpt-catalog-fixture-luna'
  process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'gpt-6-luna'
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'offline-fixture'
  await check('reviewer successor receives full stage policy and evidence', async () => {
    const context = { ...getEmptyToolPermissionContext(), mode: 'auto' as const }
    const instructions = 'Contents of /offline/AGENTS.md:\n# Code style\nUse two spaces for indentation.'
    const action = {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun run build' } }],
    } as Parameters<typeof classifier.classifyYoloAction>[1]
    const tools = [{
      name: 'Bash',
      toAutoClassifierInput: (input: { command: string }) => input.command,
    }] as unknown as Parameters<typeof classifier.classifyYoloAction>[2]
    type SideQuery = Parameters<typeof classifier.classifyYoloActionWithSideQuery>[5]
    for (const inputVariant of [undefined, 'reduced'] as const) {
      const requests: Array<Parameters<SideQuery>[0]> = []
      await classifier.classifyYoloActionWithSideQuery(
        [createUserMessage({ content: 'Run the local build.' })],
        action, tools, context, AbortSignal.timeout(5_000),
        (async request => {
          requests.push(request)
          return {
            id: 'msg_fixture', model: request.model,
            content: [{ type: 'tool_use', name: YOLO_CLASSIFIER_TOOL_NAME, input: { shouldBlock: false } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }) as SideQuery,
        undefined,
        { instructionContext: instructions, inputVariant },
      )
      assert.equal(requests.length, 1)
      assert.equal(requests[0]!.model, successor)
      assert.equal(JSON.stringify(requests[0]!.system).includes('## User Intent Rule'), inputVariant === undefined)
      assert.equal(JSON.stringify(requests[0]!.messages).includes('Use two spaces for indentation.'), inputVariant === undefined)
    }
  })
}

if (scenario === 'codex') await verifyCodex()
else if (scenario === 'claude') await verifyClaude()
else if (scenario === 'reviewer') await verifyReviewer()
else if (scenario === 'terra') await verifyTerra()
else if (scenario === 'startup') await verifyStartup()
else throw new Error('Expected a codex, claude, reviewer, terra, or startup scenario')
process.exitCode = failures ? 1 : 0
