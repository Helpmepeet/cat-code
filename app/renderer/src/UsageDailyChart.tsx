import { useId, useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageCompact, usageNumber, usagePercent, usageTotal, usageShare, useUsageChartWidth } from './usageDashboardState.js';
import { usageAxisCeiling, usageChartDate } from './usageGraphState.js';
import { usageBucketDays, usageBucketLabel } from './usageTrendState.js';
import { usageStackedAreaGeometry } from './usageStackedAreaState.js';
import { usageAnalyticsFamily, usageAnalyticsFamilyColor, usageCacheCoverageLabel, usageCalendarAverage, usageDailyCalendar, usageDailyDelta, usageDailyMetrics, usageModelRequestCount, usageDailySeries, usageDailyTotal, usageRangeOutcomes, usageToolRate, type UsageDailyMetric, type UsageTokenGrouping } from './usageDailyChartState.js';

export function UsageDailyChart({ summary, metric, grouping, hidden, modelFamily, selected, partial = false, onMetricChange, onGroupingChange, onHiddenChange, onModelFamilyChange, onSelect }: {
    summary: UsageRangeSummary; metric: UsageDailyMetric; grouping: UsageTokenGrouping; hidden: readonly string[]; modelFamily: readonly string[]; selected: string; partial?: boolean;
    onMetricChange: (metric: UsageDailyMetric) => void; onGroupingChange: (grouping: UsageTokenGrouping) => void;
    onHiddenChange: (hidden: string[]) => void; onModelFamilyChange: (families: string[]) => void; onSelect: (date: string) => void;
}) {
    const [hover, setHover] = useState('');
    const chart = useUsageChartWidth();
    const clip = `daily-${useId().replaceAll(':', '')}`;
    const allSeries = usageDailySeries(summary, metric, grouping);
    const series = allSeries.filter(item => !hidden.includes(item.id) && !(metric === 'tokens' && grouping === 'family' && modelFamily.length && !modelFamily.includes(item.id)));
    const format = (value: number | null) => value === null ? '–' : metric === 'errorRate' ? usagePercent(value) : usageCompact(value);
    const values = summary.days.map(day => series.map(item => item.value(day)));
    const totals = values.map(row => row.reduce<number>((sum, value) => sum + (value ?? 0), 0));
    const peak = Math.max(1, ...totals), step = usageAxisCeiling(peak / 4), max = Math.ceil(peak / step) * step;
    const left = 44, right = chart.width - 12, top = 24, bottom = 272, width = right - left;
    const calendar = usageDailyCalendar(summary);
    const slotStart = (index: number) => left + calendar.slots[index]!.start * width;
    const slotWidth = (index: number) => (calendar.slots[index]!.end - calendar.slots[index]!.start) * width;
    const x = (index: number) => left + calendar.slots[index]!.center * width;
    const y = (value: number) => bottom - value / max * (bottom - top);
    const geometries = calendar.groups.map(group => {
        const samples = group.map(index => ({ x: x(index), values: values[index]!.map(value => value ?? 0) }));
        const first = group[0]!, last = group.at(-1)!;
        samples.unshift({ x: slotStart(first), values: samples[0]!.values });
        samples.push({ x: slotStart(last) + slotWidth(last), values: samples.at(-1)!.values });
        return usageStackedAreaGeometry(samples, max, top, bottom);
    });
    const lines = metric === 'sessions' || metric === 'errorRate';
    const bars = metric === 'toolErrors' || metric === 'auto';
    const average = metric === 'errorRate' ? usageDailyTotal(summary, metric) : usageCalendarAverage(summary, totals);
    const peakIndex = totals.indexOf(Math.max(...totals));
    const hovered = summary.days.findIndex(day => day.date === hover);
    const title = usageDailyMetrics.find(item => item.id === metric)!.title;
    const delta = usageDailyDelta(summary, metric, partial);
    const seriesShare = (id: string) => {
        const item = allSeries.find(item => item.id === id);
        const total = summary.days.reduce((sum, day) => sum + (item?.value(day) ?? 0), 0);
        return usagePercent(total / Math.max(1, usageTotal(summary.tokens)) * 100);
    };
    const toggleSeries = (id: string) => {
        if (metric === 'tokens' && grouping === 'family') {
            const visible = allSeries.filter(item => !hidden.includes(item.id) && (!modelFamily.length || modelFamily.includes(item.id))).map(item => item.id);
            const next = visible.includes(id) ? visible.filter(item => item !== id) : [...visible, id];
            onHiddenChange([]);
            onModelFamilyChange(next.length === allSeries.length ? [] : next.length ? next : ['none']);
        } else onHiddenChange(hidden.includes(id) ? hidden.filter(item => item !== id) : [...hidden, id]);
    };
    return <section className="usage-panel usage-daily-explorer" aria-label="Daily activity chart">
        <div className="usage-daily-head"><div><div className="usage-eyebrow">{title}</div><div className="usage-hero-number">{format(usageDailyTotal(summary, metric))}</div><div className="usage-note">{usageBucketDays(summary) > 1 ? `Per ${usageBucketDays(summary)} days` : 'Per day'}{(hidden.length > 0 || metric === 'tokens' && grouping === 'family' && modelFamily.length > 0) && ' · total includes hidden series'}</div>{delta && <div className="usage-daily-delta"><b>{delta.text}</b> vs prior {summary.range === '7d' ? 7 : 30} days</div>}</div>
            <div className="usage-daily-metrics" role="tablist" aria-label="Metric">{usageDailyMetrics.map(item => <button key={item.id} role="tab" aria-selected={metric === item.id} onClick={() => onMetricChange(item.id)}>{item.label}</button>)}</div></div>
        <div className="usage-daily-tools">{metric === 'tokens' && <div className="usage-daily-group" role="tablist" aria-label="Break down by">{(['family', 'source', 'type'] as const).map(value => <button key={value} role="tab" aria-selected={grouping === value} disabled={value === 'source' && !usageDailySeries(summary, metric, 'source').length} onClick={() => onGroupingChange(value)}>By {value === 'family' ? 'model family' : value}</button>)}</div>}
            <div className="usage-daily-chips" aria-label="Daily series">{allSeries.map(item => <button key={item.id} className="usage-daily-chip" aria-pressed={!hidden.includes(item.id) && !(metric === 'tokens' && grouping === 'family' && modelFamily.length > 0 && !modelFamily.includes(item.id))} onClick={() => toggleSeries(item.id)} onDoubleClick={() => { onHiddenChange(metric === 'tokens' && grouping === 'family' ? [] : allSeries.filter(other => other.id !== item.id).map(other => other.id)); if (metric === 'tokens' && grouping === 'family') onModelFamilyChange([item.id]); }}><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={item.color}/></svg>{item.label}{metric === 'tokens' && grouping === 'source' && <b>{seriesShare(item.id)}</b>}</button>)}{(hidden.length > 0 || modelFamily.length > 0 && metric === 'tokens' && grouping === 'family') && <button className="usage-daily-chip" onClick={() => { onHiddenChange([]); onModelFamilyChange([]); }}>Show all</button>}</div></div>
        <svg ref={chart.ref} className="usage-chart usage-daily-svg" viewBox={`0 0 ${chart.width} 304`} aria-label={`${title} per day`} onMouseLeave={() => setHover('')}>
            <defs><clipPath id={clip}><rect x={left} y={top} width={width} height={bottom - top}/></clipPath><linearGradient id={`${clip}-wash`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={series[0]?.color ?? 'var(--accent)'} stopOpacity=".26"/><stop offset="1" stopColor={series[0]?.color ?? 'var(--accent)'} stopOpacity="0"/></linearGradient></defs>
            {usageBucketDays(summary) === 1 && summary.days.map((day, index) => [0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay()) ? <rect key={day.date} x={slotStart(index)} y={top} width={slotWidth(index)} height={bottom - top} className="usage-weekend"/> : null)}
            {Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step).map(value => <g key={value}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="usage-grid-line"/><text x={left - 8} y={y(value) + 4} textAnchor="end" className="usage-axis">{format(value)}</text></g>)}
            <g clipPath={`url(#${clip})`} key={`${summary.range}:${metric}:${grouping}`} className={bars ? 'usage-daily-bars' : lines ? 'usage-daily-lines' : 'usage-daily-areas'}>
                {!lines && !bars && geometries.flatMap((geometry, groupIndex) => geometry.paths.map((path, index) => <path key={`${groupIndex}:${series[index]!.id}`} d={path} fill={series[index]!.color} stroke="var(--usage-panel)" strokeWidth=".5"/>))}
                {lines && series.map((item, seriesIndex) => { let path = '', wash = '', connected = false, lastX = left; values.forEach((row, index) => { const value = row[seriesIndex]; if (index > 0 && calendar.slots[index]!.start > calendar.slots[index - 1]!.end + 1e-9) { if (connected) wash += `L${lastX},${bottom}Z `; connected = false; } if (value == null) { if (connected) wash += `L${lastX},${bottom}Z `; connected = false; return; } if (!connected) wash += `M${x(index)},${bottom} `; path += `${connected ? 'L' : 'M'}${x(index)},${y(value)} `; wash += `L${x(index)},${y(value)} `; lastX = x(index); connected = true; }); if (connected) wash += `L${lastX},${bottom}Z`; return <g key={item.id}><path d={wash} fill={`url(#${clip}-wash)`}/><path d={path} fill="none" stroke={item.color} strokeWidth="2"/>{values.map((row, index) => row[seriesIndex] == null ? null : <circle key={index} cx={x(index)} cy={y(row[seriesIndex]!)} r="2.5" fill={item.color}/>)}</g>; })}
                {bars && values.flatMap((row, index) => { let sum = 0; return row.map((value, seriesIndex) => { const base = sum; sum += value ?? 0; return <rect key={`${index}:${seriesIndex}`} x={x(index) - Math.min(24, slotWidth(index) * .76) / 2} y={y(sum)} width={Math.min(24, slotWidth(index) * .76)} height={Math.max(0, y(base) - y(sum) - 1)} rx="2" fill={series[seriesIndex]!.color} opacity={selected && selected !== summary.days[index]!.date ? .32 : 1}/>; }); })}
            </g>
            {average !== null && <g><line x1={left} x2={right} y1={y(average)} y2={y(average)} className="usage-average-line"/><text x={right - 3} y={y(average) - 6} textAnchor="end" className="usage-axis">Avg {format(average)}</text></g>}
            {hovered >= 0 && <line x1={x(hovered)} x2={x(hovered)} y1={top} y2={bottom} className="usage-linked-crosshair" pointerEvents="none"/>}
            {peakIndex >= 0 && totals[peakIndex]! > 0 && <text x={x(peakIndex)} y={Math.max(top + 11, y(totals[peakIndex]!) - 8)} textAnchor={x(peakIndex) > right - 90 ? 'end' : x(peakIndex) < left + 90 ? 'start' : 'middle'} className="usage-chart-annotation">{usageChartDate(summary.days[peakIndex]!.date)} · {format(totals[peakIndex]!)}</text>}
            {summary.days.map((day, index) => <g key={day.date} role="button" tabIndex={index === 0 || selected === day.date ? 0 : -1} className="usage-daily-hit" aria-label={`${usageBucketLabel(summary, day.date)}: ${format(totals[index]!)} ${metric === 'tokens' ? 'tokens' : ''}`} aria-pressed={selected === day.date} onClick={() => onSelect(selected === day.date ? '' : day.date)} onMouseEnter={() => setHover(day.date)} onFocus={() => setHover(day.date)} onBlur={() => setHover('')} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(selected === day.date ? '' : day.date); } else if (event.key === 'Escape') onSelect(''); else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = Math.max(0, Math.min(summary.days.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-daily-hit')[next]?.focus(); } }}><rect x={slotStart(index)} y={top} width={slotWidth(index)} height={bottom - top + 8} fill="transparent"/>{selected === day.date && <rect x={x(index) - 9} y={bottom + 3} width="18" height="4" rx="2" className="usage-selection-underline"/>}</g>)}
            {summary.days.filter((_, index) => index % Math.max(1, Math.ceil(summary.days.length / Math.max(2, Math.floor(width / 80)))) === 0).map(day => <text key={day.date} x={x(summary.days.indexOf(day))} y="298" textAnchor="middle" className="usage-axis">{usageChartDate(day.date)}</text>)}
            {hovered >= 0 && <g pointerEvents="none" className="usage-chart-tooltip" transform={`translate(${Math.max(left, Math.min(right - 190, x(hovered) + 12))},42)`}><rect width="190" height={30 + series.length * 18} rx="10"/><text x="10" y="18">{usageBucketLabel(summary, hover)}</text>{series.map((item, index) => <text key={item.id} x="10" y={37 + index * 18}>{item.label}: {format(values[hovered]?.[index] ?? null)}</text>)}</g>}
        </svg>
    </section>;
}

export function UsageDailyDetail({ summary, selected, onClear }: { summary: UsageRangeSummary; selected: string; onClear: () => void }) {
    const day = summary.days.find(day => day.date === selected), value = day ?? summary;
    const tokens = value.tokens, total = usageTotal(tokens), outcomes = day ?? usageRangeOutcomes(summary);
    const families = new Map<string, number>();
    for (const model of summary.models) { const family = usageAnalyticsFamily(model.label), amount = day ? day.models.find(item => item.id === model.id)?.total ?? 0 : usageTotal(model.tokens); families.set(family, (families.get(family) ?? 0) + amount); }
    const ranked = [...families].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    const parts = ranked.slice(0, 5); if (ranked.length > 5) parts.push(['Rest', ranked.slice(5).reduce((sum, [, amount]) => sum + amount, 0)]);
    let offset = 0, tokenOffset = 0;
    const split = [{ label: 'Cache reads', value: tokens.read }, { label: 'Fresh input', value: tokens.fresh }, { label: 'Output', value: tokens.output }, { label: 'Cache writes', value: tokens.write }];
    return <section className={`usage-panel usage-daily-detail${day ? ' usage-pinned' : ''}`} aria-label="Day detail"><header className="usage-detail-header"><div><div className="usage-eyebrow">{day ? usageBucketDays(summary) > 1 ? 'Pinned days' : 'Pinned day' : 'Selected range'}</div><h3>{day ? usageBucketLabel(summary, day.date) : summary.range === 'all' ? 'All retained history' : `Last ${summary.range === '7d' ? 7 : 30} days`}</h3></div>{day && <button onClick={onClear}>Whole range</button>}</header>
        <dl className="usage-daily-stats">{[
            ['Model requests', usageNumber(usageModelRequestCount(value))], ['Sessions', usageNumber(value.sessions)], ['Most at once', value.parallel.state === 'available' ? usageNumber(value.parallel.peak) : '–'], ['Tokens', usageCompact(total)], ['From cache', usageShare(tokens) === null ? '–' : usagePercent(usageShare(tokens)!)], ['Tool error rate', usageToolRate(outcomes) === null ? '–' : usagePercent(usageToolRate(outcomes)!)],
        ].map(([label, number]) => <div key={label}><dt>{label}</dt><dd>{number}{label === 'From cache' && usageCacheCoverageLabel(value.cacheWriteReporting) && <small className="usage-cache-coverage">{usageCacheCoverageLabel(value.cacheWriteReporting)}</small>}</dd></div>)}</dl>
        <div className="usage-inspector-block"><h4>Model families</h4><div className="usage-daily-donut"><svg viewBox="0 0 116 116" aria-label="Tokens by model family">{parts.map(([family, amount]) => { const start = offset; offset += amount / Math.max(1, total) * 100; return <circle key={family} cx="58" cy="58" r="47" fill="none" stroke={usageAnalyticsFamilyColor(family)} strokeWidth="13" pathLength="100" strokeDasharray={`${Math.max(0, offset - start - .5)} ${100 - Math.max(0, offset - start - .5)}`} strokeDashoffset={-start} transform="rotate(-90 58 58)"><title>{`${family}: ${usageCompact(amount)}`}</title></circle>; })}<text x="58" y="58" textAnchor="middle" className="usage-donut-number">{usageCompact(total)}</text><text x="58" y="75" textAnchor="middle" className="usage-axis">tokens</text></svg><div>{parts.map(([family, amount]) => <div key={family} className="usage-detail-composition"><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={usageAnalyticsFamilyColor(family)}/></svg><span>{family}</span><b>{usagePercent(amount / Math.max(1, total) * 100)}</b></div>)}</div></div></div>
        <div className="usage-inspector-block"><h4>Where the tokens go</h4><svg className="usage-token-composition" viewBox="0 0 100 4" preserveAspectRatio="none" aria-label="Token split">{split.map((part, index) => { const start = tokenOffset; tokenOffset += part.value / Math.max(1, total) * 100; return <rect key={part.label} x={start} y="0" width={Math.max(0, tokenOffset - start - .5)} height="4" rx="1" fill={`var(--usage-category-${index})`}/>; })}</svg>{split.map((part, index) => <div className="usage-detail-composition" key={part.label}><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={`var(--usage-category-${index})`}/></svg><span>{part.label}</span><b>{usageCompact(part.value)}</b><small>{usagePercent(part.value / Math.max(1, total) * 100)}</small></div>)}</div>
    </section>;
}
