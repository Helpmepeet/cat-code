import { createHash } from 'node:crypto'
import { getInitialSettings } from '../settings/settings.js'
import qualification from './autoModeReductionQualification.json'

type AutoModeReductionQualification = {
  schema: 1
  model: string
  corpusDigest: string
  policyDigest: string
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

const active = qualification as AutoModeReductionQualification | null

/** CI also checks the whole corpus against the active record. A changed local
 * policy or nondefault transport profile is outside that qualification. */
export function hasQualifiedAutoModeReduction(model: string, policy: string): boolean {
  if (active?.schema !== 1 || active.model !== model || !Array.isArray(active.requests) || !active.requests.length) return false
  const settings = getInitialSettings()
  return settings.autoModeFastMode !== true && (settings.reasoningSummaryDetail ?? 'auto') === 'auto' &&
    autoModePolicyDigest(policy) === active.policyDigest
}
