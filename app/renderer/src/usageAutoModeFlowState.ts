import type { AutoModeUsageOutcome } from '../../shared/usageAutoMode.js'

export type UsageAutoModeFlowEdge = {
  from: string
  to: string
  outcome?: AutoModeUsageOutcome
  count: number
}

export type UsageAutoModeFlowNode = {
  id: string
  label: string
  column: number
  x: number
  y: number
  width: number
  height: number
  incoming: number
  outgoing: number
}

export type UsageAutoModeFlowLink = UsageAutoModeFlowEdge & {
  id: string
  fromNode: UsageAutoModeFlowNode
  toNode: UsageAutoModeFlowNode
  fromY: number
  toY: number
  height: number
  path: string
}

export type UsageAutoModeFlowLayout = {
  width: number
  height: number
  nodeWidth: number
  scale: number
  total: number
  nodes: UsageAutoModeFlowNode[]
  links: UsageAutoModeFlowLink[]
}

const OUTCOME_LABELS: Record<AutoModeUsageOutcome, string> = {
  allowed: 'Allowed',
  policy_blocked: 'Policy-blocked',
  review_required: 'Review required',
  operational_error: 'Operational error',
  cancelled: 'Cancelled',
  unknown_outcome: 'Unknown outcome',
  incomplete: 'Incomplete',
}

const NODE_COLUMNS: Record<string, number> = {
  Attempts: 0,
  'Base checks': 1,
  'Supplied decision': 1,
  'Unknown route': 1,
  'Review/safety guard': 2,
  'Workspace edits': 2,
  'Tool allowlist': 2,
  'Stage 1': 2,
  'Stage 2': 3,
  ...Object.fromEntries(Object.keys(OUTCOME_LABELS).map(outcome => [outcome, 4])),
}

const NODE_ORDER = [
  'Attempts',
  'Base checks',
  'Supplied decision',
  'Unknown route',
  'Review/safety guard',
  'Workspace edits',
  'Tool allowlist',
  'Stage 1',
  'Stage 2',
  'allowed',
  'policy_blocked',
  'review_required',
  'operational_error',
  'cancelled',
  'unknown_outcome',
  'incomplete',
]

const NODE_RANK = new Map(NODE_ORDER.map((node, index) => [node, index]))
const TOP = 34
const BOTTOM = 24
const NODE_GAP = 12
const MAX_FLOW_HEIGHT = 300

function nodeColumn(id: string): number | null {
  return NODE_COLUMNS[id] ?? null
}

function compareNodeIds(left: string, right: string): number {
  return (NODE_RANK.get(left) ?? Number.MAX_SAFE_INTEGER) - (NODE_RANK.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
}

function compareEdges(left: UsageAutoModeFlowEdge, right: UsageAutoModeFlowEdge): number {
  return compareNodeIds(left.from, right.from) || compareNodeIds(left.to, right.to) ||
    (left.outcome ?? '').localeCompare(right.outcome ?? '')
}

export function usageAutoModeFlowNodeLabel(id: string): string {
  return OUTCOME_LABELS[id as AutoModeUsageOutcome] ?? id
}

export function autoModeFlowConserves(edges: readonly UsageAutoModeFlowEdge[]): boolean {
  if (!edges.length || edges.some(edge => !Number.isSafeInteger(edge.count) || edge.count <= 0)) return false
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of edges) {
    const fromColumn = nodeColumn(edge.from)
    const toColumn = nodeColumn(edge.to)
    if (fromColumn === null || toColumn === null || fromColumn >= toColumn) return false
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + edge.count)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + edge.count)
  }
  if ((incoming.get('Attempts') ?? 0) !== 0 || (outgoing.get('Attempts') ?? 0) === 0) return false
  for (const node of new Set([...incoming.keys(), ...outgoing.keys()])) {
    if (node === 'Attempts' || OUTCOME_LABELS[node as AutoModeUsageOutcome]) continue
    if ((incoming.get(node) ?? 0) !== (outgoing.get(node) ?? 0)) return false
  }
  return true
}

export function layoutAutoModeFlow(
  input: readonly UsageAutoModeFlowEdge[],
  width = 960,
): UsageAutoModeFlowLayout | null {
  const edges = [...input].sort(compareEdges)
  if (!autoModeFlowConserves(edges)) return null

  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const edge of edges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + edge.count)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + edge.count)
  }
  const ids = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].sort(compareNodeIds)
  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const column = nodeColumn(id)!
    const items = columns.get(column) ?? []
    items.push(id)
    columns.set(column, items)
  }
  for (const items of columns.values()) items.sort(compareNodeIds)

  const availableHeight = MAX_FLOW_HEIGHT
  const scale = Math.min(...[...columns.values()].map(items => {
    const count = items.reduce((total, id) => total + Math.max(incoming.get(id) ?? 0, outgoing.get(id) ?? 0), 0)
    return availableHeight / (count + Math.max(0, items.length - 1) * NODE_GAP)
  }))
  const nodeWidth = 14
  const height = TOP + availableHeight + BOTTOM
  const left = 148
  const right = 148
  const innerWidth = Math.max(1, width - left - right)
  const nodesById = new Map<string, UsageAutoModeFlowNode>()

  for (const [column, items] of columns) {
    const used = items.reduce((total, id) => total + Math.max(incoming.get(id) ?? 0, outgoing.get(id) ?? 0) * scale, 0) + Math.max(0, items.length - 1) * NODE_GAP
    let y = TOP + (availableHeight - used) / 2
    for (const id of items) {
      const value = Math.max(incoming.get(id) ?? 0, outgoing.get(id) ?? 0)
      nodesById.set(id, {
        id,
        label: usageAutoModeFlowNodeLabel(id),
        column,
        x: left + column / 4 * (innerWidth - nodeWidth),
        y,
        width: nodeWidth,
        height: value * scale,
        incoming: incoming.get(id) ?? 0,
        outgoing: outgoing.get(id) ?? 0,
      })
      y += value * scale + NODE_GAP
    }
  }

  const sourceOffsets = new Map<string, number>()
  const targetOffsets = new Map<string, number>()
  const links = edges.map((edge, index) => {
    const fromNode = nodesById.get(edge.from)!
    const toNode = nodesById.get(edge.to)!
    const height = edge.count * scale
    const fromY = fromNode.y + (sourceOffsets.get(edge.from) ?? 0)
    const toY = toNode.y + (targetOffsets.get(edge.to) ?? 0)
    sourceOffsets.set(edge.from, (sourceOffsets.get(edge.from) ?? 0) + height)
    targetOffsets.set(edge.to, (targetOffsets.get(edge.to) ?? 0) + height)
    const startX = fromNode.x + fromNode.width
    const endX = toNode.x
    const controlX = startX + (endX - startX) / 2
    return {
      ...edge,
      id: `${edge.from}\u0000${edge.to}\u0000${index}`,
      fromNode,
      toNode,
      fromY,
      toY,
      height,
      path: `M${startX},${fromY}C${controlX},${fromY} ${controlX},${toY} ${endX},${toY}L${endX},${toY + height}C${controlX},${toY + height} ${controlX},${fromY + height} ${startX},${fromY + height}Z`,
    }
  })

  return {
    width,
    height,
    nodeWidth,
    scale,
    total: outgoing.get('Attempts') ?? 0,
    nodes: ids.map(id => nodesById.get(id)!),
    links,
  }
}
