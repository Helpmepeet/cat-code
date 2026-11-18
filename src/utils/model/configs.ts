/** Keep the model catalog dependency-light: retained-history workers import it
 * without loading the live auth/settings model graph. */
export type ModelConfig = Record<
  'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai',
  string
>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
  openai: 'claude-3-7-sonnet-20250219',
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
  openai: 'claude-3-5-sonnet-20241022',
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
  openai: 'claude-3-5-haiku-20241022',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
  openai: 'claude-haiku-4-5-20251001',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
  openai: 'claude-sonnet-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
  openai: 'claude-sonnet-4-5-20250929',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
  openai: 'claude-opus-4-20250514',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
  openai: 'claude-opus-4-1-20250805',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
  openai: 'claude-opus-4-5-20251101',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
  openai: 'claude-opus-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
  openai: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_CONFIG = {
  firstParty: 'claude-sonnet-5',
  bedrock: 'us.anthropic.claude-sonnet-5-v1',
  vertex: 'claude-sonnet-5',
  foundry: 'claude-sonnet-5',
  openai: 'claude-sonnet-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_CONFIG = {
  firstParty: 'claude-opus-5',
  bedrock: 'us.anthropic.claude-opus-5-v1',
  vertex: 'claude-opus-5',
  foundry: 'claude-opus-5',
  openai: 'claude-opus-5',
} as const satisfies ModelConfig

export const CLAUDE_SONNET_5_5_CONFIG = {
  firstParty: 'claude-sonnet-5-5',
  bedrock: 'anthropic.claude-sonnet-5-5',
  vertex: 'claude-sonnet-5-5',
  foundry: 'claude-sonnet-5-5',
  openai: 'claude-sonnet-5-5',
} as const satisfies ModelConfig

export const CLAUDE_OPUS_5_5_CONFIG = {
  firstParty: 'claude-opus-5-5',
  bedrock: 'anthropic.claude-opus-5-5',
  vertex: 'claude-opus-5-5',
  foundry: 'claude-opus-5-5',
  openai: 'claude-opus-5-5',
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_5_5_CONFIG = {
  firstParty: 'claude-haiku-5-5',
  bedrock: 'anthropic.claude-haiku-5-5',
  vertex: 'claude-haiku-5-5',
  foundry: 'claude-haiku-5-5',
  openai: 'claude-haiku-5-5',
} as const satisfies ModelConfig

export const CLAUDE_FABLE_5_CONFIG = {
  firstParty: 'claude-fable-5',
  bedrock: 'us.anthropic.claude-fable-5-v1',
  vertex: 'claude-fable-5',
  foundry: 'claude-fable-5',
  openai: 'claude-fable-5',
} as const satisfies ModelConfig

type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

type CodexRelease = {
  id: string
  wireId?: string
  label?: string
  publicLabel?: string
  pickerDescription?: string
  pickerDetail?: string
  agentDescription?: string
  adapterDescription?: string
  promptFamily?: 'gpt-5.6' | 'gpt-6'
  context?: { window: number; source: 'gpt_6_codex' | 'gpt_5_6_codex' }
  efforts?: readonly CodexEffort[]
  defaultEffort?: CodexEffort
  minimalOnWire?: 'low' | 'none'
  maxOnWire?: 'max'
  ultraOnWire?: 'ultra' | 'max'
  appendOnlyTools?: boolean
  autoCompactCeiling?: number
  fastMode?: boolean
  usage?: 'retired' | 'solLuna'
}

const codexMax = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const codexUltra = [...codexMax, 'ultra'] as const
const codex6 = { promptFamily: 'gpt-6', appendOnlyTools: true, fastMode: true } as const
const codexWindow = (window: number) => ({ window, source: 'gpt_6_codex' } as const)
const codex56Window = (window: number) => ({ window, source: 'gpt_5_6_codex' } as const)

// The first release in each family is selectable. Earlier releases retain
// their facts for replay and usage, and follow the family for new selections.
const terra61Id = 'gpt-6.1-terra'

const CODEX_FAMILIES = {
  astra: [
    {
      ...codex6,
      id: 'gpt-6.2-astra',
      label: 'GPT-6.2 Astra',
      pickerDescription: 'Most capable for complex work',
      pickerDetail: 'Most capable GPT model for complex work',
      agentDescription: 'Most capable GPT model for complex work',
      adapterDescription: 'Most capable model for complex work',
      context: codexWindow(272_000),
      efforts: codexUltra,
      minimalOnWire: 'low',
      maxOnWire: 'max',
      ultraOnWire: 'ultra',
    },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', promptFamily: 'gpt-6', usage: 'retired' },
    { id: 'gpt-6.1-astra' },
  ],
  sol: [
    {
      ...codex6,
      id: 'gpt-6.2-sol',
      label: 'GPT-6.2 Sol',
      pickerDescription: 'Complex coding and agentic workflows',
      agentDescription: 'Complex coding and agentic workflows',
      adapterDescription: 'Frontier model for complex professional work',
      context: codexWindow(500_000),
      efforts: codexUltra,
      defaultEffort: 'medium',
      minimalOnWire: 'low',
      maxOnWire: 'max',
      ultraOnWire: 'ultra',
    },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', promptFamily: 'gpt-6', usage: 'retired' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', promptFamily: 'gpt-6', usage: 'solLuna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', context: codex56Window(1_000_000), autoCompactCeiling: 900_000, usage: 'retired' },
  ],
  terra: [
    {
      ...codex6,
      id: terra61Id,
      label: 'GPT-6.1 Terra',
      pickerDescription: 'Fast visual reasoning, computer use, and writing',
      agentDescription: 'Fast visual reasoning, computer use, and writing',
      adapterDescription: 'Fast visual reasoning, computer use, and writing',
      context: codexWindow(1_050_000),
      efforts: codexMax,
      defaultEffort: 'medium',
      minimalOnWire: 'none',
      maxOnWire: 'max',
      ultraOnWire: 'max',
    },
    {
      id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', usage: 'retired',
      context: codex56Window(372_000), efforts: codexUltra, defaultEffort: 'medium',
    },
    { id: 'gpt-5.5' },
  ],
  luna: [
    {
      ...codex6,
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      pickerDescription: 'Efficient model for focused/high-volume work',
      agentDescription: 'Fast GPT-6 option for agentic coding (preview)',
      adapterDescription: 'Fast and affordable agentic coding model (preview)',
      context: codexWindow(1_050_000),
      efforts: codexMax,
      defaultEffort: 'low',
      minimalOnWire: 'none',
      maxOnWire: 'max',
      usage: 'solLuna',
    },
    {
      id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', usage: 'retired',
      context: codex56Window(372_000), efforts: codexMax, defaultEffort: 'low',
      minimalOnWire: 'none', maxOnWire: 'max', fastMode: false,
    },
    { id: 'gpt-5.4' },
    { id: 'gpt-5.3-codex' },
    { id: 'gpt-5.4-mini' },
  ],
} as const satisfies Record<string, readonly [CodexRelease, ...CodexRelease[]]>

export type CodexFamily = keyof typeof CODEX_FAMILIES
export const CODEX_ROUTES = {
  chat: 'sol',
  adapterFallback: 'terra',
  smallFast: 'luna',
  fastMode: 'sol',
  classifier: 'luna',
  explore: 'luna',
  guide: 'luna',
  fromOpus: 'sol',
  fromHaikuOrSonnet: 'luna',
  classifierFallbacks: ['sol', 'terra', 'luna'],
} as const satisfies Record<string, CodexFamily | readonly CodexFamily[]>

const CODEX_ADAPTER_ONLY = [
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', publicLabel: 'Codex 5.2', adapterDescription: 'Frontier agentic coding model' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', publicLabel: 'Codex 5.1', adapterDescription: 'Codex coding model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', publicLabel: 'Codex 5.1 Mini', adapterDescription: 'Fast Codex model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', publicLabel: 'Codex 5.1 Max', adapterDescription: 'Max Codex model' },
  { id: 'gpt-5.2', label: 'GPT-5.2', adapterDescription: 'GPT-5.2' },
] as const satisfies readonly CodexRelease[]

export function currentCodexRelease<F extends CodexFamily>(family: F): (typeof CODEX_FAMILIES)[F][0] & CodexRelease {
  return CODEX_FAMILIES[family][0]
}

export const CURRENT_CODEX_RELEASES: readonly ((typeof CODEX_FAMILIES)[CodexFamily][0] & CodexRelease)[] = Object.values(CODEX_FAMILIES).map(([release]) => release)
export const ROUTABLE_CODEX_RELEASES: readonly (
  CodexRelease & { label: string; adapterDescription: string }
)[] = [
  ...CURRENT_CODEX_RELEASES, ...CODEX_ADAPTER_ONLY,
]

const codexRetirementTargets = new Map<string, string>()
const codexById = new Map<string, CodexRelease>()
const codexFamilies: readonly (readonly [CodexRelease, ...CodexRelease[]])[] = Object.values(CODEX_FAMILIES)
for (const [current, ...older] of codexFamilies) {
  for (const release of older) {
    codexById.set(release.id, release)
    if (release.wireId) codexById.set(release.wireId, release)
    codexRetirementTargets.set(release.id, current.id)
  }
}
for (const release of ROUTABLE_CODEX_RELEASES) {
  codexById.set(release.id, release)
  if (release.wireId) codexById.set(release.wireId, release)
}
const codexIdentityPrefixes = [...new Set(codexById.values())]
  .filter(release => release.promptFamily || release.context)
  .sort((a, b) => b.id.length - a.id.length)

export function getCodexRelease(id: string): CodexRelease | undefined {
  return codexById.get(id)
}

export function matchCodexRelease(model: string): CodexRelease | undefined {
  return codexById.get(model) ?? codexIdentityPrefixes.find(release =>
    model.includes(release.id),
  )
}

export function remapRetiredCodexSelection(model: string): string {
  const base = model.trim().replace(/\[1m\]$/i, '').toLowerCase()
  return codexRetirementTargets.get(base) ?? model
}

function codexConfig<Id extends string>(id: Id) {
  return { firstParty: id, bedrock: id, vertex: id, foundry: id, openai: id }
}

export const GPT_6_1_TERRA_CONFIG = codexConfig(terra61Id)

export function getCodexUsageStatus(model: string): {
  current: boolean
  legacySolLuna: boolean
  retired: boolean
} {
  const lower = model.toLowerCase()
  const release = codexById.get(lower) ?? codexIdentityPrefixes.find(entry =>
    lower.startsWith(entry.id + '-'),
  )
  const current = release !== undefined && CURRENT_CODEX_RELEASES.some(current => current === release)
  return {
    current,
    legacySolLuna: release?.usage === 'solLuna',
    retired: release?.usage === 'retired' || (!current && release?.pickerDescription !== undefined),
  }
}

export const CLAUDE_CURRENT_LINEUP_LABEL = 'Claude 5 family'

export type ClaudeFamily = 'sonnet' | 'opus' | 'haiku' | 'fable'

type ClaudeRelease = {
  wire: ModelConfig
  family: ClaudeFamily
  label: string
  publicLabel?: string
  attributionId?: string
  fastModeLabel?: string
  longContext?: 'optional' | 'default'
  outputTokens?: { default: number; upperLimit: number }
  knowledgeCutoff?: string
  structuredOutputs?: boolean
  autoMode?: boolean
  effort?: 'standard' | 'max' | 'xhigh'
  subscriberMediumEffort?: boolean
  fastMode?: boolean
  cloudThinking?: boolean
  cloudInterleavedThinking?: boolean
  vertexWebSearch?: boolean
  cloudContextManagement?: boolean
  vertexRegionEnv?: string
  leanPrompt?: boolean
  requiredAdaptiveThinking?: boolean
  cachedCompaction?: boolean
  advisor?: boolean
  cloudFallback?: string
  codexTranslation?: 'reject'
  retireFirstPartyTo?: string
  priceAs?: string
}

const frontier = {
  longContext: 'default',
  outputTokens: { default: 64_000, upperLimit: 128_000 },
  structuredOutputs: true,
} as const

const sonnet4 = {
  family: 'sonnet', longContext: 'optional', knowledgeCutoff: 'January 2025',
  cloudThinking: true, cloudInterleavedThinking: true,
  vertexWebSearch: true, cloudContextManagement: true,
  outputTokens: { default: 32_000, upperLimit: 64_000 },
} as const

const opus4 = {
  family: 'opus', knowledgeCutoff: 'January 2025',
  cloudThinking: true, cloudInterleavedThinking: true,
  vertexWebSearch: true, cloudContextManagement: true,
  outputTokens: { default: 32_000, upperLimit: 32_000 },
} as const

const CLAUDE_RELEASES = {
  sonnet55: {
    ...frontier, wire: CLAUDE_SONNET_5_5_CONFIG, family: 'sonnet', label: 'Sonnet 5.5',
    attributionId: CLAUDE_SONNET_5_CONFIG.foundry, knowledgeCutoff: 'June 2026', effort: 'xhigh', autoMode: true,
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_5_SONNET', requiredAdaptiveThinking: true,
  },
  sonnet5: {
    ...frontier, wire: CLAUDE_SONNET_5_CONFIG, family: 'sonnet', label: 'Sonnet 5',
    knowledgeCutoff: 'January 2026', effort: 'standard', autoMode: true, cachedCompaction: true,
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_5_SONNET',
  },
  sonnet46: {
    ...sonnet4, wire: CLAUDE_SONNET_4_6_CONFIG, label: 'Sonnet 4.6',
    knowledgeCutoff: 'August 2025', effort: 'standard', autoMode: true,
    structuredOutputs: true, retireFirstPartyTo: 'sonnet5', advisor: true, cloudFallback: 'sonnet45',
    outputTokens: { default: 32_000, upperLimit: 128_000 },
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_6_SONNET',
  },
  sonnet45: {
    ...sonnet4, wire: CLAUDE_SONNET_4_5_CONFIG, label: 'Sonnet 4.5',
    structuredOutputs: true, cloudFallback: 'sonnet40', vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_5_SONNET',
  },
  sonnet40: {
    ...sonnet4, wire: CLAUDE_SONNET_4_CONFIG, label: 'Sonnet 4',
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_0_SONNET',
  },
  sonnet37: {
    wire: CLAUDE_3_7_SONNET_CONFIG, family: 'sonnet', label: 'Claude 3.7 Sonnet',
    publicLabel: 'Sonnet 3.7', attributionId: 'claude-sonnet-3-7', vertexRegionEnv: 'VERTEX_REGION_CLAUDE_3_7_SONNET',
    outputTokens: { default: 32_000, upperLimit: 64_000 },
  },
  sonnet35: {
    wire: CLAUDE_3_5_V2_SONNET_CONFIG, family: 'sonnet', label: 'Claude 3.5 Sonnet',
    publicLabel: 'Sonnet 3.5', vertexRegionEnv: 'VERTEX_REGION_CLAUDE_3_5_SONNET',
    outputTokens: { default: 8_192, upperLimit: 8_192 },
  },
  opus55: {
    ...frontier, wire: CLAUDE_OPUS_5_5_CONFIG, family: 'opus', label: 'Opus 5.5',
    attributionId: CLAUDE_OPUS_5_CONFIG.foundry, fastModeLabel: 'Opus 5', knowledgeCutoff: 'June 2026', effort: 'xhigh', autoMode: true,
    subscriberMediumEffort: true, fastMode: true, leanPrompt: true,
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_5_OPUS',
    requiredAdaptiveThinking: true, codexTranslation: 'reject',
  },
  opus5: {
    ...frontier, wire: CLAUDE_OPUS_5_CONFIG, family: 'opus', label: 'Opus 5',
    knowledgeCutoff: 'May 2026', effort: 'max', autoMode: true,
    subscriberMediumEffort: true, fastMode: true, leanPrompt: true, cachedCompaction: true,
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_5_OPUS',
  },
  opus46: {
    ...opus4, wire: CLAUDE_OPUS_4_6_CONFIG, label: 'Opus 4.6',
    longContext: 'optional', knowledgeCutoff: 'May 2025', effort: 'max', autoMode: true,
    structuredOutputs: true, subscriberMediumEffort: true, fastMode: true, retireFirstPartyTo: 'opus5', advisor: true, cloudFallback: 'opus41',
    outputTokens: { default: 64_000, upperLimit: 128_000 },
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_0_OPUS',
  },
  opus45: {
    ...opus4, wire: CLAUDE_OPUS_4_5_CONFIG, label: 'Opus 4.5',
    structuredOutputs: true, knowledgeCutoff: 'May 2025',
    outputTokens: { default: 32_000, upperLimit: 64_000 },
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_0_OPUS',
  },
  opus41: {
    ...opus4, wire: CLAUDE_OPUS_4_1_CONFIG, label: 'Opus 4.1',
    structuredOutputs: true, vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_1_OPUS',
  },
  opus40: {
    ...opus4, wire: CLAUDE_OPUS_4_CONFIG, label: 'Opus 4',
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_4_0_OPUS',
  },
  haiku55: {
    wire: CLAUDE_HAIKU_5_5_CONFIG, family: 'haiku', label: 'Haiku 5.5',
    structuredOutputs: true,
  },
  haiku45: {
    wire: CLAUDE_HAIKU_4_5_CONFIG, family: 'haiku', label: 'Haiku 4.5',
    knowledgeCutoff: 'February 2025', structuredOutputs: true,
    vertexWebSearch: true, cloudContextManagement: true,
    outputTokens: { default: 32_000, upperLimit: 64_000 },
    vertexRegionEnv: 'VERTEX_REGION_CLAUDE_HAIKU_4_5',
  },
  haiku35: {
    wire: CLAUDE_3_5_HAIKU_CONFIG, family: 'haiku', label: 'Claude 3.5 Haiku',
    publicLabel: 'Haiku 3.5', attributionId: 'claude-haiku-3-5', vertexRegionEnv: 'VERTEX_REGION_CLAUDE_3_5_HAIKU',
    outputTokens: { default: 8_192, upperLimit: 8_192 },
  },
  fable5: {
    ...frontier, wire: CLAUDE_FABLE_5_CONFIG, family: 'fable', label: 'Fable 5',
    knowledgeCutoff: 'January 2026', effort: 'max', subscriberMediumEffort: true,
    fastMode: true, vertexRegionEnv: 'VERTEX_REGION_CLAUDE_5_FABLE', cachedCompaction: true,
  },
} as const

type ClaudeReleaseKey = keyof typeof CLAUDE_RELEASES
const claudeReleaseRecords: Record<ClaudeReleaseKey, ClaudeRelease & { retireFirstPartyTo?: ClaudeFamily | ClaudeReleaseKey; cloudFallback?: ClaudeReleaseKey }> = CLAUDE_RELEASES

// Cloud resellers can keep a different release while first-party and Codex
// sessions use the current first-party selector.
export const CLAUDE_JOB_RELEASES = {
  ultraPlan: 'opus46',
  remoteScheduled: 'sonnet5',
} as const satisfies Record<string, ClaudeReleaseKey>

const CLAUDE_FAMILIES = {
  sonnet: { current: 'sonnet55', cloud: 'sonnet45' },
  opus: { current: 'opus55', cloud: 'opus46' },
  haiku: { current: 'haiku55', cloud: 'haiku45' },
  fable: { current: 'fable5', cloud: 'fable5' },
} as const satisfies Record<ClaudeFamily, Record<'current' | 'cloud', ClaudeReleaseKey>>

export function getClaudeFamilyKey(family: ClaudeFamily, cloud = false): ClaudeReleaseKey {
  return CLAUDE_FAMILIES[family][cloud ? 'cloud' : 'current']
}

export function currentClaudeRelease<F extends ClaudeFamily>(family: F): (typeof CLAUDE_RELEASES)[(typeof CLAUDE_FAMILIES)[F]['current']] & ClaudeRelease {
  return CLAUDE_RELEASES[CLAUDE_FAMILIES[family].current] as (typeof CLAUDE_RELEASES)[(typeof CLAUDE_FAMILIES)[F]['current']] & ClaudeRelease
}

export function getClaudeRelease(key: ClaudeReleaseKey): ClaudeRelease {
  return claudeReleaseRecords[key]
}

const claudeReleases = Object.values(claudeReleaseRecords)
const claudeById = new Map(claudeReleases.flatMap(release =>
  Object.values(release.wire).map(id => [id, release] as const),
))
const claudePrefixes = [...claudeReleases].sort(
  (a, b) => b.wire.foundry.length - a.wire.foundry.length,
)

export function getCachedCompactionClaudeModels(): string[] {
  return (['fable', 'opus', 'sonnet'] as const).flatMap(family =>
    claudeReleases.filter(release => release.family === family && release.cachedCompaction)
      .map(release => release.wire.firstParty),
  )
}

export function getClaudeCloudFallbackKey(model: string): ClaudeReleaseKey | undefined {
  const candidate = model.toLowerCase().replace(/_/g, '-')
  return claudePrefixes.find(release =>
    candidate.includes(release.wire.foundry.replace(/^claude-/, '')),
  )?.cloudFallback
}

const LEGACY_OPUS_FIRST_PARTY: readonly string[] = [
    CLAUDE_OPUS_4_CONFIG.firstParty, CLAUDE_OPUS_4_1_CONFIG.firstParty,
    'claude-opus-4-0', CLAUDE_OPUS_4_1_CONFIG.foundry,
  ]

export function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRST_PARTY.includes(model)
}

export function getExactClaudeRelease(model: string): ClaudeRelease | undefined {
  return claudeById.get(model)
}

export function matchClaudeRelease(model: string): ClaudeRelease | undefined {
  return getExactClaudeRelease(model) ??
    claudePrefixes.find(release => model.includes(release.wire.foundry))
}

export function getClaudeMarketingName(model: string): string | undefined {
  const normalized = model.toLowerCase()
  const release = matchClaudeRelease(normalized)
  if (!release) return undefined
  return release.longContext && normalized.includes('[1m]')
    ? `${release.label} (with 1M context)`
    : release.label
}

export function remapRetiredClaudeSelection(model: string): string {
  let release = matchClaudeRelease(model.trim().toLowerCase().replace(/\[1m\]$/, ''))
  if (!release?.retireFirstPartyTo) return model
  const visited = new Set<ClaudeRelease>()
  while (release.retireFirstPartyTo) {
    if (visited.has(release)) throw new Error(`Cyclic Claude model retirement for ${model}`)
    visited.add(release)
    const target: string = release.retireFirstPartyTo
    release = target in CLAUDE_FAMILIES
      ? currentClaudeRelease(target as ClaudeFamily)
      : getClaudeRelease(target as ClaudeReleaseKey)
  }
  return release.wire.firstParty + (release.longContext === 'optional' && /\[1m\]$/i.test(model.trim()) ? '[1m]' : '')
}

const claudeModelConfigs = Object.fromEntries(
  Object.entries(CLAUDE_RELEASES).map(([key, release]) => [key, release.wire]),
) as { [K in ClaudeReleaseKey]: (typeof CLAUDE_RELEASES)[K]['wire'] }

export const ALL_MODEL_CONFIGS = {
  ...claudeModelConfigs,
  astra: codexConfig(currentCodexRelease('astra').id),
  sol: codexConfig(currentCodexRelease('sol').id),
  terra: codexConfig(currentCodexRelease('terra').id),
  luna: codexConfig(currentCodexRelease('luna').id),
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
