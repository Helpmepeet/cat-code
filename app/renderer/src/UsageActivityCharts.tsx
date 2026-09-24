import { useState } from 'react';
import type { UsageDay, UsageHour, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageChartDate, usageHourLabel } from './usageGraphState.js';
import { useUsageChartWidth, usageNumber } from './usageDashboardState.js';

type HeatCell = { day: UsageDay; dayIndex: number; slot: UsageHour };

function offsetLabel(minutes: number): string {
    return `UTC${minutes >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}

export function UsageHeatmap({ summary, asOf, onSelect, selected = '', selectedBucketDays = 1, metric = 'requests' }: {
    summary: UsageRangeSummary;
    asOf: string;
    onSelect: (date: string) => void;
    selected?: string;
    selectedBucketDays?: number;
    partial?: boolean;
    metric?: 'requests' | 'tokens';
}) {
    const [active, setActive] = useState(0);
    const [hovered, setHovered] = useState<number | null>(null);
    const chart = useUsageChartWidth();
    const noun = metric === 'tokens' ? 'tokens' : 'tool requests';
    const cells: HeatCell[] = summary.days.flatMap((day, dayIndex) => (day.hours ?? []).map(slot => ({ day, dayIndex, slot })));
    if (!cells.length) return <p className="usage-note">Hourly activity is unavailable.</p>;
    const future = (slot: UsageHour) => !!slot.startAt && Date.parse(slot.startAt) > Date.parse(asOf);
    const selectedStart = selected ? Date.parse(`${selected}T00:00:00.000Z`) : NaN;
    const isSelectedDay = (date: string) => {
        const offset = (Date.parse(`${date}T00:00:00.000Z`) - selectedStart) / 86400000;
        return offset >= 0 && offset < selectedBucketDays;
    };
    const value = (slot: UsageHour) => metric === 'tokens' ? slot.tokens ?? 0 : slot.requests;
    const max = Math.max(1, ...cells.filter(cell => !future(cell.slot)).map(cell => value(cell.slot)));
    const width = Math.max(320, chart.width), left = 50, right = 8, top = 16;
    const hourStep = (width - left - right) / 24, size = Math.min(18, Math.max(8, hourStep - 3)), rowStep = size + 5;
    const height = top + summary.days.length * rowStep + 25;
    const x = (hour: number) => left + hour * hourStep + (hourStep - size) / 2;
    const y = (dayIndex: number) => top + dayIndex * rowStep;
    const shown = hovered === null ? null : cells[hovered];
    const focus = (index: number, target: SVGGElement) => {
        const next = Math.max(0, Math.min(cells.length - 1, index));
        setActive(next);
        target.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-heat-cell')[next]?.focus();
    };
    return <>
        <div className="usage-chart-toolbar"><span>Last 7 days</span><div className="usage-heat-key" aria-label={`Intensity from fewer to more ${noun}`}><span>Less</span>{[0, 1, 2, 3, 4, 5].map(level => <i key={level} className={`usage-heat-${level}`}/>)}<span>More</span></div></div>
        <svg ref={chart.ref} className="usage-heatmap usage-heatmap-week" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Hourly ${noun} by local day`} onMouseLeave={() => setHovered(null)}>
            {summary.days.map((day, dayIndex) => <g key={day.date}>
                <text x={left - 9} y={y(dayIndex) + size / 2 + 4} textAnchor="end" className="usage-axis">{usageChartDate(day.date)}</text>
                {Array.from({ length: 24 }, (_, hour) => {
                    const slots = (day.hours ?? []).filter(slot => slot.hour === hour);
                    if (!slots.length) return <rect key={hour} x={x(hour)} y={y(dayIndex)} width={size} height={size} rx="2" className="usage-heat-missing" aria-label={`${day.date} ${String(hour).padStart(2, '0')}:00 did not occur locally`}/>;
                    return slots.map((slot, repeat) => {
                        const index = cells.findIndex(cell => cell.dayIndex === dayIndex && cell.slot === slot);
                        const isFuture = future(slot);
                        const count = value(slot);
                        const level = count === 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(count / max * 5)));
                        const splitWidth = (size - Math.max(0, slots.length - 1)) / slots.length;
                        return <g key={`${hour}:${slot.offsetMinutes}:${repeat}`} className="usage-heat-cell" role="button" tabIndex={active === index ? 0 : -1} aria-pressed={isSelectedDay(day.date)} aria-label={`${day.date} ${usageHourLabel(slot)} ${offsetLabel(slot.offsetMinutes)}: ${isFuture ? 'not yet recorded' : `${usageNumber(count)} ${noun}`}`}
                            onMouseEnter={() => setHovered(index)} onFocus={() => { setActive(index); setHovered(index); }} onBlur={() => setHovered(null)}
                            onClick={() => onSelect(day.date)} onKeyDown={event => {
                                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(day.date); }
                                else if (event.key === 'Escape') { setHovered(null); onSelect(''); }
                                else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); focus(index + (event.key === 'ArrowRight' ? 1 : -1), event.currentTarget); }
                                else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); const otherDay = dayIndex + (event.key === 'ArrowDown' ? 1 : -1); const other = cells.findIndex(cell => cell.dayIndex === otherDay && cell.slot.hour === hour); if (other >= 0) focus(other, event.currentTarget); }
                            }}>
                            <rect x={x(hour) + repeat * (splitWidth + 1)} y={y(dayIndex)} width={splitWidth} height={size} rx="2" className={`${isFuture ? 'usage-heat-future' : `usage-heat-${level}`} ${isSelectedDay(day.date) ? 'usage-heat-selected' : ''}`}/>
                        </g>;
                    });
                })}
            </g>)}
            {[0, 6, 12, 18].map(hour => <text key={hour} x={x(hour) + size / 2} y={height - 5} textAnchor="middle" className="usage-axis">{['12a', '6a', '12p', '6p'][hour / 6]}</text>)}
        </svg>
        {shown && <div className="usage-interaction-readout" role="status"><strong>{usageChartDate(shown.day.date)} · {usageHourLabel(shown.slot)} {offsetLabel(shown.slot.offsetMinutes)}</strong><span>{future(shown.slot) ? 'Not yet recorded' : `${usageNumber(value(shown.slot))} ${noun}${metric === 'tokens' ? `, ${usageNumber(shown.slot.requests)} tool requests` : ''}`}</span></div>}
    </>;
}
