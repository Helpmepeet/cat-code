import { useContext, useState } from 'react';
import type { UsageDay, UsageEffortLevel, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { USAGE_EFFORT_LEVELS } from '../../shared/usageDashboard.js';
import { usageBucketLabel } from './usageTrendState.js';
import { useUsageChartWidth, usageCompact, usageNumber } from './usageDashboardState.js';
import './usageWorkPatterns.css';
import { UsageChartHoverContext } from './usageChartHover.js';

const effortLabel: Record<UsageEffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
const parallelLabel = ['1 session', '2 sessions', '3+ sessions'] as const;
const formatHours = (minutes: number) => minutes > 0 && minutes < 6 ? `${Math.round(minutes)}m` : `${(minutes / 60).toFixed(1)}h`;

function StackedBars({ summary, values, classes, selected, onSelect, percent = false }: {
    summary: UsageRangeSummary;
    values: (day: UsageDay) => number[] | null;
    classes: string[];
    selected: string;
    onSelect: (date: string) => void;
    percent?: boolean;
}) {
    const chart = useUsageChartWidth();
    const linkedHover = useContext(UsageChartHoverContext);
    const left = 38, right = chart.width - 8, top = 10, bottom = 156;
    const width = right - left, barSlot = width / Math.max(1, summary.days.length);
    const max = percent ? 1 : Math.max(1, ...summary.days.map(day => (values(day) ?? []).reduce((sum, value) => sum + value, 0)));
    const labels = summary.days.length <= 6 ? summary.days.map((_, index) => index) : [0, 1, 2, 3, 4, 5].map(i => Math.round(i * (summary.days.length - 1) / 5));
    return <svg className="usage-chart usage-pattern-chart" ref={chart.ref} viewBox={`0 0 ${chart.width} 184`} role="group" aria-label={percent ? 'Reasoning effort share by period' : 'Active hours by sessions running'}>
        {[0, .5, 1].map(fraction => <g key={fraction}><line x1={left} x2={right} y1={bottom - fraction * (bottom - top)} y2={bottom - fraction * (bottom - top)} className="usage-grid-line"/><text x={left - 5} y={bottom - fraction * (bottom - top) + 4} textAnchor="end" className="usage-axis">{percent ? `${Math.round(fraction * 100)}%` : formatHours(max * fraction * 60)}</text></g>)}
        {summary.days.map((day, index) => {
            const row = values(day), sum = row?.reduce((n, value) => n + value, 0) ?? 0;
            const x = left + index * barSlot + Math.min(3, barSlot * .1), barWidth = Math.max(1, barSlot - Math.min(6, barSlot * .2));
            let y = bottom;
            const segments = row?.map((value, i) => {
                const height = (percent ? sum ? value / sum : 0 : value / max) * (bottom - top);
                y -= height;
                return height > 0 ? <rect key={i} x={x} y={y} width={barWidth} height={height} className={classes[i]}/> : null;
            });
            const label = usageBucketLabel(summary, day.date);
            return <g key={day.date} role="button" tabIndex={0} aria-pressed={selected === day.date} aria-label={`${label}: ${row ? row.map(usageNumber).join(', ') : 'unavailable'}`} onMouseEnter={() => linkedHover.setDate(day.date)} onMouseLeave={() => linkedHover.setDate('')} onFocus={() => linkedHover.setDate(day.date)} onBlur={() => linkedHover.setDate('')} onClick={() => onSelect(day.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(day.date); } else if (event.key === 'Escape') { event.preventDefault(); onSelect(''); } }}>
                {selected === day.date && <rect x={x} y={top} width={barWidth} height={bottom - top} className="usage-selected"/>}
                {segments}
                <rect x={left + index * barSlot} y={top} width={barSlot} height={bottom - top} fill="transparent"/>
                <title>{label}</title>
            </g>;
        })}
        {linkedHover.date && summary.days.some(day => day.date === linkedHover.date) && <line x1={left + (summary.days.findIndex(day => day.date === linkedHover.date) + .5) * barSlot} x2={left + (summary.days.findIndex(day => day.date === linkedHover.date) + .5) * barSlot} y1={top} y2={bottom} className="usage-linked-crosshair" aria-hidden="true"/>}
        {labels.map(index => <text key={index} x={left + (index + .5) * barSlot} y={179} textAnchor="middle" className="usage-axis">{usageBucketLabel(summary, summary.days[index]!.date)}</text>)}
    </svg>;
}

export function UsageParallelSessions({ summary, selected, onSelect }: { summary: UsageRangeSummary; selected: string; onSelect: (date: string) => void }) {
    const data = summary.parallel, total = data.minutes.reduce((sum, value) => sum + value, 0);
    const peakDay = summary.days.find(day => day.parallel.peak === data.peak && data.peak > 0);
    return <section className="usage-panel usage-pattern-panel"><h2 className="usage-panel-heading">Parallel sessions</h2>
        {data.state === 'unavailable' ? <p className="usage-note">Not recorded in this period.</p> : <>
            <div className="usage-pattern-figures"><div><strong>{formatHours(total)}</strong><span>active</span></div><div><strong>{Math.round((total - data.minutes[0]) / total * 100)}%</strong><span>of active time at 2+ sessions</span></div><div><strong>{usageNumber(data.peak)}</strong><span>peak sessions{peakDay ? `, ${usageBucketLabel(summary, peakDay.date)}` : ''}</span></div></div>
            <div className="usage-pattern-columns"><div><h3>Active hours</h3><StackedBars summary={summary} values={day => day.parallel.state === 'available' ? day.parallel.minutes.map(value => value / 60) : null} classes={['usage-pattern-p1', 'usage-pattern-p2', 'usage-pattern-p3']} selected={selected} onSelect={onSelect}/></div>
                <div><h3>Active time by sessions running</h3><svg className="usage-pattern-share" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">{data.minutes.map((value, index) => <rect key={index} x={data.minutes.slice(0, index).reduce((sum, n) => sum + n, 0) / total * 100} y="0" width={value / total * 100} height="12" className={`usage-pattern-p${index + 1}`}/>)}</svg><ul className="usage-pattern-key">{data.minutes.map((value, index) => <li key={index}><i className={`usage-pattern-p${index + 1}`}/><span>{parallelLabel[index]}</span><b>{formatHours(value)}</b></li>)}</ul></div>
            </div>
        </>}
    </section>;
}

export function UsageReasoningEffort({ summary, selected, onSelect }: { summary: UsageRangeSummary; selected: string; onSelect: (date: string) => void }) {
    const [measure, setMeasure] = useState<'requests' | 'tokens'>('requests');
    const data = summary.effort, counts = data[measure];
    const total = USAGE_EFFORT_LEVELS.reduce((sum, level) => sum + counts[level], 0);
    return <section className="usage-panel usage-pattern-panel"><header className="usage-pattern-header"><h2 className="usage-panel-heading">Reasoning effort</h2><div className="usage-range" role="group" aria-label="Measure effort by"><button type="button" aria-pressed={measure === 'requests'} onClick={() => setMeasure('requests')}>Requests</button><button type="button" aria-pressed={measure === 'tokens'} onClick={() => setMeasure('tokens')}>Tokens</button></div></header>
        {data.state === 'unavailable' ? <p className="usage-note">Not recorded in this period.</p> : <>
            {data.state === 'partial' && <p className="usage-note">Shares include requests with recorded effort only. {usageNumber(data.unattributedRequests)} requests have no recorded effort.</p>}
            <svg className="usage-pattern-share" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">{USAGE_EFFORT_LEVELS.map((level, index) => <rect key={level} x={USAGE_EFFORT_LEVELS.slice(0, index).reduce((sum, key) => sum + counts[key], 0) / Math.max(1, total) * 100} y="0" width={counts[level] / Math.max(1, total) * 100} height="12" className={`usage-pattern-e${index + 1}`}/>)}</svg>
            <ul className="usage-pattern-key usage-pattern-effort-key">{USAGE_EFFORT_LEVELS.map((level, index) => <li key={level}><i className={`usage-pattern-e${index + 1}`}/><span>{effortLabel[level]}</span><b>{measure === 'tokens' ? usageCompact(counts[level]) : usageNumber(counts[level])}</b></li>)}</ul>
            <StackedBars summary={summary} values={day => day.effort.state === 'unavailable' ? null : USAGE_EFFORT_LEVELS.map(level => day.effort[measure][level])} classes={USAGE_EFFORT_LEVELS.map((_, index) => `usage-pattern-e${index + 1}`)} selected={selected} onSelect={onSelect} percent/>
        </>}
    </section>;
}

export function UsageSessionsRunning({ day }: { day: UsageDay }) {
    const peaks = day.parallel.tenMinutePeaks;
    if (!peaks) return <p className="usage-note">Sessions running is unavailable for this period.</p>;
    const maxSlot = Math.max(143, ...peaks.map(([slot]) => slot));
    const width = 360, height = 58, max = Math.max(1, day.parallel.peak);
    const points = Array.from({ length: maxSlot + 1 }, (_, slot) => `${slot / maxSlot * width},${height - (peaks.find(item => item[0] === slot)?.[1] ?? 0) / max * (height - 8)}`).join(' ');
    return <section className="usage-running"><h4>Sessions running</h4><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Maximum ${day.parallel.peak} sessions running in ten-minute intervals`}><polyline points={points}/></svg></section>;
}
