import { useState } from 'react'
import type { AutoModeUsageOutcome, AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { autoModeAttempts, autoModeRouteEdges } from './usageAutoModeState.js'
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js'
import {
  layoutAutoModeFlow,
  usageAutoModeFlowNodeLabel,
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

function usageAutoModeFlowLinkLabel(link: UsageAutoModeFlowLink, total: number): string {
  const percent = total ? usagePercent(link.count / total * 100) : 'Not applicable'
  return `${usageAutoModeFlowNodeLabel(link.from)} to ${usageAutoModeFlowNodeLabel(link.to)}: ${usageNumber(link.count)} recorded ${link.count === 1 ? 'attempt' : 'attempts'}, ${percent} of all ${usageNumber(total)} recorded attempts`
}

function nodeLabelX(node: UsageAutoModeFlowLayout['nodes'][number]): { x: number; anchor: 'start' | 'end' | 'middle' } {
  if (node.column === 4) return { x: node.x - 8, anchor: 'end' }
  if (node.column === 0) return { x: node.x + node.width + 8, anchor: 'start' }
  return { x: node.x + node.width / 2, anchor: 'middle' }
}

export function UsageAutoModeFlow({ summary }: { summary: AutoModeUsageSummary }) {
  const chart = useUsageChartWidth()
  const attempts = autoModeAttempts(summary)
  const routeEdges = autoModeRouteEdges(summary)
  const layout = layoutAutoModeFlow(routeEdges, Math.max(760, chart.width))
  const [activeLinkId, setActiveLinkId] = useState<string | null>(null)
  const activeLink = layout?.links.find(link => link.id === activeLinkId) ?? null

  if (summary.allTools.coverage.state === 'unavailable') {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">Decision routes are unavailable for this period.</p>
    </section>
  }
  if (attempts === 0) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">No recorded automatic permission attempts in this period.</p>
    </section>
  }
  if (!layout) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">Decision routes are unavailable for these recorded attempts.</p>
    </section>
  }

  return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
    <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
    <p className="usage-auto-flow-scope">Initial automatic permission routes for all recorded tool attempts.</p>
    {summary.allTools.coverage.state === 'partial' && <p className="usage-note">Partial retained history. This flow shows recorded routes only.</p>}
    <div className="usage-auto-flow-scroll">
      <svg
        ref={chart.ref}
        className="usage-auto-flow-chart"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={`Decision flow for ${usageNumber(layout.total)} recorded automatic permission attempts`}
        onMouseLeave={() => setActiveLinkId(null)}
      >
        {layout.links.map(link => {
          const outcome = linkOutcome(link)
          const selected = activeLinkId === link.id
          const label = usageAutoModeFlowLinkLabel(link, layout.total)
          return <g key={link.id}>
            <path className={`usage-auto-flow-ribbon${outcome ? ` usage-auto-flow-ribbon-${outcome}` : ''}${selected ? ' usage-auto-flow-ribbon-active' : ''}`} d={link.path} aria-hidden="true" />
            <path
              className="usage-auto-flow-hit"
              d={link.path}
              fill="transparent"
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
          const label = nodeLabelX(node)
          const outcome = OUTCOMES.has(node.id as AutoModeUsageOutcome) ? node.id : ''
          return <g key={node.id}>
            <rect className={`usage-auto-flow-node usage-auto-flow-node-${outcome || node.id.toLowerCase().replaceAll(' ', '-')}`} x={node.x} y={node.y} width={node.width} height={node.height} rx="2">
              <title>{`${node.label}: ${usageNumber(Math.max(node.incoming, node.outgoing))} recorded attempts`}</title>
            </rect>
            <text className="usage-auto-flow-node-label" x={label.x} y={node.y - 7} textAnchor={label.anchor}>{node.label}</text>
          </g>
        })}
      </svg>
    </div>
    <p className="usage-auto-flow-readout" role="status">{activeLink
      ? <><strong>{usageAutoModeFlowNodeLabel(activeLink.from)} to {usageAutoModeFlowNodeLabel(activeLink.to)}</strong> · {usageNumber(activeLink.count)} of {usageNumber(layout.total)} recorded attempts · {usagePercent(activeLink.count / layout.total * 100)} of all recorded attempts</>
      : <>{usageNumber(layout.total)} recorded attempts. Ribbon widths show recorded attempt counts.</>}</p>
    <details className="usage-auto-flow-values">
      <summary>Exact route values</summary>
      <div className="usage-table-scroll"><table>
        <caption>Recorded automatic permission routes</caption>
        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Attempts</th><th scope="col">Share of all attempts</th></tr></thead>
        <tbody>{layout.links.map(link => <tr key={link.id}><th scope="row">{usageAutoModeFlowNodeLabel(link.from)}</th><td>{usageAutoModeFlowNodeLabel(link.to)}</td><td>{usageNumber(link.count)}</td><td>{usagePercent(link.count / layout.total * 100)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </section>
}
