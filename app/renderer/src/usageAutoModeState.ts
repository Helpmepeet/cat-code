import type {
  AutoModeUsageOutcome,
  AutoModeUsageSummary,
} from '../../shared/usageAutoMode.js'

export const AUTO_MODE_OUTCOMES: readonly AutoModeUsageOutcome[] = [
  'allowed',
  'policy_blocked',
  'review_required',
  'operational_error',
  'cancelled',
  'unknown_outcome',
  'incomplete',
]

export function autoModeAttempts(summary: AutoModeUsageSummary): number {
  return AUTO_MODE_OUTCOMES.reduce(
    (total, outcome) => total + summary.allTools.outcomes[outcome],
    0,
  )
}

export type AutoModeRatePoint = {
  date: string
  numerator: number
  denominator: number
  rate: number | null
  state: 'confirmed' | 'provisional' | 'unavailable'
}

function rateFor(population: AutoModeUsageSummary['commands']): Omit<AutoModeRatePoint, 'date'> {
  const numerator = population.outcomes.policy_blocked
  const denominator = AUTO_MODE_OUTCOMES.reduce(
    (total, outcome) => total + population.outcomes[outcome],
    0,
  )
  if (population.coverage.state !== 'complete' || denominator === 0) {
    return { numerator, denominator, rate: null, state: 'unavailable' }
  }
  const unresolved = population.outcomes.incomplete + population.outcomes.unknown_outcome
  return { numerator, denominator, rate: numerator / denominator, state: unresolved ? 'provisional' : 'confirmed' }
}

export function autoModeCommandRatePoints(summary: AutoModeUsageSummary): AutoModeRatePoint[] {
  return [...summary.buckets]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(bucket => ({ date: bucket.date, ...rateFor(bucket.commands) }))
}

export function autoModeCommandRateHeadline(summary: AutoModeUsageSummary): Omit<AutoModeRatePoint, 'date'> {
  return rateFor(summary.commands)
}

export function confirmedRateSegments(
  points: readonly AutoModeRatePoint[],
  bucketDays = 1,
): AutoModeRatePoint[][] {
  const segments: AutoModeRatePoint[][] = []
  let current: AutoModeRatePoint[] = []
  for (const point of points) {
    const previous = current.at(-1)
    const contiguous = previous === undefined ||
      Date.parse(`${point.date}T00:00:00.000Z`) -
        Date.parse(`${previous.date}T00:00:00.000Z`) === bucketDays * 86400000
    if (point.state !== 'confirmed' || point.rate === null || !contiguous) {
      if (current.length) segments.push(current)
      current = []
      if (point.state === 'confirmed' && point.rate !== null) current.push(point)
      continue
    }
    current.push(point)
  }
  if (current.length) segments.push(current)
  return segments
}

export function autoModeOutcomeSeries(summary: AutoModeUsageSummary) {
  return AUTO_MODE_OUTCOMES.map(outcome => ({
    outcome,
    points: [...summary.buckets]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map(bucket => ({ date: bucket.date, count: bucket.allTools.outcomes[outcome] })),
  }))
}

export function sortedAutoModeCategories(summary: AutoModeUsageSummary) {
  return [...summary.categories].sort((left, right) =>
    right.count - left.count || left.key.localeCompare(right.key),
  )
}

export const AUTO_MODE_ROUTE_EDGES: Record<AutoModeUsageSummary['routes'][number]['route'], readonly string[]> = {
  base: ['Attempts', 'Base checks'],
  forced: ['Attempts', 'Supplied decision'],
  guard: ['Attempts', 'Base checks', 'Review/safety guard'],
  accept_edits: ['Attempts', 'Base checks', 'Workspace edits'],
  allowlist: ['Attempts', 'Base checks', 'Allowlist'],
  stage1: ['Attempts', 'Base checks', 'Stage 1'],
  stage2: ['Attempts', 'Base checks', 'Stage 1', 'Stage 2'],
  unknown: ['Attempts', 'Unknown route'],
}

export function autoModeRouteEdges(summary: AutoModeUsageSummary) {
  const edges = new Map<string, { from: string; to: string; outcome?: AutoModeUsageSummary['routes'][number]['outcome']; count: number }>()
  for (const route of summary.routes) {
    const path = AUTO_MODE_ROUTE_EDGES[route.route]
    const links = [...path.slice(1).map((to, index) => ({ from: path[index]!, to })), {
      from: path.at(-1)!,
      to: route.outcome,
    }]
    for (const [index, link] of links.entries()) {
      const sink = index === links.length - 1
      const key = JSON.stringify([link.from, link.to])
      const edge = edges.get(key)
      if (edge) edge.count += route.count
      else edges.set(key, { ...link, ...(sink ? { outcome: route.outcome } : {}), count: route.count })
    }
  }
  return [...edges.values()].sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || (left.outcome ?? '').localeCompare(right.outcome ?? ''),
  )
}
