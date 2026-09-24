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

export const AUTO_MODE_DISPLAY_GROUPS = [
  { group: 'allowed', label: 'Allowed', outcomes: ['allowed'] },
  { group: 'blocked', label: 'Blocked', outcomes: ['policy_blocked'] },
  { group: 'error', label: 'Error', outcomes: ['operational_error', 'review_required', 'unknown_outcome', 'incomplete'] },
  { group: 'cancelled', label: 'Cancelled', outcomes: ['cancelled'] },
] as const satisfies readonly { group: string; label: string; outcomes: readonly AutoModeUsageOutcome[] }[]

export type AutoModeDisplayGroup = typeof AUTO_MODE_DISPLAY_GROUPS[number]['group']

export function autoModeDisplayGroup(outcome: AutoModeUsageOutcome): AutoModeDisplayGroup {
  return AUTO_MODE_DISPLAY_GROUPS.find(group => (group.outcomes as readonly string[]).includes(outcome))!.group
}

export function autoModeDisplayCounts(summary: AutoModeUsageSummary) {
  return AUTO_MODE_DISPLAY_GROUPS.map(({ group, label, outcomes }) => ({
    group,
    label,
    count: outcomes.reduce((total, outcome) => total + summary.allTools.outcomes[outcome], 0),
  }))
}

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

export function autoModeDisplaySeries(summary: AutoModeUsageSummary) {
  const buckets = [...summary.buckets].sort((left, right) => left.date.localeCompare(right.date))
  return AUTO_MODE_DISPLAY_GROUPS.map(({ group, label, outcomes }) => ({
    group,
    label,
    points: buckets.map(bucket => ({
      date: bucket.date,
      count: outcomes.reduce((total, outcome) => total + bucket.allTools.outcomes[outcome], 0),
    })),
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
  stage1: ['Attempts', 'Base checks', 'Safety check'],
  stage2: ['Attempts', 'Base checks', 'Safety check', 'Context review'],
  unknown: ['Attempts', 'Unknown route'],
}

export function autoModeOverviewEdges(summary: AutoModeUsageSummary) {
  const edges = new Map<string, { from: string; to: string; outcome?: AutoModeDisplayGroup; count: number }>()
  const add = (from: string, to: string, count: number, outcome?: AutoModeDisplayGroup) => {
    const key = JSON.stringify([from, to])
    const edge = edges.get(key)
    if (edge) edge.count += count
    else edges.set(key, { from, to, ...(outcome ? { outcome } : {}), count })
  }

  for (const route of summary.routes) {
    const routeNode = `Route: ${route.route}`
    const group = autoModeDisplayGroup(route.outcome)
    add('Attempts', routeNode, route.count)
    add(routeNode, group, route.count, group)
  }
  return [...edges.values()].sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || (left.outcome ?? '').localeCompare(right.outcome ?? ''),
  )
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
