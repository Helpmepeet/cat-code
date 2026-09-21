import {
  sankey,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyLink,
  type SankeyNode,
} from 'd3-sankey'
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
  'Safety check': 1,
  'Context review': 2,
  Approved: 3,
  Blocked: 3,
}

const NODE_ORDER = [
  'Attempts',
  'Safety check',
  'Context review',
  'Approved',
  'Blocked',
]

const NODE_RANK = new Map(NODE_ORDER.map((node, index) => [node, index]))
const TERMINAL_NODES = new Set(['Approved', 'Blocked'])
const TOP = 34
const BOTTOM = 24
const NODE_GAP = 20
const MAX_FLOW_HEIGHT = 320
const NODE_WIDTH = 14
const LEFT = 148
const RIGHT = 148

type AutoModeSankeyNode = {
  id: string
  label: string
  column: number
  incoming: number
  outgoing: number
}

type AutoModeSankeyLink = UsageAutoModeFlowEdge & {
  id: string
}

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
  if (id === 'other') return 'Other'
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
    if (node === 'Attempts' || TERMINAL_NODES.has(node)) continue
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
  const height = TOP + MAX_FLOW_HEIGHT + BOTTOM
  const graphInput: SankeyGraph<AutoModeSankeyNode, AutoModeSankeyLink> = {
    nodes: ids.map(id => ({
      id,
      label: usageAutoModeFlowNodeLabel(id),
      column: nodeColumn(id)!,
      incoming: incoming.get(id) ?? 0,
      outgoing: outgoing.get(id) ?? 0,
    })),
    links: edges.map((edge, index) => ({
      ...edge,
      id: `${edge.from}\u0000${edge.to}\u0000${index}`,
      source: edge.from,
      target: edge.to,
      value: edge.count,
    })),
  }
  const generator = sankey<AutoModeSankeyNode, AutoModeSankeyLink>()
    .nodeId(node => node.id)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(NODE_GAP)
    .extent([[LEFT, TOP], [width - RIGHT, TOP + MAX_FLOW_HEIGHT]])
    .iterations(32)
  const graph = generator(graphInput)

  const innerWidth = Math.max(1, width - LEFT - RIGHT)
  const maxColumn = Math.max(...graph.nodes.map(node => node.column))
  for (const node of graph.nodes) {
    node.x0 = LEFT + node.column / maxColumn * (innerWidth - NODE_WIDTH)
    node.x1 = node.x0 + NODE_WIDTH
  }
  generator.update(graph)

  const nodes = graph.nodes.map(node => ({
    id: node.id,
    label: node.label,
    column: node.column,
    x: node.x0!,
    y: node.y0!,
    width: node.x1! - node.x0!,
    height: node.y1! - node.y0!,
    incoming: node.incoming,
    outgoing: node.outgoing,
  }))
  const nodesById = new Map(nodes.map(node => [node.id, node]))
  const linkPath = sankeyLinkHorizontal<AutoModeSankeyNode, AutoModeSankeyLink>()
  const links = graph.links.map(link => {
    const source = link.source as SankeyNode<AutoModeSankeyNode, AutoModeSankeyLink>
    const target = link.target as SankeyNode<AutoModeSankeyNode, AutoModeSankeyLink>
    const height = link.width!
    return {
      from: link.from,
      to: link.to,
      ...(link.outcome ? { outcome: link.outcome } : {}),
      count: link.count,
      id: link.id,
      fromNode: nodesById.get(source.id)!,
      toNode: nodesById.get(target.id)!,
      fromY: link.y0! - height / 2,
      toY: link.y1! - height / 2,
      height,
      path: linkPath(link as SankeyLink<AutoModeSankeyNode, AutoModeSankeyLink>) ?? '',
    }
  })
  const scale = links[0]!.height / links[0]!.count

  return {
    width,
    height,
    nodeWidth: NODE_WIDTH,
    scale,
    total: outgoing.get('Attempts') ?? 0,
    nodes,
    links,
  }
}
