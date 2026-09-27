import { useState } from 'react';
import type { UsageDay } from '../../shared/usageDashboard.js';
import { usageChartDate } from './usageGraphState.js';
import { useUsageChartWidth, usageNumber, usageTotal } from './usageDashboardState.js';
import type { UsageDailyActivity } from './usageTrendState.js';

const DAY_MS = 86400000, BOX = 28, MAX_BOX = 44, GAP = 4;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const civilDay = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);
const dayKey = (time: number): string => new Date(time).toISOString().slice(0, 10);
const dayLabel = (date: string): string => `${WEEKDAYS[new Date(civilDay(date)).getUTCDay()]}, ${usageChartDate(date)}`;

type HeatCell = { date: string; day: UsageDay | undefined; column: number; row: number };

export function UsageHeatmap({ activity, range, onSelect, selected = '', selectedBucketDays = 1 }: {
    activity: UsageDailyActivity;
    /** The page's current period; only its days can be selected. */
    range: { startDate: string; endDateExclusive: string };
    onSelect: (date: string) => void;
    selected?: string;
    selectedBucketDays?: number;
}) {
    const [active, setActive] = useState(activity.lastDate);
    const [hovered, setHovered] = useState<string | null>(null);
    const chart = useUsageChartWidth();
    const width = chart.width;
    // Columns are Monday-first weeks ending with the latest day. Short history shows only its own
    // weeks, so boxes stretch to fill the panel up to MAX_BOX instead of leaving empty weeks.
    const last = civilDay(activity.lastDate), first = civilDay(activity.firstDate);
    const lastMonday = last - (new Date(last).getUTCDay() + 6) % 7 * DAY_MS;
    const historyWeeks = Math.floor((lastMonday - (first - (new Date(first).getUTCDay() + 6) % 7 * DAY_MS)) / (7 * DAY_MS)) + 1;
    const columns = Math.max(1, Math.min(historyWeeks, Math.floor((width + GAP) / (BOX + GAP))));
    const size = Math.min(MAX_BOX, (width - (columns - 1) * GAP) / columns);
    const cells: HeatCell[] = [];
    for (let column = 0; column < columns; column++) {
        for (let row = 0; row < 7; row++) {
            const time = lastMonday - (columns - 1 - column) * 7 * DAY_MS + row * DAY_MS;
            if (time < first || time > last) continue;
            const date = dayKey(time);
            cells.push({ date, day: activity.days.get(date), column, row });
        }
    }
    const tokens = (cell: HeatCell) => cell.day ? usageTotal(cell.day.tokens) : 0;
    const max = Math.max(1, ...cells.map(tokens));
    const weeks = new Set(cells.map(cell => cell.column)).size;
    const height = 7 * size + 6 * GAP;
    const selectedStart = selected ? civilDay(selected) : NaN;
    const isSelectedDay = (date: string) => {
        const offset = (civilDay(date) - selectedStart) / DAY_MS;
        return offset >= 0 && offset < selectedBucketDays;
    };
    const selectable = (date: string) => date >= range.startDate && date < range.endDateExclusive;
    const shown = cells.find(cell => cell.date === hovered);
    const tabbable = cells.some(cell => cell.date === active) ? active : cells.at(-1)?.date;
    const focus = (date: string, target: SVGGElement) => {
        const next = target.ownerSVGElement?.querySelector<SVGGElement>(`[data-date="${date}"]`);
        if (!next) return;
        setActive(date);
        next.focus();
    };
    return <>
        <div className="usage-chart-toolbar"><span>Last {weeks} {weeks === 1 ? 'week' : 'weeks'}</span><div className="usage-heat-key" aria-label="Intensity from fewer to more tokens"><span>Less</span>{[0, 1, 2, 3, 4, 5].map(level => <i key={level} className={`usage-heat-${level}`}/>)}<span>More</span></div></div>
        <svg ref={chart.ref} className="usage-heatmap usage-heatmap-week" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Tokens by local day" onMouseLeave={() => setHovered(null)}>
            {cells.map(cell => {
                const count = tokens(cell);
                const level = count === 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(count / max * 5)));
                const enabled = selectable(cell.date);
                return <g key={cell.date} data-date={cell.date} className="usage-heat-cell" role="button" tabIndex={tabbable === cell.date ? 0 : -1} aria-pressed={isSelectedDay(cell.date)} aria-disabled={!enabled || undefined} aria-label={`${cell.date}: ${usageNumber(count)} tokens`}
                    onMouseEnter={() => setHovered(cell.date)} onFocus={() => { setActive(cell.date); setHovered(cell.date); }} onBlur={() => setHovered(null)}
                    onClick={() => { if (enabled) onSelect(cell.date); }} onKeyDown={event => {
                        const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (enabled) onSelect(cell.date); }
                        else if (event.key === 'Escape') { setHovered(null); onSelect(''); }
                        else if (step) { event.preventDefault(); focus(dayKey(civilDay(cell.date) + step * DAY_MS), event.currentTarget); }
                    }}>
                    <rect x={cell.column * (size + GAP)} y={cell.row * (size + GAP)} width={size} height={size} rx={Math.max(2, Math.round(size * 0.12))} className={`usage-heat-${level}${isSelectedDay(cell.date) ? ' usage-heat-selected' : ''}`}/>
                </g>;
            })}
        </svg>
        {shown && <div className="usage-interaction-readout" role="status"><strong>{dayLabel(shown.date)}</strong><span>{usageNumber(tokens(shown))} tokens, {usageNumber(shown.day?.requests ?? 0)} tool requests</span></div>}
    </>;
}
