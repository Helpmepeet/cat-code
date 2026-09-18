/**
 * Renderer-safe aggregate contract for prospective auto-mode Usage data.
 * It deliberately contains no writer, tool input, permission rule text, or
 * transcript content.
 */
export type AutoModeUsageDisposition =
  | 'allowed'
  | 'policy_blocked'
  | 'review_required'
  | 'operational_error'
  | 'cancelled'
  | 'unknown_outcome'

export type AutoModeUsageOutcome = AutoModeUsageDisposition | 'incomplete'

export type AutoModeUsageRoute =
  | 'base'
  | 'forced'
  | 'guard'
  | 'accept_edits'
  | 'allowlist'
  | 'stage1'
  | 'stage2'
  | 'unknown'

export type AutoModeUsageOutcomeCounts = Record<AutoModeUsageOutcome, number>

export type AutoModeUsageCoverage = {
  state: 'complete' | 'partial' | 'unavailable'
  invalidRecords: number
  orphanRecords: number
}

export type AutoModeUsagePopulation = {
  outcomes: AutoModeUsageOutcomeCounts
  coverage: AutoModeUsageCoverage
}

export type AutoModeUsageBucket = {
  date: string
  allTools: AutoModeUsagePopulation
  commands: AutoModeUsagePopulation
}

export type AutoModeUsageSummary = {
  allTools: AutoModeUsagePopulation
  commands: AutoModeUsagePopulation
  buckets: AutoModeUsageBucket[]
  routes: Array<{
    route: AutoModeUsageRoute
    outcome: AutoModeUsageOutcome
    count: number
  }>
  categories: Array<{
    key: string
    kind: 'named' | 'other' | 'uncategorized'
    label: string
    count: number
  }>
}
