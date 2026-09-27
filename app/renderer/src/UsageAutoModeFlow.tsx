import { useState } from 'react'
import type { AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { autoModeAttempts, autoModeOverviewEdges, type AutoModeDecisionGroup } from './usageAutoModeState.js'
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js'
import {
  layoutAutoModeFlow,
  usageAutoModeFlowNodeLabel,
  type UsageAutoModeFlowEdge,
  type UsageAutoModeFlowLayout,
  type UsageAutoModeFlowLink,
} from './usageAutoModeFlowState.js'
import './usageAutoModeFlow.css'

const GROUPS = new Set(['allowed', 'blocked'])

function linkOutcome(link: UsageAutoModeFlowLink): AutoModeDecisionGroup | null {
  if (link.outcome) return link.outcome
  return GROUPS.has(link.to) ? link.to as AutoModeDecisionGroup : null
}

function usageAutoModeFlowLinkLabel(edge: UsageAutoModeFlowEdge, total: number): string {
  const percent = total ? usagePercent(edge.count / total * 100) : 'Not applicable'
  return `${usageAutoModeFlowNodeLabel(edge.from)} to ${usageAutoModeFlowNodeLabel(edge.to)}: ${usageNumber(edge.count)} recorded ${edge.count === 1 ? 'decision' : 'decisions'}, ${percent} of ${usageNumber(total)} allowed or blocked decisions`
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

export function UsageAutoModeFlow({ summary }: { summary: AutoModeUsageSummary }) {
  const chart = useUsageChartWidth()
  const attempts = autoModeAttempts(summary)
  const decisions = summary.allTools.outcomes.allowed + summary.allTools.outcomes.policy_blocked
  const overviewEdges = autoModeOverviewEdges(summary)
  const layout = layoutAutoModeFlow(overviewEdges, chart.width)
  const [previewLinkId, setPreviewLinkId] = useState<string | null>(null)
  const [pinnedLinkId, setPinnedLinkId] = useState<string | null>(null)
  const activeLinkId = previewLinkId ?? pinnedLinkId
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
  if (decisions === 0) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">No allowed or blocked decisions</p>
    </section>
  }
  if (!layout) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">Decision flow unavailable</p>
    </section>
  }

  return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
    <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
    <div className="usage-auto-flow-scroll">
      <svg
        ref={chart.ref}
        className="usage-auto-flow-chart"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label={`Decision flow for ${usageNumber(layout.total)} recorded allowed or blocked automatic permission decisions`}
        onMouseLeave={() => setPreviewLinkId(null)}
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
              role="button"
              aria-label={label}
              aria-pressed={pinnedLinkId === link.id}
              onMouseEnter={() => setPreviewLinkId(link.id)}
              onFocus={() => setPreviewLinkId(link.id)}
              onBlur={() => setPreviewLinkId(null)}
              onClick={() => { setPinnedLinkId(current => current === link.id ? null : link.id); setPreviewLinkId(null) }}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPinnedLinkId(current => current === link.id ? null : link.id); setPreviewLinkId(null) }
                else if (event.key === 'Escape') { event.preventDefault(); setPinnedLinkId(null); setPreviewLinkId(null) }
              }}
            ><title>{label}</title></path>
          </g>
        })}
        {layout.nodes.map(node => {
          const label = nodeLabelPosition(node)
          const outcome = GROUPS.has(node.id) ? node.id : ''
          return <g key={node.id}>
            <rect className={`usage-auto-flow-node usage-auto-flow-node-${outcome || node.id.toLowerCase().replaceAll(' ', '-')}`} x={node.x} y={node.y} width={node.width} height={node.height} rx="2">
              <title>{`${node.label}: ${usageNumber(Math.max(node.incoming, node.outgoing))} recorded decisions`}</title>
            </rect>
            <text className="usage-auto-flow-node-label" x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline={label.baseline}>{node.label}</text>
          </g>
        })}
      </svg>
    </div>
    {activeLink && <div className="usage-auto-flow-readout" role="status"><p><strong>{usageAutoModeFlowNodeLabel(activeLink.from)} to {usageAutoModeFlowNodeLabel(activeLink.to)}</strong> · {usageNumber(activeLink.count)} of {usageNumber(layout.total)} allowed or blocked decisions · {usagePercent(activeLink.count / layout.total * 100)}</p>{pinnedLinkId && <button type="button" onClick={() => { setPinnedLinkId(null); setPreviewLinkId(null) }}>Clear selection</button>}</div>}
  </section>
}
