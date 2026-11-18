import { createHash } from 'node:crypto'
import { translateToCodexBody } from '../../services/api/codex-fetch-adapter.js'
import { getInitialSettings } from '../settings/settings.js'
import { buildSideQueryRequest, type SideQueryOptions } from '../sideQuery.js'
import qualification from './autoModeReductionQualification.json'

export type AutoModeReviewStage = 'fast' | 'thinking'

type AutoModeReductionQualification = {
  schema: 2
  model: string
  corpusDigest: string
  policyDigest: string
  stageProfiles: Record<AutoModeReviewStage, string>
  repeats: number
  requests: {
    id: string
    variant: 'full' | 'reduced'
    repeat: number
    shouldBlock: boolean
    digests: string[]
  }[]
}

export function autoModePolicyDigest(policy: string): string {
  return createHash('sha256').update(policy).digest('hex')
}

export function fingerprintAutoModeReviewRequest(options: SideQueryOptions): string {
  const request = buildSideQueryRequest(options, 'openai')
  const { codexBody } = translateToCodexBody(request)
  // Use native instructions and inputs so Anthropic cache hints cannot change
  // the qualification of an otherwise identical Codex request. Include SDK
  // options such as max_tokens, which inform local context admission.
  const { system: _system, messages: _messages, _openaiInstructionAssembly: _assembly, ...configuration } = request
  return createHash('sha256').update(JSON.stringify({ configuration, codexBody })).digest('hex')
}

/** Flat request settings can be compared without processing conversation inputs. */
export function autoModeReviewStageProfile(options: SideQueryOptions): string {
  return fingerprintAutoModeReviewRequest({ ...options, messages: [] })
}

const active = qualification as AutoModeReductionQualification | null
const digestPattern = /^[a-f0-9]{64}$/

/** CI also checks the whole corpus against the active record. A changed local
 * policy or nondefault transport profile is outside that qualification. */
export function hasQualifiedAutoModeReduction(model: string, policy: string): boolean {
  if (active?.schema !== 2 || active.model !== model || !Array.isArray(active.requests) || !active.requests.length ||
      !digestPattern.test(active.stageProfiles?.fast ?? '') || !digestPattern.test(active.stageProfiles?.thinking ?? '')) return false
  const settings = getInitialSettings()
  return settings.autoModeFastMode !== true && (settings.reasoningSummaryDetail ?? 'auto') === 'auto' &&
    autoModePolicyDigest(policy) === active.policyDigest
}

export function matchesQualifiedAutoModeStage(stage: AutoModeReviewStage, options: SideQueryOptions): boolean {
  const profile = active?.stageProfiles?.[stage]
  return typeof profile === 'string' && profile === autoModeReviewStageProfile(options)
}
