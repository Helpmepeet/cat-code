import type {
    UsageDurationSummary,
    UsageSessionTimeline,
    UsageTimingSummary,
} from '../../shared/usageDashboard.js';
import {
    layoutUsageTimeline,
    usageDuration,
    usageOutcome,
    usageUtcTime,
} from './usageTimingState.js';
import './usageTiming.css';

function DurationMetric({ label, title, value }: {
    label: string;
    title: string;
    value: UsageDurationSummary;
}) {
    const available = value.samples > 0 && value.p50Ms !== null && value.p95Ms !== null;
    return <div className="usage-latency-metric" title={title}>
        <h3>{label}</h3>
        {available ? <dl><div><dt>p50</dt><dd>{usageDuration(value.p50Ms)}</dd></div><div><dt>p95</dt><dd>{usageDuration(value.p95Ms)}</dd></div></dl> : <strong>No data</strong>}
        {available && <p className="usage-latency-samples">{value.samples} {value.samples === 1 ? 'sample' : 'samples'}</p>}
    </div>;
}

export function UsageLatencyPanel({ timing, invalidTimings = 0 }: { timing: UsageTimingSummary; invalidTimings?: number }) {
    return <div className="usage-latency">
        <div className="usage-latency-grid">
            <DurationMetric label="First text" title="Time from dispatch to the first nonempty streamed text." value={timing.models.firstText}/>
            <DurationMetric label="Response duration" title="Successful model attempts only. Transport retries within one attempt are not counted separately." value={timing.models.responseDuration}/>
            <DurationMetric label="Tool duration" title="Successful tool runs only." value={timing.tools.duration}/>
        </div>
        {invalidTimings > 0 && <p className="usage-note">{invalidTimings} invalid timing {invalidTimings === 1 ? 'record was' : 'records were'} excluded.</p>}
    </div>;
}

function eventDetail(item: ReturnType<typeof layoutUsageTimeline>['items'][number]): string {
    const { event, callLabel } = item;
    if (event.kind === 'tool') return `${event.label}, ${usageOutcome(event.outcome)}, ${usageDuration(event.durationMs)}`;
    const firstText = event.firstTextMs === null
        ? event.mode === 'streaming' ? 'first text not recorded' : 'first text not applicable'
        : `first text ${usageDuration(event.firstTextMs)}`;
    return `${event.label}, ${callLabel}, attempt ${event.attempt}, ${usageOutcome(event.outcome)}, ${usageDuration(event.durationMs)}, ${firstText}`;
}

export function UsageSessionTimelineView({ timeline }: { timeline: UsageSessionTimeline }) {
    if (timeline.state === 'unavailable') return <div className="usage-session-timeline"><p className="usage-note">Timeline unavailable for this selected day.</p></div>;
    if (!timeline.items.length) return <div className="usage-session-timeline">{timeline.omitted > 0 ? <><p className="usage-note">No recent execution events are shown for this session on the selected day.</p><p className="usage-note">{timeline.omitted} execution {timeline.omitted === 1 ? 'event is' : 'events are'} not shown.</p></> : <p className="usage-note">No execution intervals were recorded for this session on the selected day.</p>}</div>;
    const layout = layoutUsageTimeline(timeline.items);
    const height = Math.max(90, layout.lanes * 24 + 44);
    return <div className="usage-session-timeline">
        <h3>Recent execution</h3>
        <p className="usage-timeline-scope">Showing {timeline.items.length} recent {timeline.items.length === 1 ? 'event' : 'events'} starting in this selected UTC day for this session. Intervals share one wall-time scale, so overlaps remain visible.</p>
        <div className="usage-timeline-scroll">
            <svg className="usage-timeline-chart" viewBox={`0 0 1000 ${height}`} role="img" aria-label="Recorded model and tool execution timeline">
                <text x="42" y="15" className="usage-timeline-axis">{usageUtcTime(layout.startMs)} UTC</text>
                <text x="958" y="15" textAnchor="end" className="usage-timeline-axis">{usageUtcTime(layout.endMs)} UTC</text>
                <line x1="42" x2="958" y1="24" y2="24" className="usage-timeline-baseline"/>
                {layout.links.map((link, index) => <line key={`link-${index}`} x1={link.fromX} y1={38 + link.fromLane * 24} x2={link.toX} y2={38 + link.toLane * 24} className="usage-timeline-retry-link"/>)}
                {layout.items.map(item => {
                    const y = 32 + item.lane * 24;
                    const className = `usage-timeline-event usage-timeline-${item.event.kind} usage-timeline-${item.event.outcome}`;
                    return item.event.durationMs === null
                        ? <g key={item.event.id}><circle cx={item.x} cy={y + 6} r="5" className={className}><title>{eventDetail(item)}</title></circle></g>
                        : <g key={item.event.id}><rect x={item.x} y={y} width={item.width} height="12" rx="4" className={className}><title>{eventDetail(item)}</title></rect></g>;
                })}
            </svg>
        </div>
        <ol className="usage-timeline-list">{layout.items.map(item => <li key={item.event.id}>
            <span className={`usage-timeline-key usage-timeline-${item.event.kind} usage-timeline-${item.event.outcome}`} aria-hidden="true"/>
            <span><strong>{item.event.label}</strong>{item.event.kind === 'model' && <> · {item.callLabel} · attempt {item.event.attempt}</>}<small>{usageUtcTime(item.event.startedAt)} UTC · {usageOutcome(item.event.outcome)} · {usageDuration(item.event.durationMs)}{item.event.kind === 'model' && <> · {item.event.firstTextMs === null ? (item.event.mode === 'streaming' ? 'First text not recorded' : 'First text not applicable') : `First text ${usageDuration(item.event.firstTextMs)}`}</>}</small></span>
        </li>)}</ol>
        {timeline.state === 'truncated' && <p className="usage-note">{timeline.omitted} more execution {timeline.omitted === 1 ? 'event is' : 'events are'} not shown.</p>}
    </div>;
}
