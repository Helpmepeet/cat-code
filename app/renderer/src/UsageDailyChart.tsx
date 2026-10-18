import { useId, useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageCompact, usageNumber, usagePercent, usageTotal, usageShare, useUsageChartWidth } from './usageDashboardState.js';
import { usageChartDate } from './usageGraphState.js';
import { usageBucketDays, usageBucketLabel } from './usageTrendState.js';
import { usageAnalyticsFamily, usageAnalyticsFamilyColor, usageCacheCoverageLabel, usageCalendarAverage, usageDailyComposition, usageDailyDayLabel, usageDailyDelta, usageDailyDeltaTone, usageDailyDonut, usageDailyGradientStops, usageDailyLine, usageDailyMarks, usageDailyMetrics, usageDailyPlot, usageDailyPointer, usageModelRequestCount, usageDailySeries, usageDailyTotal, usageRangeOutcomes, usageToolRate, useUsageDailyChartSize, useUsageDailyTooltip, type UsageDailyMetric, type UsageTokenGrouping } from './usageDailyChartState.js';

function DailyTooltip({ head, rows, x, y, width, height }: { head: string; rows: readonly { label: string; value: string; color?: string }[]; x: number; y: number; width: number; height: number }) {
    const tip = useUsageDailyTooltip(x, y, width, height, head, rows);
    return <foreignObject className="usage-daily-tooltip" {...tip.box} pointerEvents="none"><div ref={tip.ref} className="usage-daily-tooltip-body"><div className="usage-daily-tooltip-head">{head}</div>{rows.map((row, index) => <div className="usage-daily-tooltip-row" key={index}>{row.color && <svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={row.color}/></svg>}<span>{row.label}</span><b>{row.value}</b></div>)}</div></foreignObject>;
}

export function UsageDailyChart({ summary, metric, grouping, hidden, modelFamily, selected, partial = false, onMetricChange, onGroupingChange, onHiddenChange, onModelFamilyChange, onSelect }: {
    summary: UsageRangeSummary; metric: UsageDailyMetric; grouping: UsageTokenGrouping; hidden: readonly string[]; modelFamily: readonly string[]; selected: string; partial?: boolean;
    onMetricChange: (metric: UsageDailyMetric) => void; onGroupingChange: (grouping: UsageTokenGrouping) => void;
    onHiddenChange: (hidden: string[]) => void; onModelFamilyChange: (families: string[]) => void; onSelect: (date: string) => void;
}) {
    const [hover, setHover] = useState('');
    const chart = useUsageDailyChartSize();
    const clip = `daily-${useId().replaceAll(':', '')}`;
    const allSeries = usageDailySeries(summary, metric, grouping);
    const isVisible = (id: string) => !hidden.includes(id) && !(metric === 'tokens' && grouping === 'family' && modelFamily.length > 0 && !modelFamily.includes(id));
    const series = allSeries.filter(item => isVisible(item.id));
    const format = (value: number | null) => value === null ? '–' : metric === 'errorRate' ? usagePercent(value) : usageCompact(value);
    const values = summary.days.map(day => series.map(item => item.value(day)));
    const totals = values.map(row => row.reduce<number>((sum, value) => sum + (value ?? 0), 0));
    const lines = metric === 'sessions' || metric === 'errorRate';
    const bars = metric === 'toolErrors' || metric === 'auto';
    const lastIndex = values.reduce((last, row, index) => row[0] != null ? index : last, -1);
    const axisFormat = (value: number) => metric === 'errorRate' ? `${Math.round(value)}%` : usageCompact(value);
    const plot = usageDailyPlot(summary, metric, chart.width, totals, axisFormat, lastIndex < 0 ? null : values[lastIndex]![0]!, chart.height, format);
    const { left, right, top, bottom, x, y, slotStart, slotWidth } = plot;
    const marks = usageDailyMarks(values, plot), line = usageDailyLine(values.map(row => row[0] ?? null), plot);
    const average = metric === 'errorRate' ? usageDailyTotal(summary, metric) : !lines && !bars ? usageCalendarAverage(summary, totals) : null;
    const peakIndex = totals.indexOf(Math.max(...totals));
    const hovered = summary.days.findIndex(day => day.date === hover), pinned = summary.days.findIndex(day => day.date === selected);
    const title = usageDailyMetrics.find(item => item.id === metric)!.title;
    const delta = usageDailyDelta(summary, metric, partial);
    const hoverParts = hovered < 0 ? [] : series.map((item, index) => ({ label: item.label, value: format(values[hovered]![index] ?? null), color: item.color, amount: values[hovered]![index] ?? null, index })).filter(item => lines || item.amount !== null && item.amount > 0);
    const tooltipRows: { label: string; value: string; color?: string }[] = lines ? hoverParts : [...hoverParts].reverse();
    if (!lines && series.length > 1 && hovered >= 0) tooltipRows.push({ label: 'Total', value: format(totals[hovered]!) });
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
        <div className="usage-daily-head"><div><div className="usage-eyebrow">{title}</div><div className="usage-hero-number">{format(usageDailyTotal(summary, metric))}</div><div className="usage-note">{usageBucketDays(summary) > 1 ? `Per ${usageBucketDays(summary)} days` : 'Per day'}{(hidden.length > 0 || metric === 'tokens' && grouping === 'family' && modelFamily.length > 0) && ' · total includes hidden series'}</div>{delta && <div className={`usage-daily-delta${usageDailyDeltaTone(metric, delta)}`}><b>{delta.text}</b> vs prior {summary.range === '7d' ? 7 : 30} days</div>}</div>
            <div className="usage-daily-metrics" role="tablist" aria-label="Metric">{usageDailyMetrics.map(item => <button key={item.id} role="tab" aria-selected={metric === item.id} onClick={() => onMetricChange(item.id)}>{item.label}</button>)}</div></div>
        <div className="usage-daily-tools">{metric === 'tokens' && <div className="usage-daily-group" role="tablist" aria-label="Break down by">{(['family', 'source'] as const).map(value => <button key={value} role="tab" aria-selected={grouping === value} onClick={() => onGroupingChange(value)}>By {value === 'family' ? 'model family' : value}</button>)}</div>}
            <div className="usage-daily-chips" aria-label="Daily series">{metric === 'errorRate' ? <span className="usage-daily-reference"><svg width="16" height="8" aria-hidden="true"><line x1="0" x2="16" y1="4" y2="4" className="usage-average-line"/></svg>Range average {format(usageDailyTotal(summary, metric))}</span> : allSeries.length > 1 && <>{allSeries.map(item => <button key={item.id} className="usage-daily-chip" aria-pressed={isVisible(item.id)} onClick={() => toggleSeries(item.id)} onDoubleClick={() => { onHiddenChange(metric === 'tokens' && grouping === 'family' ? [] : allSeries.filter(other => other.id !== item.id).map(other => other.id)); if (metric === 'tokens' && grouping === 'family') onModelFamilyChange([item.id]); }}><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="3.25" fill={isVisible(item.id) ? item.color : 'none'} stroke={isVisible(item.id) ? item.color : 'var(--usage-axis-ink)'} strokeWidth="1.5"/></svg>{item.label}{metric === 'tokens' && grouping === 'source' && <b>{seriesShare(item.id)}</b>}</button>)}{(hidden.length > 0 || modelFamily.length > 0 && metric === 'tokens' && grouping === 'family') && <button className="usage-daily-chip usage-daily-reset" onClick={() => { onHiddenChange([]); onModelFamilyChange([]); }}>Show all</button>}</>}</div></div>
        <svg ref={chart.ref} className="usage-chart usage-daily-svg" width={chart.width} height={chart.height} viewBox={`0 0 ${chart.width} ${chart.height}`} aria-label={`${title} per day`} onMouseLeave={() => setHover('')}>
            <defs><clipPath id={clip}><rect x={left} y={top} width={right - left} height={bottom - top}/></clipPath><linearGradient id={`${clip}-wash`} x1="0" y1="0" x2="0" y2="1">{usageDailyGradientStops.map(([offset, opacity]) => <stop key={offset} offset={offset} stopColor={series[0]?.color ?? 'var(--accent)'} stopOpacity={opacity}/>)}</linearGradient></defs>
            {!lines && !bars && usageBucketDays(summary) === 1 && summary.days.map((day, index) => [0, 6].includes(new Date(`${day.date}T12:00:00Z`).getUTCDay()) ? <rect key={day.date} x={slotStart(index)} y={top} width={slotWidth(index)} height={bottom - top} className="usage-weekend"/> : null)}
            {plot.ticks.map(value => <g key={value}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="usage-grid-line"/><text x={left - 10} y={y(value)} dy=".32em" textAnchor="end" className="usage-axis">{axisFormat(value)}</text></g>)}
            {!lines && !bars && pinned >= 0 && <rect className="usage-daily-selected-band" x={slotStart(pinned)} y={top} width={slotWidth(pinned)} height={bottom - top}/>}
            {bars && hovered >= 0 && <rect className="usage-daily-hover-band" x={slotStart(hovered)} y={top - 6} width={slotWidth(hovered)} height={bottom - top + 6} rx="8"/>}
            {lines && pinned >= 0 && <line className="usage-linked-crosshair usage-daily-pin-rule" x1={x(pinned)} x2={x(pinned)} y1={top} y2={bottom}/>}
            <g clipPath={`url(#${clip})`} key={`${summary.range}:${metric}:${grouping}`} className={bars ? 'usage-daily-bars' : lines ? 'usage-daily-lines' : 'usage-daily-areas'}>
                {!lines && !bars && marks.areas.flatMap((geometry, groupIndex) => geometry.paths.map((path, index) => <path key={`${groupIndex}:${series[index]!.id}`} d={path} fill={series[index]!.color} stroke="var(--usage-panel)" strokeWidth=".5" strokeLinejoin="round"/>))}
                {!lines && !bars && marks.areas.flatMap((geometry, groupIndex) => geometry.centerPaths.flatMap((paths, index) => Math.max(...values.map(row => row[index] ?? 0)) / plot.max * (bottom - top) < 1.5 ? paths.map((path, pathIndex) => <path key={`thin:${groupIndex}:${index}:${pathIndex}`} d={path} fill="none" stroke={series[index]!.color} strokeWidth="1" strokeLinecap="round"/>) : []))}
                {lines && series[0] && <g><path d={line.wash} fill={`url(#${clip}-wash)`}/><path className="usage-daily-line-path" d={line.path} fill="none" stroke={series[0].color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength="1"/>{values.map((row, index) => row[0] == null ? null : <circle key={index} cx={x(index)} cy={y(row[0])} r={pinned === index ? 5 : 2.5} fill={series[0]!.color} stroke="var(--usage-panel)" strokeWidth="1.5"/>)}</g>}
                {bars && marks.bars.map(mark => <path key={`${mark.index}:${mark.seriesIndex}`} d={mark.path} fill={series[mark.seriesIndex]!.color} opacity={(hovered >= 0 ? hovered !== mark.index : pinned >= 0 && pinned !== mark.index) ? .32 : 1}/>)}
            </g>
            <line className="usage-daily-baseline" x1={left} x2={right} y1={bottom} y2={bottom}/>
            {average !== null && <g><line x1={left} x2={right} y1={y(average)} y2={y(average)} className="usage-average-line"/>{!lines && <text x={right - 3} y={y(average) - 6} textAnchor="end" className="usage-axis">Avg {format(average)}</text>}</g>}
            {lines && lastIndex >= 0 && <text x={x(lastIndex) + 9} y={y(values[lastIndex]![0]!)} dy=".32em" className="usage-chart-annotation usage-daily-last-value">{format(values[lastIndex]![0]!)}</text>}
            {hovered >= 0 && !bars && <g pointerEvents="none"><line x1={x(hovered)} x2={x(hovered)} y1={top} y2={bottom} className="usage-linked-crosshair"/>{hoverParts.filter(part => part.amount !== null).map(part => <circle key={part.label} cx={x(hovered)} cy={y(lines ? part.amount! : values[hovered]!.slice(0, part.index + 1).reduce<number>((sum, value) => sum + (value ?? 0), 0))} r={lines ? 5 : 3.5} fill={part.color} stroke="var(--usage-panel)" strokeWidth={lines ? 2 : 1.5}/>)}</g>}
            {!lines && peakIndex >= 0 && totals[peakIndex]! > 0 && <text x={x(peakIndex)} y={Math.max(top + 11, y(totals[peakIndex]!) - (bars ? 7 : 8))} textAnchor={bars ? 'middle' : x(peakIndex) > right - 90 ? 'end' : x(peakIndex) < left + 90 ? 'start' : 'middle'} className="usage-chart-annotation">{bars ? format(totals[peakIndex]!) : `${usageChartDate(summary.days[peakIndex]!.date)} · ${format(totals[peakIndex]!)}`}</text>}
            {summary.days.map((day, index) => <g key={day.date} role="button" tabIndex={index === 0 || selected === day.date ? 0 : -1} className="usage-daily-hit" aria-label={`${usageBucketLabel(summary, day.date)}: ${format(lines ? values[index]?.[0] ?? null : totals[index]!)} ${metric === 'tokens' ? 'tokens' : ''}`} aria-pressed={selected === day.date} onClick={() => onSelect(selected === day.date ? '' : day.date)} onMouseEnter={() => setHover(day.date)} onFocus={() => setHover(day.date)} onBlur={() => setHover('')} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(selected === day.date ? '' : day.date); } else if (event.key === 'Escape') onSelect(''); else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = Math.max(0, Math.min(summary.days.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-daily-hit')[next]?.focus(); } }}><rect x={slotStart(index)} y={top} width={slotWidth(index)} height={bottom - top + 8} fill="transparent"/>{bars && selected === day.date && <rect x={x(index) - 9} y={bottom + 3} width="18" height="4" rx="2" className="usage-selection-underline"/>}</g>)}
            {plot.labels.map(index => <text key={index} x={x(index)} y={chart.height - 6} textAnchor="middle" className="usage-axis">{usageChartDate(summary.days[index]!.date)}</text>)}
            {hovered >= 0 && <DailyTooltip head={usageDailyDayLabel(summary, hover)} rows={tooltipRows} x={x(hovered)} y={lines && values[hovered]?.[0] != null ? y(values[hovered]![0]!) : (top + bottom) / 2} width={chart.width} height={chart.height}/>}
        </svg>
    </section>;
}

export function UsageDailyDetail({ summary, selected, onClear }: { summary: UsageRangeSummary; selected: string; onClear: () => void }) {
    const day = summary.days.find(day => day.date === selected), value = day ?? summary;
    const tokens = value.tokens, total = usageTotal(tokens), outcomes = day ?? usageRangeOutcomes(summary);
    const [hoverFamily, setHoverFamily] = useState<{ name: string; x: number; y: number; height: number } | null>(null), [hoverToken, setHoverToken] = useState<string | null>(null);
    const composition = useUsageChartWidth();
    const tokenClip = `token-split-${useId().replaceAll(':', '')}`;
    const families = new Map<string, number>();
    for (const model of summary.models) { const family = usageAnalyticsFamily(model.label), amount = day ? day.models.find(item => item.id === model.id)?.total ?? 0 : usageTotal(model.tokens); families.set(family, (families.get(family) ?? 0) + amount); }
    const ranked = [...families].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    const parts = ranked.slice(0, 5); if (ranked.length > 5) parts.push(['Rest', ranked.slice(5).reduce((sum, [, amount]) => sum + amount, 0)]);
    const familyTotal = parts.reduce((sum, [, amount]) => sum + amount, 0), arcs = usageDailyDonut(parts.map(([, amount]) => amount));
    const split = [{ label: 'Cache reads', value: tokens.read }, { label: 'Fresh input', value: tokens.fresh }, { label: 'Output', value: tokens.output }, { label: 'Cache writes', value: tokens.write }];
    const segments = usageDailyComposition(split.map(part => part.value), composition.width);
    const family = parts.find(([name]) => name === hoverFamily?.name), token = split.find(part => part.label === hoverToken);
    return <section className={`usage-panel usage-daily-detail${day ? ' usage-pinned' : ''}`} aria-label="Day detail"><header className="usage-detail-header"><div><div className="usage-eyebrow">{day ? usageBucketDays(summary) > 1 ? 'Pinned days' : 'Pinned day' : 'Selected range'}</div><h3>{day ? usageDailyDayLabel(summary, day.date) : summary.range === 'all' ? 'All retained history' : `Last ${summary.range === '7d' ? 7 : 30} days`}</h3></div>{day && <button onClick={onClear}>Whole range</button>}</header>
        <dl className="usage-daily-stats">{[
            ['Model requests', day ? usageNumber(usageModelRequestCount(value)) : usageCompact(usageModelRequestCount(value))], ['Sessions', usageNumber(value.sessions)], ['Most at once', value.parallel.state === 'available' ? usageNumber(value.parallel.peak) : '–'], ['Tokens', usageCompact(total)], ['From cache', usageShare(tokens) === null ? '–' : usagePercent(usageShare(tokens)!)], ['Tool error rate', usageToolRate(outcomes) === null ? '–' : usagePercent(usageToolRate(outcomes)!)],
        ].map(([label, number]) => <div key={label}><dt>{label}</dt><dd>{number}{label === 'From cache' && usageCacheCoverageLabel(value.cacheWriteReporting) && <small className="usage-cache-coverage">{usageCacheCoverageLabel(value.cacheWriteReporting)}</small>}</dd></div>)}</dl>
        <div className="usage-detail-blocks"><div className="usage-inspector-block"><h4>Model families</h4><div className="usage-daily-donut">
            <svg viewBox="0 0 116 116" aria-label="Tokens by model family" onMouseLeave={() => setHoverFamily(null)}>
                {parts.map(([name, amount], index) => <path key={name} className="usage-daily-donut-arc" d={arcs[index]} fill={usageAnalyticsFamilyColor(name)} fillRule="evenodd" tabIndex={0} aria-label={`${name}: ${usageCompact(amount)}, ${usagePercent(amount / Math.max(1, familyTotal) * 100)}`}
                    onMouseEnter={() => setHoverFamily({ name, x: 52, y: 52, height: 104 })}
                    onMouseMove={event => setHoverFamily({ name, ...usageDailyPointer(event, event.currentTarget.ownerSVGElement!.parentElement!.getBoundingClientRect(), composition.width, 104) })}
                    onMouseLeave={() => setHoverFamily(null)}
                    onFocus={() => setHoverFamily({ name, x: 52, y: 52, height: 104 })} onBlur={() => setHoverFamily(null)}/>)}
                <text x="58" y="58" dy=".1em" textAnchor="middle" className="usage-donut-number">{usageCompact(familyTotal)}</text><text x="58" y="58" dy="1.55em" textAnchor="middle" className="usage-donut-caption">tokens</text>
            </svg>
            <div className="usage-detail-family-legend">{parts.map(([name, amount]) => <div key={name} className="usage-detail-composition" title={`${name}: ${usageCompact(amount)}`}><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={usageAnalyticsFamilyColor(name)}/></svg><span>{name}</span><b>{usagePercent(amount / Math.max(1, familyTotal) * 100)}</b></div>)}</div>
            {family && hoverFamily && <svg className="usage-detail-tooltip-layer" width="100%" height={hoverFamily.height}><DailyTooltip head={family[0]} rows={[{ color: usageAnalyticsFamilyColor(family[0]), label: usageCompact(family[1]), value: usagePercent(family[1] / Math.max(1, familyTotal) * 100) }]} x={hoverFamily.x} y={hoverFamily.y} width={composition.width} height={hoverFamily.height}/></svg>}
        </div></div>
        <div className="usage-inspector-block"><h4>Where the tokens go</h4><svg ref={composition.ref} className="usage-token-composition" width={composition.width} height="10" viewBox={`0 0 ${composition.width} 10`} aria-label="Token split" onMouseLeave={() => setHoverToken(null)}><defs><clipPath id={tokenClip}><rect width={composition.width} height="10" rx="5"/></clipPath></defs><g clipPath={`url(#${tokenClip})`}>{split.map((part, index) => part.value > 0 && <rect key={part.label} x={segments[index]!.x} y="0" width={segments[index]!.width} height="10" fill={`var(--usage-category-${index})`} tabIndex={0} aria-label={`${part.label}: ${usageCompact(part.value)}, ${usagePercent(part.value / Math.max(1, total) * 100)}`} onMouseEnter={() => setHoverToken(part.label)} onFocus={() => setHoverToken(part.label)} onBlur={() => setHoverToken(null)}/>)}</g>{token && <DailyTooltip head={token.label} rows={[{ label: usageCompact(token.value), value: usagePercent(token.value / Math.max(1, total) * 100), color: `var(--usage-category-${split.indexOf(token)})` }]} x={composition.width / 2} y={10} width={composition.width} height={100}/>}</svg>
            <div className="usage-detail-token-legend">{split.map((part, index) => <div className="usage-detail-composition" key={part.label}><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={`var(--usage-category-${index})`}/></svg><span>{part.label}</span><b>{usageCompact(part.value)}</b><small>{usagePercent(part.value / Math.max(1, total) * 100)}</small></div>)}</div>
        </div></div>
    </section>;
}
