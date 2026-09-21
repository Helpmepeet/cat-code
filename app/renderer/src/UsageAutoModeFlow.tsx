import { useState } from 'react'
import type { AutoModeUsageOutcome, AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { autoModeAttempts, autoModeOverviewEdges, autoModeOverviewExcludedAttempts, autoModeRouteEdges } from './usageAutoModeState.js'
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js'
import {
  layoutAutoModeFlow,
  usageAutoModeFlowNodeLabel,
  type UsageAutoModeFlowEdge,
  type UsageAutoModeFlowLayout,
  type UsageAutoModeFlowLink,
} from './usageAutoModeFlowState.js'
import './usageAutoModeFlow.css'

const OUTCOMES = new Set<AutoModeUsageOutcome>([
  'allowed',
  'policy_blocked',
  'review_required',
  'operational_error',
  'cancelled',
  'unknown_outcome',
  'incomplete',
])

function linkOutcome(link: UsageAutoModeFlowLink): AutoModeUsageOutcome | null {
  if (link.outcome) return link.outcome
  return OUTCOMES.has(link.to as AutoModeUsageOutcome) ? link.to as AutoModeUsageOutcome : null
}

function usageAutoModeFlowLinkLabel(edge: UsageAutoModeFlowEdge, total: number): string {
  const percent = total ? usagePercent(edge.count / total * 100) : 'Not applicable'
  return `${usageAutoModeFlowNodeLabel(edge.from)} to ${usageAutoModeFlowNodeLabel(edge.to)}: ${usageNumber(edge.count)} recorded ${edge.count === 1 ? 'attempt' : 'attempts'}, ${percent} of ${usageNumber(total)} normal completed decisions`
}

function nodeLabelPosition(node: UsageAutoModeFlowLayout['nodes'][number]): {
  x: number
  y: number
  anchor: 'start' | 'end' | 'middle'
  baseline: 'auto' | 'middle'
} {
  if (node.outgoing === 0) {
    return {
      x: node.x + node.width + 8,
      y: node.y + node.height / 2,
      anchor: 'start',
      baseline: 'middle',
    }
  }
  if (node.column === 0) {
    return {
      x: node.x - 8,
      y: node.y + node.height / 2,
      anchor: 'end',
      baseline: 'middle',
    }
  }
  return {
    x: node.x + node.width / 2,
    y: node.y - 8,
    anchor: 'middle',
    baseline: 'auto',
  }
}

function ExactRouteValues({ edges, total }: { edges: UsageAutoModeFlowEdge[]; total: number }) {
  return <details className="usage-auto-flow-values">
    <summary>Exact route values</summary>
    <div className="usage-table-scroll"><table>
      <caption>Recorded automatic permission routes</caption>
      <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Attempts</th><th scope="col">Share of all attempts</th></tr></thead>
      <tbody>{edges.map(edge => <tr key={`${edge.from}\u0000${edge.to}`}><th scope="row">{usageAutoModeFlowNodeLabel(edge.from)}</th><td>{usageAutoModeFlowNodeLabel(edge.to)}</td><td>{usageNumber(edge.count)}</td><td>{usagePercent(edge.count / total * 100)}</td></tr>)}</tbody>
    </table></div>
  </details>
}

export function UsageAutoModeFlow({ summary }: { summary: AutoModeUsageSummary }) {
  const chart = useUsageChartWidth()
  const attempts = autoModeAttempts(summary)
  const routeEdges = autoModeRouteEdges(summary)
  const overviewEdges = autoModeOverviewEdges(summary)
  const excludedAttempts = autoModeOverviewExcludedAttempts(summary)
  const layout = layoutAutoModeFlow(overviewEdges, Math.max(760, chart.width))
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null)
  const activeLink = layout?.links.find(link => link.id === activeLinkId) ?? null

  if (summary.allTools.coverage.state === 'unavailable') {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">Decision flow unavailable</p>
    </section>
  }
  if (attempts === 0) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">No decisions</p>
    </section>
  }
  if (!layout) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      {summary.allTools.coverage.state === 'partial' && <p className="usage-note">Partial history</p>}
      <p className="usage-note">No normal completed decisions</p>
      <ExactRouteValues edges={routeEdges} total={attempts}/>
    </section>
  }

  return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
    <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
    {summary.allTools.coverage.state === 'partial' && <p className="usage-note">Partial history</p>}
    {excludedAttempts > 0 && <p className="usage-auto-flow-scope">Normal completed path · {usageNumber(excludedAttempts)} exceptional {excludedAttempts === 1 ? 'record' : 'records'} listed below</p>}
    <div className="usage-auto-flow-scroll">
      <svg
        ref={chart.ref}
        className="usage-auto-flow-chart"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={`Normal decision flow for ${usageNumber(layout.total)} recorded automatic permission attempts`}
        onMouseLeave={() => setActiveLinkId(null)}
      >
        {layout.links.map(link => {
          const outcome = linkOutcome(link)
          const selected = activeLinkId === link.id
          const label = usageAutoModeFlowLinkLabel(link, layout.total)
          return <g key={link.id}>
            <path className={`usage-auto-flow-ribbon${outcome ? ` usage-auto-flow-ribbon-${outcome}` : ''}${link.height < 2 ? ' usage-auto-flow-ribbon-thin' : ''}${selected ? ' usage-auto-flow-ribbon-active' : ''}`} d={link.path} strokeWidth={link.height} aria-hidden="true" />
            <path
              className="usage-auto-flow-hit"
              d={link.path}
              fill="transparent"
              strokeWidth={Math.max(12, link.height)}
              pointerEvents="all"
              tabIndex={0}
              role="img"
              aria-label={label}
              onMouseEnter={() => setActiveLinkId(link.id)}
              onFocus={() => setActiveLinkId(link.id)}
              onBlur={() => setActiveLinkId(null)}
            ><title>{label}</title></path>
          </g>
        })}
        {layout.nodes.map(node => {
          const label = nodeLabelPosition(node)
          const outcome = OUTCOMES.has(node.id as AutoModeUsageOutcome) ? node.id : ''
          return <g key={node.id}>
            <rect className={`usage-auto-flow-node usage-auto-flow-node-${outcome || node.id.toLowerCase().replaceAll(' ', '-')}`} x={node.x} y={node.y} width={node.width} height={node.height} rx="2">
              <title>{`${node.label}: ${usageNumber(Math.max(node.incoming, node.outgoing))} recorded attempts`}</title>
            </rect>
            <text className="usage-auto-flow-node-label" x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline={label.baseline}>{node.label}</text>
          </g>
        })}
      </svg>
    </div>
    {activeLink && <p className="usage-auto-flow-readout" role="status"><strong>{usageAutoModeFlowNodeLabel(activeLink.from)} to {usageAutoModeFlowNodeLabel(activeLink.to)}</strong> · {usageNumber(activeLink.count)} of {usageNumber(layout.total)} · {usagePercent(activeLink.count / layout.total * 100)}</p>}
    <ExactRouteValues edges={routeEdges} total={attempts}/>
  </section>
}
