import { Fragment, useId, useState, type ReactNode, type KeyboardEvent, type MouseEvent } from 'react';
import type { UsageRangeSummary, UsageTimingSummary, UsageTool } from '../../shared/usageDashboard.js';
import { analyticsFamilyLabels, analyticsModelFamily, analyticsRouteLabels, analyticsRouteTiles, detailCompact, detailInput, detailPercent, detailRate, detailTotal, analyticsActivityAvailable, analyticsToolClass, analyticsDuration, analyticsModelLatency, type UsageAnalyticsActivityProps, type UsageAnalyticsDateProps, type UsageAnalyticsModelsProps, type UsageAnalyticsReliabilityProps } from './usageAnalyticsDetailsState.js';
import { analyticsAreaPath, analyticsAxisLabels, analyticsBuildAxisLabels, analyticsBuildGeometry, analyticsCacheRows, analyticsCalendar, analyticsCalendarValues, analyticsClamp, analyticsCompositionSegments, analyticsConcurrencyLevel, analyticsDateTicks, analyticsDayLabel, analyticsLinearPath, analyticsMonotonePath, analyticsNearestPoint, analyticsNiceMax, analyticsPointCalendar, analyticsRateDomain, analyticsRequestFill, analyticsSparkGeometry, analyticsTextWidth, analyticsTicks, analyticsUncachedGroups, useAnalyticsChartWidth } from './usageAnalyticsChartState.js';
import { usageTenMinuteClock, usageTenMinuteSlotCount } from './usageWorkPatternsState.js';
import { usageStackedAreaGeometry } from './usageStackedAreaState.js';
import './usageAnalyticsDetails.css';
import { analyticsToolErrorReasons, analyticsPatchMechanisms, analyticsPatchFollowups, analyticsPatchCounts, analyticsToolDayErrors, type AnalyticsCount } from './usageAnalyticsDetailsState.js';

function Section({ title, children }: { title: string; children: ReactNode }) {
    return <section className="usage-analytics-details" aria-label={title}><header className="uad-section-head"><h2>{title}</h2></header>{children}</section>;
}
function Card({ title, note, children, className = '', id, controls }: { title: string; note?: string; children: ReactNode; className?: string; id?: string; controls?: ReactNode }) {
    return <article id={id} className={`uad-card ${className}`}><header><div><h3>{title}</h3>{note && <p>{note}</p>}</div>{controls}</header>{children}</article>;
}
function activate(event: KeyboardEvent, action: () => void) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
}
function Gradient({ id, color = 'currentColor' }: { id: string; color?: string }) {
    return <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1">{[[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]].map(([offset, opacity]) => <stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />)}</linearGradient></defs>;
}
type TipLine = { label: string; value: string; className?: string; hollow?: boolean };
function ChartTip({ x, y, width, height, title, lines }: { x: number; y: number; width: number; height: number; title: string; lines: TipLine[] }) {
    const tipWidth = Math.min(width - 4, Math.max(140, analyticsTextWidth(title, '600 12px "DM Sans"') + 20, ...lines.map(line => analyticsTextWidth(line.label, '12px "DM Sans"') + analyticsTextWidth(line.value, '600 12px "DM Sans"') + (line.className ? 48 : 34))));
    const tipHeight = 35 + lines.length * 20;
    const left = analyticsClamp(x + 12, 2, width - tipWidth - 2);
    const top = analyticsClamp(y - tipHeight / 2, 2, Math.max(2, height - tipHeight - 2));
    return <g className="uad-tooltip" role="tooltip" transform={`translate(${left},${top})`}><rect width={tipWidth} height={tipHeight} rx="10" /><svg width={tipWidth} height={tipHeight} overflow="hidden"><text className="uad-tip-title" x="10" y="20">{title}</text>{lines.map((line, i) => <g key={i} className={line.className}>{line.className && <circle className={`uad-tip-marker${line.hollow ? ' uad-tip-hollow' : ''}`} cx="14" cy={38 + i * 20} r="4" />}<text x={line.className ? 26 : 10} y={42 + i * 20}>{line.label}</text><text className="uad-tip-value" x={tipWidth - 10} y={42 + i * 20} textAnchor="end">{line.value}</text></g>)}</svg></g>;
}
function Spark({ values, className = '', height = 28 }: { values: readonly (number | null)[]; className?: string; height?: number }) {
    const { ref, width } = useAnalyticsChartWidth(110);
    const id = useId();
    const geometry = analyticsSparkGeometry(values, width, height);
    return <span ref={ref} className={`uad-spark ${className}`}><svg viewBox={`0 0 ${width} ${height}`} height={height} aria-hidden="true"><Gradient id={id} /><path className="uad-spark-area" d={geometry.area} fill={`url(#${id})`} /><path className="uad-spark-line" d={geometry.line} />{geometry.last && <circle cx={geometry.last.x} cy={geometry.last.y} r="3" />}</svg></span>;
}
function ModelOutcomes({ models }: { models: UsageTimingSummary['models'] }) {
    const keys = ['succeeded', 'failed', 'cancelled', 'incomplete'] as const;
    const total = keys.reduce((sum, key) => sum + models.outcomes[key], 0);
    const segments = analyticsCompositionSegments(keys.map(key => models.outcomes[key]));
    const clip = useId();
    return <><dl className="uad-stats uad-trio">
        <div><dt>Succeeded</dt><dd>{detailPercent(total ? models.outcomes.succeeded / total * 100 : null)}</dd></div>
        <div><dt>Failed</dt><dd>{models.outcomes.failed.toLocaleString()}</dd></div>
        <div><dt>Retried</dt><dd>{models.retriedCalls.toLocaleString()}</dd></div>
    </dl><svg className="uad-composition uad-outcome-composition" viewBox="0 0 600 10" preserveAspectRatio="none" role="img" aria-label="Model call outcomes"><defs><clipPath id={clip}><rect width="600" height="10" rx="5" /></clipPath></defs><g clipPath={`url(#${clip})`}>{keys.map((key, i) => {
        return <rect key={key} className={`uad-outcome-${key}`} x={segments[i]!.x} width={segments[i]!.width} height="10"><title>{`${key}: ${models.outcomes[key].toLocaleString()} (${detailPercent(total ? models.outcomes[key] / total * 100 : null)})`}</title></rect>;
    })}</g></svg><ul className="uad-outcomes">{keys.map(key => <li key={key} className={`uad-outcome-${key}`}><i className="uad-outcome-dot" /><span>{key[0]!.toUpperCase() + key.slice(1)}</span><strong>{models.outcomes[key].toLocaleString()}</strong><span>{detailPercent(total ? models.outcomes[key] / total * 100 : null)}</span></li>)}</ul></>;
}
function ModelLatency({ timing }: { timing: UsageTimingSummary }) {
    const [hovered, setHovered] = useState('');
    const { ref, width } = useAnalyticsChartWidth(590);
    const { rows, x, ticks, zeroX, positiveLeft } = analyticsModelLatency(timing.models, timing.tools, width, analyticsTextWidth);
    const rowHeight = 64, height = rows.length * rowHeight + 26;
    const describe = (row: typeof rows[number]) => `${row.label}: median ${analyticsDuration(row.p50Ms)}, p95 ${analyticsDuration(row.p95Ms)}; ${row.samples.toLocaleString()} samples`;
    const active = rows.find(row => row.id === hovered);
    return <div ref={ref} className="uad-latency"><h4>Latency</h4>
        {timing.models.state === 'unavailable' && <p>Model latency is unavailable.</p>}
        {timing.tools.state === 'unavailable' && <p>Tool latency is unavailable.</p>}
        <div className="uad-latency-legend"><span><i />Median</span><span><i className="uad-latency-hollow" />p95</span></div>
        <svg className="uad-chart uad-latency-chart" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Model and tool latency, median and p95" onMouseLeave={() => setHovered('')}>
            {ticks.map(tick => <g key={tick}><line className="uad-grid" x1={x(tick)} x2={x(tick)} y1="0" y2={height - 22} /><text x={x(tick)} y={height - 6} textAnchor="middle">{analyticsDuration(tick)}</text></g>)}
            <text className="uad-zero-label" x={zeroX} y={height - 6} textAnchor="middle">0 ms</text>
            {rows.map((row, i) => <g key={row.id} tabIndex={0} aria-label={describe(row)} onFocus={() => setHovered(row.id)} onBlur={() => setHovered('')} onMouseEnter={() => setHovered(row.id)}>
                <text x="0" y={i * rowHeight + 30}>{row.label}</text>
                {row.p50Ms === null && row.p95Ms === null ? <text x={positiveLeft} y={i * rowHeight + 32}>Unavailable</text> : <>
                    <line className="uad-grid" x1={positiveLeft} x2={width - 16} y1={i * rowHeight + 30} y2={i * rowHeight + 30} />
                    {row.p50Ms !== null && row.p95Ms !== null && <line className="uad-latency-range" x1={x(row.p50Ms)} x2={x(row.p95Ms)} y1={i * rowHeight + 30} y2={i * rowHeight + 30} />}
                    {row.p95Ms !== null && <><circle className="uad-latency-p95" cx={x(row.p95Ms)} cy={i * rowHeight + 30} r="5"><title>{`${row.label}: p95 ${analyticsDuration(row.p95Ms)}; ${row.samples} samples`}</title></circle><text x={x(row.p95Ms)} y={i * rowHeight + 50} textAnchor="middle">{analyticsDuration(row.p95Ms)}</text></>}
                    {row.p50Ms !== null && <><circle className="uad-latency-p50" cx={x(row.p50Ms)} cy={i * rowHeight + 30} r="6"><title>{`${row.label}: median ${analyticsDuration(row.p50Ms)}; ${row.samples} samples`}</title></circle><text className="uad-ink" x={x(row.p50Ms)} y={i * rowHeight + 16} textAnchor="middle">{analyticsDuration(row.p50Ms)}</text></>}
                </>}
                <rect className="uad-hit" x="0" y={i * rowHeight} width={width} height={rowHeight} />
            </g>)}
            {active && <ChartTip x={x(active.p95Ms ?? active.p50Ms ?? 0)} y={rows.indexOf(active) * rowHeight + 32} width={width} height={height} title={active.label} lines={[{ label: 'Median', value: analyticsDuration(active.p50Ms), className: 'uad-tip-latency' }, { label: 'p95', value: analyticsDuration(active.p95Ms), className: 'uad-tip-latency', hollow: true }, { label: 'Samples', value: active.samples.toLocaleString() }]} />}
        </svg><div className="uad-readout uad-latency-readout" aria-live="off">{active ? describe(active) : ''}</div>
    </div>;
}
function RouteTreemap({ summary, onSelectRoute }: { summary: UsageRangeSummary; onSelectRoute: UsageAnalyticsReliabilityProps['onSelectRoute'] }) {
    const [hovered, setHovered] = useState('');
    const { ref, width } = useAnalyticsChartWidth();
    const tiles = analyticsRouteTiles(summary, width, 230);
    const active = tiles.find(tile => tile.route === hovered);
    const describe = (tile: typeof tiles[number]) => `${analyticsRouteLabels[tile.route]}: ${tile.count.toLocaleString()} observations; ${tile.notAllowed.toLocaleString()} not recorded as allowed`;
    return <div ref={ref} className="uad-route-chart"><svg className="uad-chart uad-routes" viewBox={`0 0 ${width} 230`} role="group" aria-label="Auto-mode routes" onMouseLeave={() => setHovered('')}>{tiles.map(tile => <g key={tile.route} role="button" tabIndex={0} opacity={hovered && hovered !== tile.route ? .55 : 1} aria-label={describe(tile)} onMouseEnter={() => setHovered(tile.route)} onFocus={() => setHovered(tile.route)} onBlur={() => setHovered('')} onClick={() => onSelectRoute(tile.route)} onKeyDown={e => activate(e, () => onSelectRoute(tile.route))}>
        <rect className={tile.notAllowed / tile.count > .5 ? 'uad-route-held' : 'uad-route-allowed'} x={tile.x + (tile.x ? 1.5 : 0)} y={tile.y + (tile.y ? 1.5 : 0)} width={Math.max(0, tile.width - (tile.x ? 1.5 : 0) - (tile.x + tile.width < width - .01 ? 1.5 : 0))} height={Math.max(0, tile.height - (tile.y ? 1.5 : 0) - (tile.y + tile.height < 229.99 ? 1.5 : 0))} rx="6" />
        <title>{describe(tile)}</title>
        {tile.width >= 64 && tile.height >= 34 && <svg x={tile.x} y={tile.y} width={tile.width} height={tile.height} overflow="hidden"><text className="uad-route-label" x="10" y="20">{analyticsRouteLabels[tile.route]}</text><text className="uad-route-value" x="10" y="40">{detailCompact(tile.count)}</text>{tile.notAllowed > 0 && tile.height > 56 && <text className="uad-route-badge" x="10" y={tile.height - 10}>{tile.notAllowed.toLocaleString()} not recorded as allowed</text>}</svg>}
    </g>)}{active && <ChartTip x={active.x + active.width / 2} y={active.y + active.height / 2} width={width} height={230} title={analyticsRouteLabels[active.route]} lines={[{ label: 'Observations', value: active.count.toLocaleString() }, { label: 'Not recorded as allowed', value: active.notAllowed.toLocaleString() }]} />}</svg><div className="uad-readout" aria-live="off">{active ? describe(active) : ''}</div></div>;
}
function UncachedArea({ summary, selectedDate, onSelectDate }: UsageAnalyticsDateProps) {
    const [hovered, setHovered] = useState('');
    const { ref, width } = useAnalyticsChartWidth();
    const values = summary.days.map(day => ({ date: day.date, values: [day.tokens.fresh, day.tokens.write] }));
    const peak = Math.max(0, ...values.map(s => s.values.reduce((a, b) => a + b, 0)));
    const max = analyticsNiceMax(peak * 1.04 || 1), ticks = analyticsTicks(0, max);
    const left = Math.max(...ticks.map(t => analyticsTextWidth(detailCompact(t))), 20) + 12, right = width - 6, top = 22, bottom = 124, height = 150;
    const calendar = analyticsCalendar(summary, left, right);
    const groups = analyticsUncachedGroups(summary, left, right).map(samples => usageStackedAreaGeometry(samples, max, top, bottom));
    const geometry = {
        paths: [0, 1].map(layer => groups.map(group => group.paths[layer]).join(' ')),
        centerPaths: [0, 1].map(layer => groups.flatMap(group => group.centerPaths[layer] ?? [])),
    };
    const average = summary.days.reduce((sum, d) => sum + d.tokens.fresh + d.tokens.write, 0) / calendar.count;
    const y = (n: number) => bottom - n / max * (bottom - top);
    const peakDay = summary.days.find(d => d.tokens.fresh + d.tokens.write === peak);
    const active = summary.days.find(d => d.date === hovered);
    const animationKey = `${summary.range}:${summary.startDate}:${summary.endDateExclusive}`;
    const clip = useId();
    return <div ref={ref}><svg className="uad-chart uad-uncached" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Uncached input by day" onMouseLeave={() => setHovered('')}>
        <defs><clipPath id={clip}><rect x={left} y={top} width={right - left} height={bottom - top} /></clipPath></defs>
        {(summary.bucketDays ?? 1) === 1 && values.filter(s => [0, 6].includes(new Date(`${s.date}T00:00:00Z`).getUTCDay())).map(s => <rect key={s.date} className="uad-weekend" x={calendar.start(s.date)} y={top} width={calendar.bandWidth(s.date)} height={bottom - top} />)}
        {ticks.map(t => <g key={t}><line className="uad-grid" x1={left} x2={right} y1={y(t)} y2={y(t)} /><text x={left - 8} y={y(t) + 4} textAnchor="end">{detailCompact(t)}</text></g>)}
        {selectedDate && summary.days.some(day => day.date === selectedDate) && <rect className="uad-selected-day" x={calendar.start(selectedDate)} y={top} width={calendar.bandWidth(selectedDate)} height={bottom - top} />}
        <g clipPath={`url(#${clip})`}><g className="uad-area-grow" key={animationKey}>{geometry.paths.map((path, i) => <path key={i} className={i ? 'uad-area-write' : 'uad-area-fresh'} d={path} />)}{geometry.centerPaths.map((paths, i) => Math.max(...values.map(s => s.values[i] ?? 0)) / max * (bottom - top) < 1.5 && <path key={`thin-${i}`} className={`uad-thin-layer ${i ? 'uad-area-write' : 'uad-area-fresh'}`} d={paths.join(' ')} />)}</g></g>
        <line className="uad-base" x1={left} x2={right} y1={bottom} y2={bottom} />
        <line className="uad-reference" x1={left} x2={right} y1={y(average)} y2={y(average)} /><text x={right - 3} y={y(average) - 6} textAnchor="end">Average {detailCompact(average)}</text>
        {peakDay && peak > 0 && <text className="uad-ink uad-peak" x={calendar.center(peakDay.date)} y={Math.max(top + 11, y(peak) - 8)} textAnchor={calendar.center(peakDay.date) > right - 90 ? 'end' : calendar.center(peakDay.date) < left + 90 ? 'start' : 'middle'}>{analyticsDayLabel(peakDay.date)} · {detailCompact(peak)}</text>}
        {analyticsDateTicks(summary, right - left).map(date => <text key={date} x={calendar.center(date)} y={height - 6} textAnchor="middle">{analyticsDayLabel(date)}</text>)}
        {summary.days.map(day => <g key={day.date} role="button" tabIndex={0} aria-label={`${day.date}: ${detailCompact(day.tokens.fresh + day.tokens.write)} uncached input tokens`} aria-pressed={selectedDate === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => setHovered(day.date)} onBlur={() => setHovered('')} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => activate(e, () => onSelectDate(selectedDate === day.date ? '' : day.date))}><rect className="uad-hit" x={calendar.start(day.date)} y={top} width={calendar.bandWidth(day.date)} height={bottom - top} /><title>{`${day.date}: ${day.tokens.fresh} fresh input; ${day.tokens.write} reported cache writes`}</title></g>)}
        {active && <><line className="uad-rule" x1={calendar.center(active.date)} x2={calendar.center(active.date)} y1={top} y2={bottom} /><circle className="uad-hover-fresh" cx={calendar.center(active.date)} cy={y(active.tokens.fresh)} r="3.5" /><circle className="uad-hover-write" cx={calendar.center(active.date)} cy={y(active.tokens.fresh + active.tokens.write)} r="3.5" /><ChartTip x={calendar.center(active.date)} y={(top + bottom) / 2} width={width} height={height} title={analyticsDayLabel(active.date)} lines={[{ label: 'Cache writes', value: active.tokens.write.toLocaleString(), className: 'uad-tip-write' }, { label: 'Fresh input', value: active.tokens.fresh.toLocaleString(), className: 'uad-tip-fresh' }, { label: 'Total', value: (active.tokens.fresh + active.tokens.write).toLocaleString() }]} /></>}
    </svg><div className="uad-readout" aria-live="off">{active ? `${active.date}: ${active.tokens.fresh.toLocaleString()} fresh input; ${active.tokens.write.toLocaleString()} reported cache writes` : ''}</div></div>;
}
function DayLine({ summary, selectedDate, onSelectDate, label }: UsageAnalyticsDateProps & { label: string }) {
    const [hovered, setHovered] = useState('');
    const { ref, width } = useAnalyticsChartWidth();
    const values = summary.days.map(d => detailRate(d.tokens));
    const [low, high] = analyticsRateDomain(values, summary.cachedInputShare), ticks = analyticsTicks(low, high, 5);
    const lastIndex = values.reduce<number>((last, n, i) => n === null ? last : i, -1), last = values[lastIndex];
    const left = Math.max(...ticks.map(t => analyticsTextWidth(`${t}%`)), 20) + 12;
    const right = width - (last != null ? analyticsTextWidth(detailPercent(last)) : 0) - 18;
    const top = 16, bottom = 184, height = 210;
    const calendar = analyticsPointCalendar(summary, left, right);
    const y = (n: number) => bottom - (n - low) / (high - low) * (bottom - top);
    const points = summary.days.flatMap((day, i) => {
        const gap = i > 0 && Date.parse(`${day.date}T00:00:00Z`) - Date.parse(`${summary.days[i - 1]!.date}T00:00:00Z`) > calendar.step;
        return [...(gap ? [null] : []), values[i] === null ? null : { x: calendar.center(day.date), y: y(values[i]!) }];
    });
    const activeIndex = summary.days.findIndex(d => d.date === hovered), active = summary.days[activeIndex];
    const id = useId();
    const path = analyticsLinearPath(points);
    return <div ref={ref}><svg className="uad-chart uad-line" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onMouseLeave={() => setHovered('')}><Gradient id={id} />
        {ticks.map(t => <g key={t}><line className="uad-grid" x1={left} x2={right} y1={y(t)} y2={y(t)} /><text x={left - 8} y={y(t) + 4} textAnchor="end">{t}%</text></g>)}
        {selectedDate && <line className="uad-rule uad-pin-rule" x1={calendar.center(selectedDate)} x2={calendar.center(selectedDate)} y1={top} y2={bottom} />}
        <path className="uad-rate-fill" d={analyticsAreaPath(points, bottom)} fill={`url(#${id})`} />
        <path key={`${summary.range}:${summary.startDate}:${summary.endDateExclusive}`} className="uad-rate-line uad-line-draw" d={path} pathLength="1" />
        {summary.cachedInputShare !== null && <line className="uad-reference" x1={left} x2={right} y1={y(summary.cachedInputShare)} y2={y(summary.cachedInputShare)} />}
        <line className="uad-base" x1={left} x2={right} y1={bottom} y2={bottom} />
        {last != null && <text className="uad-ink uad-last-value" x={calendar.center(summary.days[lastIndex]!.date) + 9} y={y(last) + 4}>{detailPercent(last)}</text>}
        {analyticsDateTicks(summary, right - left).map(date => <text key={date} x={calendar.center(date)} y={height - 6} textAnchor="middle">{analyticsDayLabel(date)}</text>)}
        {summary.days.map((day, i) => <g key={day.date} role="button" tabIndex={0} aria-label={`${day.date}: ${detailPercent(values[i] ?? null)}`} aria-pressed={selectedDate === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => setHovered(day.date)} onBlur={() => setHovered('')} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => activate(e, () => onSelectDate(selectedDate === day.date ? '' : day.date))}>
            {values[i] !== null && <circle cx={calendar.center(day.date)} cy={y(values[i]!)} r={selectedDate === day.date ? 5 : 2.5} />}
            <rect className="uad-hit" x={calendar.start(day.date)} y={top} width={calendar.bandWidth(day.date)} height={bottom - top} /><title>{`${day.date}: ${detailPercent(values[i] ?? null)}`}</title>
        </g>)}
        {active && <><line className="uad-rule" x1={calendar.center(active.date)} x2={calendar.center(active.date)} y1={top} y2={bottom} />{values[activeIndex] != null && <circle className="uad-hover-dot" cx={calendar.center(active.date)} cy={y(values[activeIndex]!)} r="5" />}<ChartTip x={calendar.center(active.date)} y={values[activeIndex] != null ? y(values[activeIndex]!) : height / 2} width={width} height={height} title={analyticsDayLabel(active.date)} lines={[{ label, value: detailPercent(values[activeIndex] ?? null) }]} /></>}
    </svg><div className="uad-readout" aria-live="off">{active ? `${active.date}: ${detailPercent(values[activeIndex] ?? null)}` : ''}</div></div>;
}
function CacheDots({ summary }: { summary: UsageRangeSummary }) {
    const [hovered, setHovered] = useState('');
    const { ref, width } = useAnalyticsChartWidth(340);
    const { rows, left, right, domain, x } = analyticsCacheRows(summary, width);
    const maxInput = Math.max(1, ...rows.map(m => detailInput(m.tokens))), height = rows.length * 30 + 28;
    const active = rows.find(m => m.id === hovered);
    return <div ref={ref}>{rows.length ? <svg className="uad-chart uad-dots" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Cache hit rate by model" onMouseLeave={() => setHovered('')}>
        {analyticsTicks(domain[0], domain[1], Math.max(2, Math.floor((right - left) / 64))).map(t => <g key={t}><line className="uad-grid" x1={x(t)} x2={x(t)} y1="4" y2={height - 24} /><text x={x(t)} y={height - 6} textAnchor="middle">{t}%</text></g>)}
        {summary.cachedInputShare !== null && <line className="uad-reference" x1={x(summary.cachedInputShare)} x2={x(summary.cachedInputShare)} y1="4" y2={height - 24} />}
        {rows.map((m, i) => <g key={m.id} tabIndex={0} aria-label={`${m.label}: ${detailPercent(detailRate(m.tokens))}; ${detailInput(m.tokens).toLocaleString()} input tokens`} opacity={hovered && hovered !== m.id ? .4 : 1} className={`uad-family-${analyticsModelFamily(m.label)}`} onMouseEnter={() => setHovered(m.id)} onMouseLeave={() => setHovered('')} onFocus={() => setHovered(m.id)} onBlur={() => setHovered('')}>
            <line className="uad-dot-stem" x1={left} x2={x(detailRate(m.tokens)!)} y1={i * 30 + 19} y2={i * 30 + 19} />
            <svg x="0" y={i * 30 + 4} width={left - 12} height="30" overflow="hidden"><text x="0" y="19">{m.label}</text></svg>
            <circle cx={x(detailRate(m.tokens)!)} cy={i * 30 + 19} r={3.5 + Math.sqrt(detailInput(m.tokens) / maxInput) * 6.5}><title>{`${m.label}: ${detailPercent(detailRate(m.tokens))}, ${detailCompact(detailInput(m.tokens))} input tokens`}</title></circle>
            <text className="uad-ink uad-dot-value" x={width - 2} y={i * 30 + 23} textAnchor="end">{detailPercent(detailRate(m.tokens))}</text><rect className="uad-hit" x="0" y={i * 30 + 4} width={width} height="30" />
        </g>)}
        {active && <ChartTip x={x(detailRate(active.tokens)!)} y={rows.indexOf(active) * 30 + 19} width={width} height={height} title={active.label} lines={[{ label: 'Hit rate', value: detailPercent(detailRate(active.tokens)), className: `uad-family-${analyticsModelFamily(active.label)} uad-tip-family` }, { label: 'Input tokens', value: detailInput(active.tokens).toLocaleString() }]} />}
    </svg> : <p>No reported model input.</p>}<div className="uad-readout" aria-live="off">{active ? `${active.label}: ${detailPercent(detailRate(active.tokens))}; ${detailInput(active.tokens).toLocaleString()} input tokens` : ''}</div></div>;
}
export function UsageAnalyticsCache(props: UsageAnalyticsDateProps) {
    const { summary } = props;
    return <Section title="Cache">
        <div className="uad-cache-grid"><Card title="Cache hit rate" note={summary.bucketDays && summary.bucketDays > 1 ? `Per ${summary.bucketDays} days` : undefined} controls={<div className="uad-range-rate"><i className="uad-dash" />Range rate {detailPercent(summary.cachedInputShare)}</div>}>
            <DayLine {...props} label="Daily cache hit rate" />
            <div className="uad-inner-head"><div><h3>Uncached input</h3></div><ul className="uad-legend uad-cache-legend"><li><i className="uad-fresh-key" />Fresh input</li><li><i className="uad-write-key" />Cache writes</li></ul></div>
            <UncachedArea {...props} />
        </Card>
        <Card title="Hit rate by model">
            <dl className="uad-stats uad-trio uad-duo"><div><dt>Served from cache</dt><dd>{detailCompact(summary.tokens.read)}</dd></div><div><dt>Sent fresh</dt><dd>{detailCompact(summary.tokens.fresh)}</dd></div></dl>
            <CacheDots summary={summary} />
        </Card></div></Section>;
}

export function UsageAnalyticsActivity({ summary, timezone, selectedDate, onSelectDate }: UsageAnalyticsActivityProps) {
    const [mode, setMode] = useState<'requests' | 'sessions'>('requests');
    const [hovered, setHovered] = useState<{ date: string; slot: number } | null>(null);
    const { ref, width } = useAnalyticsChartWidth(800);
    const available = analyticsActivityAvailable(summary, mode);
    const profiles = Array.from({ length: 24 }, (_, hour) => summary.days.reduce((sum, day) => sum + (day.hours ?? []).filter(h => h.hour === hour).reduce((n, h) => n + h.requests, 0), 0));
    const maxProfile = Math.max(1, ...profiles);
    const max = Math.max(1, ...summary.days.flatMap(d => (d.hours ?? []).map(h => (d.hours ?? []).filter(row => row.hour === h.hour).reduce((sum, row) => sum + row.requests, 0))));
    const columns = mode === 'requests' ? 24 : Math.max(144, ...summary.days.map(d => usageTenMinuteSlotCount(d.date, timezone)));
    const left = Math.max(...summary.days.map(d => analyticsTextWidth(analyticsDayLabel(d.date, true))), 60) + 12;
    const sideLabel = (day: typeof summary.days[number]) => mode === 'requests' ? detailCompact(day.requests) : `${day.parallel.peak.toLocaleString()} at once`;
    const right = width - Math.max(...summary.days.map(d => analyticsTextWidth(sideLabel(d))), 40) - 26;
    const band = Math.max(1, (right - left) / columns), top = mode === 'requests' ? 52 : 6, height = top + summary.days.length * 28 + (mode === 'sessions' ? 39 : 22);
    const axisLabels = analyticsAxisLabels(Array.from({ length: 8 }, (_, i) => {
        const hour = i * 3;
        return { x: left + (mode === 'requests' ? hour + .5 : hour * 6) * band, label: String(hour).padStart(2, '0'), anchor: mode === 'requests' ? 'middle' as const : 'start' as const };
    }), left, right);
    const profile = profiles.map((n, i) => ({ x: left + (i + .5) * band, y: 42 - n / maxProfile * 36 }));
    const profilePath = analyticsMonotonePath(profile);
    const id = useId(), clip = useId();
    const activeDay = summary.days.find(d => d.date === hovered?.date);
    const peaks = new Map(summary.days.map(day => [day.date, new Map(day.parallel.tenMinutePeaks)]));
    const cellData = (day: typeof summary.days[number], slot: number) => {
        const hours = (day.hours ?? []).filter(h => h.hour === slot);
        const n = mode === 'requests' ? hours.reduce((sum, h) => sum + h.requests, 0) : peaks.get(day.date)?.get(slot) ?? 0;
        const tokens = hours.length && hours.every(hour => hour.tokens !== undefined) ? hours.reduce((sum, hour) => sum + hour.tokens!, 0) : null;
        const clock = mode === 'requests' ? `${String(slot).padStart(2, '0')}:00` : usageTenMinuteClock(day.date, timezone, slot);
        const observed = mode === 'sessions' || (day.hours ?? []).some(h => h.hour === slot);
        return { n, tokens, clock, observed, text: `${day.date} ${clock}${mode === 'sessions' ? ` (elapsed slot ${slot})` : ''}: ${observed ? `${n} ${mode === 'requests' ? 'tool requests' : 'sessions at once'}` : 'No elapsed local-hour interval'}${mode === 'requests' && observed ? `; ${profiles[slot]} tool requests at this hour across the range` : ''}` };
    };
    const active = activeDay && hovered ? cellData(activeDay, hovered.slot) : null;
    const totalMinutes = summary.parallel.minutes.reduce((sum, n) => sum + n, 0);
    const minuteSegments = analyticsCompositionSegments(summary.parallel.minutes);
    return <Section title="Activity"><Card title={mode === 'requests' ? 'Tool requests by hour' : 'Sessions running at once'} controls={<div className="uad-head-right"><ul className="uad-legend">{mode === 'requests' ? <><li><i className="uad-level-1" />Fewer</li><li><i className="uad-level-5" />More tool requests</li></> : [1, 2, 3, 4, 5].map(n => <li key={n}><i className={`uad-level-${n}`} />{n === 5 ? '5+' : n}</li>)}</ul><div className="uad-segmented" role="group" aria-label="Activity view">{(['requests', 'sessions'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setHovered(null); }}>{value === 'requests' ? 'Tool requests' : 'Sessions at once'}</button>)}</div></div>}>
        <div ref={ref}>{!available ? <p className="uad-empty">{mode === 'requests' ? 'Hourly tool request detail is unavailable for this range.' : 'Ten-minute concurrency detail is unavailable for this range.'}</p> : <svg className="uad-chart uad-heatmap" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={mode === 'requests' ? 'Hourly tool request heatmap' : 'Ten-minute concurrency heatmap'} onMouseLeave={() => setHovered(null)}><Gradient id={id} color="var(--uad-profile-color)" />
            {mode === 'requests' && <g className="uad-profile"><path className="uad-profile-fill" fill={`url(#${id})`} d={`${profilePath} L${profile.at(-1)!.x},42 L${profile[0]!.x},42 Z`} /><path className="uad-profile-line" d={profilePath} />{profiles.map((n, i) => <g key={i}><title>{`${String(i).padStart(2, '0')}:00: ${n} tool requests across this range`}</title>{hovered?.slot === i && <circle cx={profile[i]!.x} cy={profile[i]!.y} r="3.5" />}</g>)}</g>}
            {summary.days.map((day, row) => {
                const slots = mode === 'requests' ? 24 : usageTenMinuteSlotCount(day.date, timezone);
                return <g key={day.date} role="button" tabIndex={0} aria-label={`Activity for ${day.date}`} aria-pressed={selectedDate === day.date} onFocus={() => setHovered({ date: day.date, slot: 0 })} onBlur={() => setHovered(null)} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => activate(e, () => onSelectDate(selectedDate === day.date ? '' : day.date))}>
                    <text x={left - 10} y={top + row * 28 + 18} textAnchor="end">{analyticsDayLabel(day.date, true)}</text>
                    {Array.from({ length: slots }, (_, slot) => {
                        const cell = cellData(day, slot), gap = band > 8 ? 2 : 1;
                        return <rect key={slot} data-slot={slot} className={cell.observed ? mode === 'sessions' ? `uad-level-${analyticsConcurrencyLevel(cell.n)}` : 'uad-request-cell' : 'uad-missing-cell'} fill={mode === 'requests' && cell.observed ? analyticsRequestFill(cell.n, max) : undefined} opacity={hovered && hovered.date !== day.date && hovered.slot !== slot ? .4 : 1} onMouseEnter={() => setHovered({ date: day.date, slot })} x={left + slot * band + gap / 2} y={top + row * 28 + 1} width={Math.max(1, band - gap)} height="26" rx={band > 8 ? 5 : 1.5}><title>{cell.text}</title></rect>;
                    })}
                    <text className="uad-ink uad-day-total" opacity={hovered && hovered.date !== day.date ? .35 : 1} x={width - 2} y={top + row * 28 + 18} textAnchor="end">{sideLabel(day)}</text>
                </g>;
            })}
            {axisLabels.map(tick => <text className="uad-x-axis-label" key={tick.label} x={tick.x} y={height - (mode === 'sessions' ? 23 : 6)} textAnchor={tick.anchor}>{tick.label}</text>)}
            {mode === 'sessions' && <text className="uad-axis-qualifier" x={right} y={height - 6} textAnchor="end">Elapsed hours</text>}
            {active && activeDay && hovered && <ChartTip x={left + (hovered.slot + .5) * band} y={top + summary.days.indexOf(activeDay) * 28 + 14} width={width} height={height} title={`${analyticsDayLabel(activeDay.date, true)}, ${active.clock}`} lines={active.observed ? [{ label: mode === 'requests' ? 'Tool requests' : 'Sessions at once', value: active.n.toLocaleString() }, ...(mode === 'requests' ? [{ label: 'Tokens', value: active.tokens === null ? 'Not available' : detailCompact(active.tokens) }, { label: 'Tool requests at this hour, range', value: profiles[hovered.slot]!.toLocaleString() }] : [{ label: 'Elapsed time', value: `${Math.floor(hovered.slot / 6)}h ${hovered.slot % 6 * 10}m` }])] : [{ label: 'Local hour', value: 'No elapsed interval' }]} />}
        </svg>}</div>
        <div className="uad-readout" aria-live="off">{available && active ? active.text : ''}</div>
        {mode === 'sessions' && <div className="uad-concurrency"><h4>Time by sessions at once</h4>{summary.parallel.state === 'unavailable' ? <p>Concurrency duration is unavailable.</p> : <><svg viewBox="0 0 600 10" preserveAspectRatio="none" className="uad-composition" role="img" aria-label="Time by concurrent main sessions"><defs><clipPath id={clip}><rect width="600" height="10" rx="5" /></clipPath></defs><g clipPath={`url(#${clip})`}>{summary.parallel.minutes.map((minutes, i) => {
            return <rect key={i} className={`uad-level-${i * 2 + 1}`} x={minuteSegments[i]!.x} width={minuteSegments[i]!.width} height="10"><title>{`${i === 2 ? '3 or more sessions' : `${i + 1} session${i ? 's' : ''}`}: ${minutes} minutes`}</title></rect>;
        })}</g></svg><ul className="uad-composition-legend">{summary.parallel.minutes.map((minutes, i) => <li key={i}><i className={`uad-level-${i * 2 + 1}`} /><span>{i === 2 ? '3 or more' : `${i + 1} ${i === 0 ? 'session' : 'sessions'}`}</span><strong>{minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${minutes.toLocaleString()} min`}</strong><span>{detailPercent(totalMinutes ? minutes / totalMinutes * 100 : null)}</span></li>)}</ul></>}</div>}
    </Card></Section>;
}

export function UsageAnalyticsModels({ summary, modelFamilies, onModelFamiliesChange }: UsageAnalyticsModelsProps) {
    const [sort, setSort] = useState<{ key: 'model' | 'tokens' | 'share' | 'output' | 'spend'; ascending: boolean }>({ key: 'tokens', ascending: false });
    const familyTotals = new Map<string, number>();
    for (const model of summary.models) { const family = analyticsModelFamily(model.label); familyTotals.set(family, (familyTotals.get(family) ?? 0) + detailTotal(model.tokens)); }
    const families = [...familyTotals].sort((a, b) => b[1] - a[1]).map(([family]) => family);
    const total = detailTotal(summary.tokens);
    const rows = [...summary.models].sort((a, b) => {
        const value = (m: typeof a) => sort.key === 'output' ? m.tokens.output : sort.key === 'spend' ? m.tokenCost?.pricedTokens ? m.tokenCost.usd : -1 : detailTotal(m.tokens);
        return (sort.key === 'model' ? a.label.localeCompare(b.label) : value(a) - value(b)) * (sort.ascending ? 1 : -1);
    });
    const chips = <div className="uad-controls uad-model-chips" role="group" aria-label="Model families">{families.map(family => <button key={family} className={`uad-family-${family}`} aria-pressed={!modelFamilies.length || modelFamilies.includes(family)} onClick={() => { const current = modelFamilies.length ? [...modelFamilies] : families; const next = current.includes(family) ? current.filter(f => f !== family) : [...current.filter(f => f !== 'none'), family]; onModelFamiliesChange(next.length === families.length ? [] : next.length ? next : ['none']); }}>{analyticsFamilyLabels[family]}</button>)}</div>;
    return <Section title="Models"><Card title="Models" controls={chips}>
        <div className="uad-table-wrap"><table><thead><tr>{([['model', 'Model'], ['tokens', 'Tokens'], ['share', 'Share'], ['trend', 'Trend'], ['output', 'Output'], ['spend', 'Spend estimate']] as const).map(([key, label]) => <th key={key} className={key === 'trend' || key === 'output' ? 'uad-narrow-hide' : ''} aria-sort={key === sort.key ? sort.ascending ? 'ascending' : 'descending' : undefined}>{key === 'trend' ? label : <button onClick={() => setSort({ key, ascending: sort.key === key ? !sort.ascending : key === 'model' })}>{label}</button>}</th>)}</tr></thead><tbody>{rows.map(m => <tr key={m.id} className={`${modelFamilies.length && !modelFamilies.includes(analyticsModelFamily(m.label)) ? 'uad-dim' : ''} uad-family-${analyticsModelFamily(m.label)}`}><th scope="row"><span className="uad-dot" />{m.label}{m.kind === 'unknown' ? ' (unknown)' : m.kind === 'other' ? ' (grouped)' : ''}</th><td>{detailCompact(detailTotal(m.tokens))}</td><td>{detailPercent(total ? detailTotal(m.tokens) / total * 100 : null)}</td><td className="uad-narrow-hide uad-trend"><Spark values={analyticsCalendarValues(summary, d => d.models.find(row => row.id === m.id)?.total ?? 0)} /></td><td className="uad-narrow-hide">{detailCompact(m.tokens.output)}</td><td>{m.tokenCost?.pricedTokens ? `$${m.tokenCost.usd.toFixed(2)}${m.tokenCost.pricedTokens < detailTotal(m.tokens) ? ' partial' : ''}` : 'Unpriced'}</td></tr>)}</tbody></table></div>
        {!rows.length && <p>No model observations.</p>}
    </Card></Section>;
}
function BuildScatter({ summary, onSelectBuild }: { summary: UsageRangeSummary; onSelectBuild: UsageAnalyticsReliabilityProps['onSelectBuild'] }) {
    const [hovered, setHovered] = useState('');
    const [selected, setSelected] = useState('');
    const { ref, width } = useAnalyticsChartWidth();
    const geo = analyticsBuildGeometry(summary, width);
    const active = geo.points.find(point => point.key === (hovered || selected));
    const nearest = (event: MouseEvent<SVGRectElement>) => {
        const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
        return analyticsNearestPoint(geo.points, (event.clientX - bounds.left) * width / (bounds.width || width), (event.clientY - bounds.top) * 280 / (bounds.height || 280));
    };
    const pick = (point: typeof geo.points[number]) => { setSelected(point.key); onSelectBuild(point.sha); };
    return <Card id="usage-build-chart" title="Error rate by build" className="uad-build-card" note="Builds with at least 200 tool results." controls={<ul className="uad-legend uad-build-legend"><li><i className="uad-build-key" />Committed</li><li><i className="uad-build-key uad-hollow-key" />Uncommitted</li><li><i className="uad-error-key" />Over 1.5× median</li>{geo.median !== null && <li><i className="uad-dash" />Median {detailPercent(geo.median)}</li>}</ul>}>
        <div ref={ref}>{geo.points.length ? <svg className="uad-chart uad-builds" viewBox={`0 0 ${width} 280`} role="group" aria-label="Tool error rate by build" onMouseLeave={() => setHovered('')}>
            {analyticsTicks(0, geo.maxRate).map(tick => <g key={tick}><line className="uad-grid" x1={geo.left} x2={geo.right} y1={geo.y(tick)} y2={geo.y(tick)} /><text x={geo.left - 8} y={geo.y(tick) + 4} textAnchor="end">{tick}%</text></g>)}
            <line className="uad-base" x1={geo.left} x2={geo.right} y1={geo.bottom} y2={geo.bottom} />
            {geo.median !== null && <line className="uad-reference" x1={geo.left} x2={geo.right} y1={geo.y(geo.median)} y2={geo.y(geo.median)} />}
            {analyticsBuildAxisLabels(geo.tickTimes, geo.x, geo.left, geo.right).map(tick => <text className="uad-x-axis-label" key={tick.label} x={tick.x} y="274" textAnchor={tick.anchor}>{tick.label}</text>)}
            {geo.points.map(point => <g key={point.key} role="button" tabIndex={0} aria-label={`${point.sha}${point.dirty ? ' uncommitted' : ''}: ${detailPercent(point.rate)}`} aria-pressed={selected === point.key} data-active={hovered === point.key || selected === point.key} opacity={hovered && hovered !== point.key ? .35 : 1} onMouseEnter={() => setHovered(point.key)} onFocus={() => setHovered(point.key)} onBlur={() => setHovered('')} onClick={() => pick(point)} onKeyDown={e => activate(e, () => pick(point))}><circle className={`${point.dirty ? 'uad-hollow' : ''} ${point.hot ? 'uad-hot' : ''}`} cx={point.x} cy={point.y} r={point.r}><title>{`${point.sha}: ${point.errors} errors / ${point.results} results; first retained request ${point.first}`}</title></circle></g>)}
            {geo.points.filter(point => point.hot).sort((a, b) => b.rate - a.rate).slice(0, 3).map(point => <text key={point.key} className="uad-build-sha uad-flagged-build" x={point.x > width - 90 ? point.x - point.r - 5 : point.x + point.r + 5} y={point.y + 4} textAnchor={point.x > width - 90 ? 'end' : 'start'}>{point.sha}</text>)}
            <rect className="uad-hit uad-build-pick" x={geo.left} y={geo.top} width={geo.right - geo.left} height={geo.bottom - geo.top} onMouseMove={event => setHovered(nearest(event)?.key ?? '')} onMouseLeave={() => setHovered('')} onClick={event => { const point = nearest(event); if (point) pick(point); }} />
            {active && <ChartTip x={active.x} y={active.y} width={width} height={280} title={`${active.sha}${active.dirty ? ' · Uncommitted' : ''}`} lines={[{ label: 'First retained request', value: active.first }, { label: 'Tool results', value: active.results.toLocaleString() }, { label: 'Error rate', value: detailPercent(active.rate) }]} />}
        </svg> : <p>No builds with at least 200 tool results.</p>}</div>
        {geo.builds.omitted > 0 && <p>Additional build observations are omitted. Median uses shown builds.</p>}
        <div className="uad-readout uad-build-readout" aria-live="off">{active && <><span className="uad-build-sha">{active.sha}</span>{active.dirty ? ' · Uncommitted changes' : ' · Committed'} · {detailPercent(active.rate)} · {active.errors.toLocaleString()} errors / {active.results.toLocaleString()} results · First retained request {active.first}</>}</div>
    </Card>;
}
function Counts({ items, label, className }: { items: AnalyticsCount[]; label?: string; className?: string }) {
    return items.length ? <p className={className} aria-label={label}>{items.map((item, i) => <Fragment key={item.label}>{i > 0 && ' · '}{item.label}: <b>{item.value}</b></Fragment>)}</p> : null;
}
function PatchDimensions({ tool, summary }: { tool: UsageTool; summary: UsageRangeSummary }) {
    const sessions = summary.rankedSessions.items.flatMap(session => {
        const counts = session.tools.find(item => item.id === tool.id && item.kind === 'named');
        return counts ? [{ session, counts }] : [];
    });
    return <details className="uad-patch-dimensions"><summary>Patch details</summary>
        <p>Rates use returned results. Missing results are not successes. Models identify the request; follow-up sequences belong to the first failed call.</p>
        <p>Later calls are observations from the same agent, not proof of the same target or a correct edit. Shell activity cannot establish whether an edit occurred.</p>
        <Counts label={`${tool.label} patch adjustments`} items={analyticsPatchMechanisms(tool)} />
        <Counts label={`${tool.label} follow-up activity`} items={analyticsPatchFollowups(tool)} />
        {tool.patchModels && <><h4>Models</h4><ul>{tool.patchModels?.map(model => <li key={model.id}><strong>{model.kind === 'unknown' ? 'Unknown model' : model.label}</strong><p>{analyticsPatchCounts(model)}</p>
            <Counts items={analyticsToolErrorReasons(model)} /><Counts items={analyticsPatchMechanisms(model)} /><Counts items={analyticsPatchFollowups(model)} /></li>)}</ul>
        <h4>Retained root sessions</h4>
        {summary.rankedSessions.omitted > 0 && <p>{summary.rankedSessions.omitted.toLocaleString()} root sessions omitted.</p>}
        <ul>{sessions.map(({ session, counts }) => <li key={session.id}><strong>{session.project?.label ? `${session.project.label} · ` : ''}{(session.engineSessionId ?? session.id).slice(0, 8)}</strong><p>{analyticsPatchCounts(counts)}</p>
            <Counts items={analyticsToolErrorReasons(counts)} /><Counts items={analyticsPatchMechanisms(counts)} /><Counts items={analyticsPatchFollowups(counts)} /></li>)}</ul>
        {!sessions.length && <p>No matching root-session detail retained.</p>}</>}
    </details>;
}
function ToolsCard({ summary, selectedToolId, onSelectTool }: Pick<UsageAnalyticsReliabilityProps, 'summary' | 'selectedToolId' | 'onSelectTool'>) {
    const [expanded, setExpanded] = useState(false);
    const [openToolId, setOpenToolId] = useState<string>();
    const listId = useId();
    const tools = summary.toolBreakdown?.items ?? summary.tools;
    const omitted = summary.toolBreakdown?.omitted ?? summary.detail.omittedTools;
    const results = tools.reduce((sum, tool) => sum + tool.results, 0), errors = tools.reduce((sum, tool) => sum + tool.errors, 0);
    const rows = [...tools].sort((a, b) => (a.kind === 'other' ? 1 : 0) - (b.kind === 'other' ? 1 : 0) || b.results - a.results || a.label.localeCompare(b.label));
    const detailed = new Map(summary.tools.map(tool => [tool.id, tool]));
    return <Card title="Tools" className="uad-tools-card" note="Red: over 1.5× the overall rate">
        <div className="uad-tools-head"><span>Tool</span><span>Results</span><span>{(summary.bucketDays ?? 1) > 1 ? 'Errors per bucket' : 'Errors per day'}</span><span>Error rate</span></div>
        <ol id={listId} className="uad-tools">{(expanded ? rows : rows.slice(0, 10)).map(tool => {
            const history = detailed.get(tool.id);
            const available = history?.kind === tool.kind && history.requests === tool.requests && history.results === tool.results && history.errors === tool.errors;
            const errorsByDay = analyticsToolDayErrors(summary, tool, available);
            const reasons = analyticsToolErrorReasons(tool);
            const patch = Boolean(tool.patchModels || tool.patchFollowups || analyticsPatchMechanisms(tool).length);
            const hasDetail = reasons.length > 0 || patch, open = hasDetail && openToolId === tool.id;
            const Row = available || hasDetail ? 'button' : 'div';
            const select = () => { if (hasDetail) setOpenToolId(open ? undefined : tool.id); if (available) onSelectTool(tool.id); };
            return <li key={tool.id}><Row className={`uad-tool-row ${analyticsToolClass(tool.label)} ${tool.results && results && tool.errors / tool.results > errors / results * 1.5 && tool.errors >= 10 ? 'uad-hot' : ''}`} {...(Row === 'button' ? { onClick: select } : {})} {...(available ? { 'aria-pressed': selectedToolId === tool.id } : {})} {...(hasDetail ? { 'aria-expanded': open } : {})}>
                <span className="uad-tool-name" title={tool.kind === 'other' ? 'Combined totals for the remaining tools. Named tools prioritize errors, then usage.' : tool.label}><i className="uad-dot" /><span>{tool.label}{tool.kind === 'unknown' ? ' (unknown)' : tool.kind === 'other' ? ` (${omitted.toLocaleString()} ${omitted === 1 ? 'tool' : 'tools'})` : ''}</span></span>
                <span className="uad-tool-volume">{detailCompact(tool.results)}</span>
                {errorsByDay ? <Spark height={22} values={analyticsCalendarValues(summary, (_, i) => errorsByDay[i] ?? 0)} /> : <span className="uad-tool-history" title="Daily error history unavailable">Unavailable</span>}
                <span className="uad-tool-rate">{detailPercent(tool.results ? tool.errors / tool.results * 100 : null)}</span>
            </Row>{open && <><Counts className="uad-tool-reasons" label={`${tool.label} error reasons`} items={reasons} />
                {patch && <PatchDimensions tool={tool} summary={summary} />}</>}</li>;
        })}</ol>
        {rows.length > 10 && <button className="uad-tools-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer tools' : `Show ${rows.length - 10} more tools`}</button>}
        {!rows.length && <p>No tool observations.</p>}
    </Card>;
}
export function UsageAnalyticsReliability({ summary, selectedToolId, onSelectTool, onSelectRoute, onSelectBuild }: UsageAnalyticsReliabilityProps) {
    const outcomes = summary.timing.models;
    const auto = summary.autoMode.allTools;
    const decisions = Object.values(auto.outcomes).reduce((sum, count) => sum + count, 0);
    return <Section title="Reliability"><div className="uad-reliability-grid">
        <Card title="Model calls">
            {outcomes.state === 'unavailable' ? <p>Model call outcomes are unavailable.</p> : <ModelOutcomes models={outcomes} />}
            <ModelLatency timing={summary.timing} />
        </Card>
        <ToolsCard key={summary.range} summary={summary} selectedToolId={selectedToolId} onSelectTool={onSelectTool} />
        <BuildScatter summary={summary} onSelectBuild={onSelectBuild} />
        <Card title="Auto mode" className="uad-auto-card">
            {auto.coverage.state === 'unavailable' ? <p>Auto-mode observations are unavailable.</p> : <>{auto.coverage.state === 'partial' && <p>Partial auto-mode observations.</p>}<dl className="uad-stats uad-trio"><div><dt>Decisions</dt><dd>{detailCompact(decisions)}</dd></div><div><dt>Held for review</dt><dd>{auto.outcomes.review_required.toLocaleString()}</dd></div><div><dt>Blocked</dt><dd>{auto.outcomes.policy_blocked.toLocaleString()}</dd></div></dl>
                <RouteTreemap summary={summary} onSelectRoute={onSelectRoute} />
                {!summary.autoMode.routes.some(route => route.count > 0) && <p>No route observations.</p>}
                {(auto.outcomes.unknown_outcome > 0 || auto.outcomes.incomplete > 0) && <p>{auto.outcomes.unknown_outcome} unknown outcomes; {auto.outcomes.incomplete} incomplete.</p>}
            </>}
        </Card>
    </div></Section>;
}
