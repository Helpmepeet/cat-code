import { useState, type ReactNode } from 'react';
import type { UsageTimingSummary } from '../../shared/usageDashboard.js';
import { analyticsBuilds, analyticsFamilyLabels, analyticsModelFamily, analyticsRouteLabels, analyticsRouteTiles, detailCompact, detailInput, detailLine, detailPercent, detailRate, detailTotal, type UsageAnalyticsActivityProps, type UsageAnalyticsDateProps, type UsageAnalyticsModelsProps, type UsageAnalyticsReliabilityProps } from './usageAnalyticsDetailsState.js';
import { usageTenMinuteClock, usageTenMinuteSlotCount } from './usageWorkPatternsState.js';
import { usageFlowSamples, usageStackedAreaGeometry } from './usageStackedAreaState.js';
import { analyticsActivityAvailable, analyticsBucketAxis, analyticsToolClass, detailCalendarLine, analyticsDuration, analyticsModelLatency } from './usageAnalyticsDetailsState.js';
import './usageAnalyticsDetails.css';

function Section({ title, partial, children }: { title: string; partial: boolean; children: ReactNode }) {
    return <section className="usage-analytics-details" aria-label={title}><header className="uad-section-head"><h2>{title}</h2>{partial && <span>Partial retained history</span>}</header>{children}</section>;
}
function Card({ title, note, children, className = '', id }: { title: string; note?: string; children: ReactNode; className?: string; id?: string }) {
    return <article id={id} className={`uad-card ${className}`}><header><h3>{title}</h3>{note && <p>{note}</p>}</header>{children}</article>;
}
function Spark({ values, className = '' }: { values: readonly (number | null)[]; className?: string }) {
    return <svg className={`uad-spark ${className}`} viewBox="-2 -2 104 34" aria-hidden="true"><path d={detailLine(values, 100, 30)} /></svg>;
}
function ModelOutcomes({ models }: { models: UsageTimingSummary['models'] }) {
    const keys = ['succeeded', 'failed', 'cancelled', 'incomplete'] as const;
    const total = keys.reduce((sum, key) => sum + models.outcomes[key], 0);
    return <><dl className="uad-stats">
        <div><dt>Succeeded</dt><dd>{detailPercent(total ? models.outcomes.succeeded / total * 100 : null)}</dd></div>
        <div><dt>Failed</dt><dd>{detailCompact(models.outcomes.failed)}</dd></div>
        <div><dt>Retried calls</dt><dd>{detailCompact(models.retriedCalls)}</dd></div>
    </dl><ul className="uad-outcomes">{keys.map(key => <li key={key} className={`uad-outcome-${key}`}><i className="uad-outcome-dot" /><span>{key[0]!.toUpperCase() + key.slice(1)}</span><strong>{detailCompact(models.outcomes[key])}</strong><span>{detailPercent(total ? models.outcomes[key] / total * 100 : null)}</span></li>)}</ul></>;
}
function ModelLatency({ models }: { models: UsageTimingSummary['models'] }) {
    const [hovered, setHovered] = useState('');
    const { rows, x, ticks } = analyticsModelLatency(models);
    const describe = (row: typeof rows[number]) => `${row.label}: median ${analyticsDuration(row.p50Ms)}, p95 ${analyticsDuration(row.p95Ms)}; ${row.samples.toLocaleString()} samples`;
    const active = rows.find(row => row.id === hovered);
    return <div className="uad-latency"><h4>Latency</h4><p>Recorded samples only. Positive durations use a log scale; zero is shown separately.</p>
        {models.state === 'unavailable' ? <p>Model latency is unavailable.</p> : <>
            <div className="uad-latency-legend"><span><i />Median</span><span><i className="uad-latency-hollow" />p95</span></div>
            <svg className="uad-chart uad-latency-chart" viewBox="0 -5 590 195" role="group" aria-label="Model latency, median and p95" onMouseLeave={() => setHovered('')}>
                {ticks.map(tick => <g key={tick}><line className="uad-grid" x1={x(tick)} x2={x(tick)} y1="0" y2="147" /><text x={x(tick)} y="180" textAnchor="middle">{analyticsDuration(tick)}</text></g>)}
                <text x="150" y="180" textAnchor="middle">0 ms</text>
                {rows.map((row, i) => <g key={row.id} tabIndex={0} aria-label={describe(row)} onFocus={() => setHovered(row.id)} onBlur={() => setHovered('')} onMouseEnter={() => setHovered(row.id)}>
                    <text x="0" y={30 + i * 84}>{row.label}</text><text x="0" y={48 + i * 84}>{row.samples.toLocaleString()} samples</text>
                    {row.p50Ms === null && row.p95Ms === null ? <text x="195" y={32 + i * 84}>Unavailable</text> : <>
                        <line className="uad-grid" x1="195" x2="560" y1={30 + i * 84} y2={30 + i * 84} />
                        {row.p50Ms !== null && row.p95Ms !== null && <line className="uad-latency-range" x1={x(row.p50Ms)} x2={x(row.p95Ms)} y1={30 + i * 84} y2={30 + i * 84} />}
                        {row.p95Ms !== null && <><circle className="uad-latency-p95" cx={x(row.p95Ms)} cy={30 + i * 84} r="5"><title>{`${row.label}: p95 ${analyticsDuration(row.p95Ms)}; ${row.samples} samples`}</title></circle><text x={x(row.p95Ms)} y={52 + i * 84} textAnchor="middle">{analyticsDuration(row.p95Ms)}</text></>}
                        {row.p50Ms !== null && <><circle className="uad-latency-p50" cx={x(row.p50Ms)} cy={30 + i * 84} r="6"><title>{`${row.label}: median ${analyticsDuration(row.p50Ms)}; ${row.samples} samples`}</title></circle><text x={x(row.p50Ms)} y={16 + i * 84} textAnchor="middle">{analyticsDuration(row.p50Ms)}</text></>}
                    </>}
                    <rect className="uad-hit" x="0" y={i * 84} width="580" height="76" />
                </g>)}
            </svg>
            <div className="uad-readout uad-latency-readout" aria-live="off">{active ? describe(active) : ''}</div>
        </>}
    </div>;
}
function RouteTreemap({ tiles, onSelectRoute }: { tiles: ReturnType<typeof analyticsRouteTiles>; onSelectRoute: UsageAnalyticsReliabilityProps['onSelectRoute'] }) {
    const [readout, setReadout] = useState('');
    return <><svg className="uad-chart uad-routes" viewBox="0 0 600 240" role="group" aria-label="Auto-mode routes" onMouseLeave={() => setReadout('')}>{tiles.map(tile => {
        const text = `${analyticsRouteLabels[tile.route]}: ${tile.count} observations; ${tile.notAllowed} not recorded as allowed`;
        return <g key={tile.route} role="button" tabIndex={0} aria-label={text} onMouseEnter={() => setReadout(text)} onFocus={() => setReadout(text)} onClick={() => onSelectRoute(tile.route)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectRoute(tile.route); } }}>
            <rect className={tile.notAllowed / tile.count > 0.5 ? 'uad-route-held' : 'uad-route-allowed'} x={tile.x + 1.5} y={tile.y + 1.5} width={Math.max(0, tile.width - 3)} height={Math.max(0, tile.height - 3)} rx="6" />
            <title>{text}</title>
            {tile.width >= 64 && tile.height >= 34 && <svg x={tile.x} y={tile.y} width={tile.width} height={tile.height} overflow="hidden">
                <text className="uad-route-label" x="10" y="20">{analyticsRouteLabels[tile.route]}</text>
                <text className="uad-route-value" x="10" y="42">{detailCompact(tile.count)}</text>
                {tile.notAllowed > 0 && tile.height > 76 && <text className="uad-route-badge" x="10" y={tile.height - 12}>{detailCompact(tile.notAllowed)} not recorded as allowed</text>}
            </svg>}
        </g>;
    })}</svg><div className="uad-readout" aria-live="off">{readout}</div></>;
}
function UncachedArea({ summary, selectedDate, onSelectDate }: UsageAnalyticsDateProps) {
    const [readout, setReadout] = useState('');
    const samples = usageFlowSamples(summary, [{ value: d => d.tokens.fresh }, { value: d => d.tokens.write }]);
    const { first, last, count } = analyticsBucketAxis(summary);
    const x = (date: string) => (Date.parse(`${date}T00:00:00Z`) - first) / Math.max(86400000, last - first) * 560;
    const peak = Math.max(0, ...samples.map(s => s.values.reduce((a, b) => a + b, 0)));
    const max = Math.max(1, peak);
    const geometry = usageStackedAreaGeometry(samples.map(s => ({ x: x(s.date), values: s.values })), max, 0, 120);
    const average = summary.days.reduce((sum, d) => sum + d.tokens.fresh + d.tokens.write, 0) / count;
    return <><ul className="uad-inline-list"><li>Fresh input</li><li>Reported cache writes</li></ul><svg className="uad-chart uad-uncached" viewBox="-45 -18 620 170" role="group" aria-label="Uncached input by day" onMouseLeave={() => setReadout('')}>
        {(summary.bucketDays ?? 1) === 1 ? samples.filter(s => [0, 6].includes(new Date(`${s.date}T00:00:00Z`).getUTCDay())).map(s => <rect key={s.date} className="uad-weekend" x={x(s.date)} y="0" width={560 / Math.max(1, samples.length)} height="120" />) : null}
        {geometry.paths.map((path, i) => <path key={i} className={i ? 'uad-area-write' : 'uad-area-fresh'} d={path} />)}
        <line className="uad-reference" x1="0" x2="560" y1={120 - average / max * 120} y2={120 - average / max * 120} />
        <text x="0" y="-6">Peak {detailCompact(peak)}</text><text x="560" y="137" textAnchor="end">Average {detailCompact(average)}</text>
        <text x="-8" y="5" textAnchor="end">{detailCompact(max)}</text><text x="-8" y="123" textAnchor="end">0</text>
        {summary.days.map(day => <g key={day.date} role="button" tabIndex={0} aria-label={`${day.date}: ${detailCompact(day.tokens.fresh + day.tokens.write)} uncached input tokens`} aria-pressed={selectedDate === day.date} onMouseEnter={() => setReadout(`${day.date}: ${day.tokens.fresh.toLocaleString()} fresh input; ${day.tokens.write.toLocaleString()} reported cache writes`)} onFocus={() => setReadout(`${day.date}: ${day.tokens.fresh.toLocaleString()} fresh input; ${day.tokens.write.toLocaleString()} reported cache writes`)} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDate(selectedDate === day.date ? '' : day.date); } }}><rect className="uad-hit" x={x(day.date) - 5} y="0" width="10" height="120" /><title>{`${day.date}: ${day.tokens.fresh} fresh input; ${day.tokens.write} reported cache writes`}</title></g>)}
        <text x="0" y="151">{summary.startDate}</text><text x="560" y="151" textAnchor="end">{summary.days.at(-1)?.date}</text>
    </svg><div className="uad-readout" aria-live="off">{readout}</div></>;
}
function DayLine({ values, summary, selectedDate, onSelectDate, label, ceiling, reference }: UsageAnalyticsDateProps & { values: (number | null)[]; label: string; ceiling?: number; reference?: number | null }) {
    const [readout, setReadout] = useState('');
    const max = ceiling ?? Math.max(1, ...values.filter((n): n is number => n !== null));
    const { first, last } = analyticsBucketAxis(summary);
    const span = Math.max(86400000, last - first);
    const positions = summary.days.map(d => (Date.parse(`${d.date}T00:00:00Z`) - first) / span * 560);
    return <><svg className="uad-chart uad-line" viewBox="-45 -12 620 160" role="group" aria-label={label} onMouseLeave={() => setReadout('')}>
        {[0, 0.5, 1].map(v => <g key={v}><line className="uad-grid" x1="0" x2="560" y1={120 * (1 - v)} y2={120 * (1 - v)} /><text x="-8" y={124 - 120 * v} textAnchor="end">{ceiling === 100 ? `${v * 100}%` : detailCompact(max * v)}</text></g>)}
        {reference != null && <line className="uad-reference" x1="0" x2="560" y1={120 - reference / max * 120} y2={120 - reference / max * 120} />}
        <path d={detailCalendarLine(summary, values, 560, 120, max)} />
        {summary.days.map((day, i) => <g key={day.date} role="button" tabIndex={0} aria-label={`${day.date}: ${values[i] === null ? 'Not available' : ceiling === 100 ? detailPercent(values[i]!) : detailCompact(values[i]!)}`} aria-pressed={selectedDate === day.date} onMouseEnter={() => setReadout(`${day.date}: ${detailPercent(values[i] ?? null)}`)} onFocus={() => setReadout(`${day.date}: ${detailPercent(values[i] ?? null)}`)} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDate(selectedDate === day.date ? '' : day.date); } }}>
            <rect className="uad-hit" x={positions[i]! - 7} y="0" width="14" height="120" />
            {values[i] != null && <circle cx={positions[i]} cy={120 - values[i]! / max * 120} r={selectedDate === day.date ? 5 : 2.5} />}
            <title>{`${day.date}: ${values[i] ?? 'Not available'}`}</title>
        </g>)}
        <text x="0" y="144">{summary.startDate}</text><text x="560" y="144" textAnchor="end">{summary.days.at(-1)?.date}</text>
    </svg><div className="uad-readout" aria-live="off">{readout}</div></>;
}
export function UsageAnalyticsCache(props: UsageAnalyticsDateProps) {
    const { summary, partial } = props;
    const [modelReadout, setModelReadout] = useState('');
    const writesComplete = summary.cacheWriteReporting === 'reported';
    const models = [...summary.models].filter(m => detailInput(m.tokens) > 0).sort((a, b) => detailInput(b.tokens) - detailInput(a.tokens));
    const maxInput = Math.max(1, ...models.map(m => detailInput(m.tokens)));
    return <Section title="Cache" partial={partial}><div className="uad-cache-grid">
        <Card title={writesComplete ? 'Cache hit rate' : 'Reported cache hit rate'} note={`${summary.bucketDays && summary.bucketDays > 1 ? `Per ${summary.bucketDays} days` : 'Per day'}; cache reads over all reported input`}>
            {!writesComplete && <p>Cache write coverage is incomplete. Rates reflect reported input, not a complete measured rate.</p>}
            <div className="uad-range-rate">{writesComplete ? 'Range rate' : 'Reported range rate'} {detailPercent(summary.cachedInputShare)}</div>
            <DayLine {...props} label={writesComplete ? 'Daily cache hit rate' : 'Daily reported cache hit rate'} values={summary.days.map(d => detailRate(d.tokens))} ceiling={100} reference={summary.cachedInputShare} />
            <h3>Uncached input</h3><p>Fresh input plus reported cache writes</p>
            {summary.cacheWriteReporting !== 'reported' && <p>Cache writes: {summary.cacheWriteReporting === 'partial' ? 'partially reported' : summary.cacheWriteReporting === 'unreported' ? 'not reported' : 'unavailable'}. Uncached input may be understated.</p>}
            <UncachedArea {...props} />
        </Card>
        <Card title={writesComplete ? 'Hit rate by model' : 'Reported hit rate by model'} note="Dot size shows reported input tokens; dashed line marks the range rate">
            {!writesComplete && <p>Rates reflect reported input; missing cache writes can overstate the cache share.</p>}
            <dl className="uad-stats"><div><dt>Served from cache</dt><dd>{detailCompact(summary.tokens.read)}</dd></div><div><dt>Sent fresh</dt><dd>{detailCompact(summary.tokens.fresh)}</dd></div></dl>
            {models.length ? <svg className="uad-chart uad-dots" viewBox={`0 0 500 ${Math.max(80, models.length * 40 + 35)}`} role="group" aria-label={writesComplete ? 'Cache hit rate by model' : 'Reported cache hit rate by model'} onMouseLeave={() => setModelReadout('')}>
                {summary.cachedInputShare !== null && <line className="uad-reference" x1={210 + summary.cachedInputShare * 2.7} x2={210 + summary.cachedInputShare * 2.7} y1="0" y2={models.length * 40} />}
                {models.map((m, i) => <g key={m.id} tabIndex={0} className={`uad-family-${analyticsModelFamily(m.label)}`} onMouseEnter={() => setModelReadout(`${m.label}: ${detailPercent(detailRate(m.tokens))}; ${detailInput(m.tokens).toLocaleString()} input tokens`)} onFocus={() => setModelReadout(`${m.label}: ${detailPercent(detailRate(m.tokens))}; ${detailInput(m.tokens).toLocaleString()} input tokens`)}><text x="0" y={i * 40 + 23}>{m.label}</text><line className="uad-grid" x1="210" x2="480" y1={i * 40 + 18} y2={i * 40 + 18} /><circle cx={210 + detailRate(m.tokens)! * 2.7} cy={i * 40 + 18} r={3 + Math.sqrt(detailInput(m.tokens) / maxInput) * 9}><title>{`${m.label}: ${detailPercent(detailRate(m.tokens))}, ${detailCompact(detailInput(m.tokens))} input tokens`}</title></circle></g>)}
                <text x="210" y={models.length * 40 + 22}>0%</text><text x="480" y={models.length * 40 + 22} textAnchor="end">100%</text>
            </svg> : <p>No reported model input.</p>}
            <div className="uad-readout" aria-live="off">{modelReadout}</div>
            {summary.detail.omittedModels > 0 && <p>{summary.detail.omittedModels} model labels grouped into Other.</p>}
        </Card></div></Section>;
}

export function UsageAnalyticsActivity({ summary, timezone, partial, selectedDate, onSelectDate }: UsageAnalyticsActivityProps) {
    const [mode, setMode] = useState<'requests' | 'sessions'>('requests');
    const [readout, setReadout] = useState('');
    const available = analyticsActivityAvailable(summary, mode);
    const profiles = Array.from({ length: 24 }, (_, hour) => summary.days.reduce((sum, day) => sum + (day.hours ?? []).filter(h => h.hour === hour).reduce((n, h) => n + h.requests, 0), 0));
    const maxProfile = Math.max(1, ...profiles);
    const max = Math.max(1, ...summary.days.flatMap(d => mode === 'requests' ? Array.from({ length: 24 }, (_, hour) => (d.hours ?? []).filter(h => h.hour === hour).reduce((sum, h) => sum + h.requests, 0)) : (d.parallel.tenMinutePeaks ?? []).map(([, n]) => n)));
    const columns = mode === 'requests' ? 24 : Math.max(144, ...summary.days.map(d => usageTenMinuteSlotCount(d.date, timezone)));
    return <Section title="Activity" partial={partial}><Card title={mode === 'requests' ? 'Tool requests by hour' : 'Sessions running at once'} note={`${timezone}. ${mode === 'requests' ? 'Hourly profile above, daily tool request totals at right. Repeated local hours are combined.' : 'Peak per elapsed 10 minutes; daily peak at right.'}`}>
        <div className="uad-controls" role="group" aria-label="Activity view">{(['requests', 'sessions'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setReadout(''); }}>{value === 'requests' ? 'Tool requests' : 'Sessions at once'}</button>)}</div>
        {(summary.bucketDays ?? 1) > 1 && <p>Each retained bucket spans up to {summary.bucketDays} days. Daily time-of-day detail is unavailable.</p>}
        {summary.range === 'all' && (summary.bucketDays ?? 1) === 1 && available && <p>Only retained days are shown; gaps are not filled.</p>}
        {!available ? <p className="uad-empty">{mode === 'requests' ? 'Hourly tool request detail is unavailable for this range.' : 'Ten-minute concurrency detail is unavailable for this range.'}</p> : <svg className="uad-chart uad-heatmap" viewBox={`0 0 800 ${95 + summary.days.length * 31}`} role="group" aria-label={mode === 'requests' ? 'Hourly tool request heatmap' : 'Ten-minute concurrency heatmap'}>
            {mode === 'requests' && profiles.map((n, i) => <rect key={i} className="uad-profile" x={90 + i * 25} y={42 - n / maxProfile * 36} width="22" height={n / maxProfile * 36}><title>{`${String(i).padStart(2, '0')}:00: ${n} tool requests across this range`}</title></rect>)}
            {summary.days.map((day, row) => {
                const slots = mode === 'requests' ? 24 : usageTenMinuteSlotCount(day.date, timezone);
                const peaks = new Map(day.parallel.tenMinutePeaks);
                return <g key={day.date} role="button" tabIndex={0} aria-label={`Activity for ${day.date}`} aria-pressed={selectedDate === day.date} onClick={() => onSelectDate(selectedDate === day.date ? '' : day.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDate(selectedDate === day.date ? '' : day.date); } }}>
                    <text x="0" y={71 + row * 31}>{day.date.slice(5)}</text>
                    {Array.from({ length: slots }, (_, slot) => {
                        const n = mode === 'requests' ? (day.hours ?? []).filter(h => h.hour === slot).reduce((sum, h) => sum + h.requests, 0) : peaks.get(slot) ?? 0;
                        const clock = mode === 'requests' ? `${String(slot).padStart(2, '0')}:00` : usageTenMinuteClock(day.date, timezone, slot);
                        const observed = mode === 'sessions' || (day.hours ?? []).some(h => h.hour === slot);
                        const text = `${day.date} ${clock}${mode === 'sessions' ? ` (elapsed slot ${slot})` : ''}: ${observed ? `${n} ${mode === 'requests' ? 'tool requests' : 'sessions at once'}` : 'No elapsed local-hour interval'}${mode === 'requests' && observed ? `; ${profiles[slot]} tool requests at this hour across the range` : ''}`;
                        return <rect key={slot} className={observed ? `uad-level-${n === 0 ? 0 : Math.max(1, Math.ceil(Math.sqrt(n / max) * 5))}` : 'uad-missing-cell'} onMouseEnter={() => setReadout(text)} x={90 + slot * 600 / columns} y={54 + row * 31} width={Math.max(1, 600 / columns - 1)} height="24"><title>{text}</title></rect>;
                    })}
                    <text x="710" y={71 + row * 31}>{detailCompact(mode === 'requests' ? day.requests : day.parallel.peak)}{mode === 'sessions' ? ' at once' : ''}</text>
                </g>;
            })}
            {[0, 6, 12, 18].map(hour => <text key={hour} x={90 + (mode === 'requests' ? hour / 24 : hour * 6 / columns) * 600} y={81 + summary.days.length * 31}>{mode === 'requests' ? `${hour}:00` : `${hour}h elapsed`}</text>)}
        </svg>}
        <div className="uad-readout" aria-live="off">{available ? readout : ''}</div>
        {mode === 'sessions' && <div className="uad-concurrency"><h4>Time by sessions at once</h4>{summary.parallel.state === 'unavailable' ? <p>Concurrency duration is unavailable.</p> : <><svg viewBox="0 0 600 24" className="uad-composition" role="img" aria-label="Time by concurrent main sessions">{summary.parallel.minutes.map((minutes, i, all) => { const total = all.reduce((a, b) => a + b, 0); return <rect key={i} className={`uad-level-${i * 2 + 1}`} x={total ? all.slice(0, i).reduce((a, b) => a + b, 0) / total * 600 : 0} width={total ? minutes / total * 600 : 0} height="24"><title>{`${i === 2 ? '3 or more sessions' : `${i + 1} session${i ? 's' : ''}`}: ${minutes} minutes`}</title></rect>; })}</svg><ul className="uad-inline-list">{summary.parallel.minutes.map((minutes, i) => <li key={i}>{i === 2 ? '3 or more' : i + 1} {i === 0 ? 'session' : 'sessions'}: {detailCompact(minutes)} min</li>)}</ul></>}</div>}
    </Card></Section>;
}

export function UsageAnalyticsModels({ summary, partial, modelFamilies, onModelFamiliesChange }: UsageAnalyticsModelsProps) {
    const [sort, setSort] = useState<{ key: 'model' | 'tokens' | 'share' | 'output' | 'spend'; ascending: boolean }>({ key: 'tokens', ascending: false });
    const families = [...new Set(summary.models.map(m => analyticsModelFamily(m.label)))];
    const total = detailTotal(summary.tokens);
    const rows = [...summary.models].sort((a, b) => {
        const value = (m: typeof a) => sort.key === 'output' ? m.tokens.output : sort.key === 'spend' ? m.tokenCost?.usd ?? -1 : detailTotal(m.tokens);
        return (sort.key === 'model' ? a.label.localeCompare(b.label) : value(a) - value(b)) * (sort.ascending ? 1 : -1);
    });
    return <Section title="Models" partial={partial}><Card title="Models" note="Spend is a configured standard-rate estimate, not a bill. Unpriced tokens are excluded.">
        <div className="uad-controls" role="group" aria-label="Model families">{families.map(family => <button key={family} className={`uad-family-${family}`} aria-pressed={!modelFamilies.length || modelFamilies.includes(family)} onClick={() => { const current = modelFamilies.length ? [...modelFamilies] : families; const next = current.includes(family) ? current.filter(f => f !== family) : [...current, family]; onModelFamiliesChange(next.length === families.length ? [] : next.length ? next : ['none']); }}>{analyticsFamilyLabels[family]}</button>)}</div>
        <div className="uad-table-wrap"><table><thead><tr>{([['model', 'Model'], ['tokens', 'Tokens'], ['share', 'Share'], ['trend', 'Trend'], ['output', 'Output'], ['spend', 'Spend estimate']] as const).map(([key, label]) => <th key={key} className={key === 'trend' || key === 'output' ? 'uad-narrow-hide' : ''} aria-sort={key === sort.key ? sort.ascending ? 'ascending' : 'descending' : undefined}>{key === 'trend' ? label : <button onClick={() => setSort({ key, ascending: sort.key === key ? !sort.ascending : key === 'model' })}>{label}</button>}</th>)}</tr></thead><tbody>{rows.map(m => <tr key={m.id} className={`${modelFamilies.length && !modelFamilies.includes(analyticsModelFamily(m.label)) ? 'uad-dim' : ''} uad-family-${analyticsModelFamily(m.label)}`}><th scope="row"><span className="uad-dot" />{m.label}{m.kind === 'unknown' ? ' (unknown)' : m.kind === 'other' ? ' (grouped)' : ''}</th><td>{detailCompact(detailTotal(m.tokens))}</td><td>{detailPercent(total ? detailTotal(m.tokens) / total * 100 : null)}</td><td className="uad-narrow-hide"><Spark values={summary.days.map(d => d.models.find(row => row.id === m.id)?.total ?? 0)} /></td><td className="uad-narrow-hide">{detailCompact(m.tokens.output)}</td><td>{m.tokenCost?.pricedTokens ? `$${m.tokenCost.usd.toFixed(2)}${m.tokenCost.pricedTokens < detailTotal(m.tokens) ? ' partial' : ''}` : 'Unpriced'}</td></tr>)}</tbody></table></div>
        {!rows.length && <p>No model observations.</p>}{summary.detail.omittedModels > 0 && <p>{summary.detail.omittedModels} model labels grouped into Other.</p>}
    </Card></Section>;
}

export function UsageAnalyticsReliability({ summary, partial, onSelectTool, onSelectRoute, onSelectBuild }: UsageAnalyticsReliabilityProps) {
    const [hoveredBuild, setHoveredBuild] = useState('');
    const [selectedBuild, setSelectedBuild] = useState('');
    const outcomes = summary.timing.models;
    const results = summary.tools.reduce((sum, t) => sum + t.results, 0);
    const errors = summary.tools.reduce((sum, t) => sum + t.errors, 0);
    const builds = analyticsBuilds(summary);
    const eligible = builds.items.filter(b => b.results >= 200);
    const readoutBuild = eligible.find(b => `${b.sha}:${b.dirty}` === (hoveredBuild || selectedBuild));
    const displayedAttribution = eligible.reduce((sum, b) => sum + b.results, 0);
    const rates = eligible.map(b => b.errors / b.results * 100).sort((a, b) => a - b);
    const median = rates.length ? (rates[Math.floor((rates.length - 1) / 2)]! + rates[Math.floor(rates.length / 2)]!) / 2 : 0;
    const maxRate = Math.max(1, ...rates);
    const maxResults = Math.max(1, ...eligible.map(b => b.results));
    const first = Math.min(...eligible.map(b => Date.parse(b.first)));
    const span = Math.max(1, Math.max(...eligible.map(b => Date.parse(b.first))) - first);
    const routes = analyticsRouteTiles(summary);
    const auto = summary.autoMode.allTools;
    return <Section title="Reliability" partial={partial}><div className="uad-reliability-grid">
        <Card title="Model calls" note="Recorded attempt outcomes; retries can produce multiple attempts per logical call.">
            {outcomes.state === 'unavailable' ? <p>Model call outcomes are unavailable.</p> : <ModelOutcomes models={outcomes} />}
            <ModelLatency models={outcomes} />
        </Card>
        <Card title="Tools" note="Results and error rate. Red marks rates over 1.5× the overall rate with at least 10 errors.">
            <div className="uad-tools-head"><span>Tool</span><span>Results</span><span>{(summary.bucketDays ?? 1) > 1 ? 'Errors per bucket' : 'Errors per day'}</span><span>Error rate</span></div>
            <ol className="uad-tools">{[...summary.tools].sort((a, b) => (a.kind === 'other' ? 1 : 0) - (b.kind === 'other' ? 1 : 0) || b.results - a.results).map(tool => <li key={tool.id}><button className={`${analyticsToolClass(tool.label)} ${tool.results && results && tool.errors / tool.results > errors / results * 1.5 && tool.errors >= 10 ? 'uad-hot' : ''}`} onClick={() => onSelectTool(tool.id)}><span className="uad-tool-name"><i className="uad-dot" /><span>{tool.label}{tool.kind === 'unknown' ? ' (unknown)' : tool.kind === 'other' ? ' (grouped)' : ''}</span></span><span>{detailCompact(tool.results)}</span><Spark values={summary.days.map(d => d.tools.find(t => t.id === tool.id)?.errors ?? 0)} /><span>{detailPercent(tool.results ? tool.errors / tool.results * 100 : null)}</span></button></li>)}</ol>
            {summary.detail.omittedTools > 0 && <p>{summary.detail.omittedTools} tool labels grouped into Other.</p>}
        </Card>
        <Card id="usage-build-chart" title="Error rate by build" className="uad-build-card" note="Builds with at least 200 tool results. Dot size shows results. Hollow dots include uncommitted changes; red is over 1.5× the median.">
            {eligible.length ? <svg className="uad-chart uad-builds" viewBox="-45 -15 620 255" role="group" aria-label="Tool error rate by build" onMouseLeave={() => setHoveredBuild('')}>
                <line className="uad-reference" x1="0" x2="550" y1={200 - median / maxRate * 190} y2={200 - median / maxRate * 190} />
                <text x="0" y="-3">Median {detailPercent(median)}</text><text x="-8" y="18" textAnchor="end">{detailPercent(maxRate)}</text><text x="-8" y="204" textAnchor="end">0%</text>
                {eligible.map(build => {
                    const key = `${build.sha}:${build.dirty}`;
                    const pick = () => { setSelectedBuild(key); onSelectBuild(build.sha); };
                    return <g key={key} role="button" tabIndex={0} aria-label={`${build.sha}${build.dirty ? ' uncommitted' : ''}: ${detailPercent(build.errors / build.results * 100)}`} aria-pressed={selectedBuild === key} data-active={hoveredBuild === key || selectedBuild === key} onMouseEnter={() => setHoveredBuild(key)} onFocus={() => setHoveredBuild(key)} onBlur={() => setHoveredBuild('')} onClick={pick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
                        <circle className={`${build.dirty ? 'uad-hollow' : ''} ${build.errors / build.results * 100 > median * 1.5 ? 'uad-hot' : ''}`} cx={15 + (Date.parse(build.first) - first) / span * 520} cy={200 - build.errors / build.results * 100 / maxRate * 190} r={4 + Math.sqrt(build.results / maxResults) * 11}><title>{`${build.sha}: ${build.errors} errors / ${build.results} results; first retained request ${build.first}`}</title></circle>
                    </g>;
                })}
                <text x="0" y="232">{eligible[0]?.first.slice(0, 10)}</text><text x="550" y="232" textAnchor="end">{eligible.at(-1)?.first.slice(0, 10)}</text>
            </svg> : <p>No builds with at least 200 tool results.</p>}
            <div className="uad-readout uad-build-readout" aria-live="off">{readoutBuild && <><span className="uad-build-sha">{readoutBuild.sha}</span>{readoutBuild.dirty ? ' · Uncommitted changes' : ' · Committed'} · {detailPercent(readoutBuild.errors / readoutBuild.results * 100)} · {readoutBuild.errors.toLocaleString()} errors / {readoutBuild.results.toLocaleString()} results · First retained request {readoutBuild.first}</>}</div>
            <p>{detailCompact(displayedAttribution)} of {detailCompact(results)} tool results have displayed build attribution.{builds.omitted > 0 ? ' Additional build observations were omitted.' : ''}</p>
        </Card>
        <Card title="Auto mode" note="Permission observations by the check that answered.">
            {auto.coverage.state === 'unavailable' ? <p>Auto-mode observations are unavailable.</p> : <>{auto.coverage.state === 'partial' && <p>Partial auto-mode observations.</p>}<dl className="uad-stats"><div><dt>Held for review</dt><dd>{detailCompact(auto.outcomes.review_required)}</dd></div><div><dt>Blocked</dt><dd>{detailCompact(auto.outcomes.policy_blocked)}</dd></div></dl>
                <RouteTreemap tiles={routes} onSelectRoute={onSelectRoute} />
                {!routes.length && <p>No route observations.</p>}
                {(auto.outcomes.unknown_outcome > 0 || auto.outcomes.incomplete > 0) && <p>{auto.outcomes.unknown_outcome} unknown outcomes; {auto.outcomes.incomplete} incomplete.</p>}
            </>}
        </Card>
    </div></Section>;
}
