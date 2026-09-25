import { useState } from 'react'
import type { AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { AUTO_MODE_DISPLAY_GROUPS, autoModeAttempts, autoModeOverviewEdges, type AutoModeDisplayGroup } from './usageAutoModeState.js'
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js'
import {
  layoutAutoModeFlow,
  usageAutoModeFlowNodeLabel,
  type UsageAutoModeFlowEdge,
  type UsageAutoModeFlowLayout,
  type UsageAutoModeFlowLink,
} from './usageAutoModeFlowState.js'
import './usageAutoModeFlow.css'

const GROUPS = new Set(['allowed', 'blocked', 'error', 'cancelled'])

function linkOutcome(link: UsageAutoModeFlowLink): AutoModeDisplayGroup | null {
  if (link.outcome) return link.outcome
  return GROUPS.has(link.to) ? link.to as AutoModeDisplayGroup : null
}

function usageAutoModeFlowLinkLabel(edge: UsageAutoModeFlowEdge, total: number): string {
  const percent = total ? usagePercent(edge.count / total * 100) : 'Not applicable'
  return `${usageAutoModeFlowNodeLabel(edge.from)} to ${usageAutoModeFlowNodeLabel(edge.to)}: ${usageNumber(edge.count)} recorded ${edge.count === 1 ? 'attempt' : 'attempts'}, ${percent} of ${usageNumber(total)} attempts`
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
  if (!layout) {
    return <section className="usage-auto-flow" aria-labelledby="usage-auto-flow-title">
      <h3 id="usage-auto-flow-title" className="usage-auto-flow-heading">Decision flow</h3>
      <p className="usage-note">No decisions</p>
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
        aria-label={`Decision flow for ${usageNumber(layout.total)} recorded automatic permission attempts`}
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
              <title>{`${node.label}: ${usageNumber(Math.max(node.incoming, node.outgoing))} recorded attempts`}</title>
            </rect>
            <text className="usage-auto-flow-node-label" x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline={label.baseline}>{node.label}</text>
          </g>
        })}
      </svg>
    </div>
    {activeLink && <div className="usage-auto-flow-readout" role="status"><p><strong>{usageAutoModeFlowNodeLabel(activeLink.from)} to {usageAutoModeFlowNodeLabel(activeLink.to)}</strong> · {usageNumber(activeLink.count)} of {usageNumber(layout.total)} · {usagePercent(activeLink.count / layout.total * 100)}</p>{pinnedLinkId && <button type="button" onClick={() => { setPinnedLinkId(null); setPreviewLinkId(null) }}>Clear selection</button>}</div>}
    <ul className="usage-auto-flow-legend" aria-label="Decision outcomes">
      {AUTO_MODE_DISPLAY_GROUPS.map(({ group, label }) => <li key={group} aria-label={group === 'error' ? 'Error. Includes review required, operational error, unknown outcome, and incomplete' : label} title={group === 'error' ? 'Includes review required, operational error, unknown outcome, and incomplete' : undefined}><i className={`usage-auto-flow-legend-${group}`} aria-hidden="true"/><span>{label}</span></li>)}
    </ul>
  </section>
}
