import type {
    UsageExecutionOutcome,
    UsageTimelineEvent,
} from '../../shared/usageDashboard.js';

const VIEWBOX_LEFT = 42;
const VIEWBOX_WIDTH = 916;

export type UsageTimelineLayoutItem = {
    event: UsageTimelineEvent;
    startMs: number;
    endMs: number;
    x: number;
    width: number;
    lane: number;
    callLabel: string | null;
};

export type UsageTimelineRetryLink = {
    fromX: number;
    fromLane: number;
    toX: number;
    toLane: number;
};

export type UsageTimelineLayout = {
    startMs: number;
    endMs: number;
    lanes: number;
    items: UsageTimelineLayoutItem[];
    links: UsageTimelineRetryLink[];
};

export function usageDuration(value: number | null): string {
    if (value === null) return 'No end recorded';
    if (value < 1_000) return `${Math.round(value)} ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
    const roundedSeconds = Math.round(value / 1_000);
    const minutes = Math.floor(roundedSeconds / 60);
    const seconds = roundedSeconds % 60;
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export function usageOutcome(outcome: UsageExecutionOutcome): string {
    if (outcome === 'incomplete') return 'No end recorded';
    return `${outcome[0]!.toUpperCase()}${outcome.slice(1)}`;
}

export function usageUtcTime(timestamp: string | number): string {
    const value = new Date(timestamp);
    if (!Number.isFinite(value.getTime())) return 'Unknown time';
    return value.toISOString().slice(11, 19);
}

export function layoutUsageTimeline(events: readonly UsageTimelineEvent[]): UsageTimelineLayout {
    const parsed = events
        .map(event => ({ event, startMs: Date.parse(event.startedAt) }))
        .filter((item): item is { event: UsageTimelineEvent; startMs: number } => Number.isFinite(item.startMs))
        .sort((a, b) => a.startMs - b.startMs || a.event.id.localeCompare(b.event.id));
    if (!parsed.length) return { startMs: 0, endMs: 0, lanes: 0, items: [], links: [] };

    const startMs = parsed[0]!.startMs;
    const measuredEnd = Math.max(...parsed.map(item => item.startMs + (item.event.durationMs ?? 0)));
    const endMs = Math.max(startMs + 1, measuredEnd);
    const span = endMs - startMs;
    const laneEnds: number[] = [];
    const callNumbers = new Map<string, number>();
    const lastByCall = new Map<string, UsageTimelineLayoutItem>();
    const links: UsageTimelineRetryLink[] = [];
    const items = parsed.map(({ event, startMs: eventStart }) => {
        const eventEnd = eventStart + (event.durationMs ?? 0);
        let lane = laneEnds.findIndex(end => end <= eventStart);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = Math.max(eventStart + 1, eventEnd);
        const x = VIEWBOX_LEFT + ((eventStart - startMs) / span) * VIEWBOX_WIDTH;
        const measuredWidth = event.durationMs === null ? 0 : (event.durationMs / span) * VIEWBOX_WIDTH;
        let callLabel: string | null = null;
        if (event.kind === 'model') {
            if (!callNumbers.has(event.callId)) callNumbers.set(event.callId, callNumbers.size + 1);
            callLabel = `Call ${callNumbers.get(event.callId)}`;
        }
        const item: UsageTimelineLayoutItem = {
            event,
            startMs: eventStart,
            endMs: eventEnd,
            x,
            width: event.durationMs === null ? 0 : Math.max(4, measuredWidth),
            lane,
            callLabel,
        };
        if (event.kind === 'model') {
            const previous = lastByCall.get(event.callId);
            if (previous) {
                links.push({
                    fromX: previous.x + previous.width,
                    fromLane: previous.lane,
                    toX: item.x,
                    toLane: item.lane,
                });
            }
            lastByCall.set(event.callId, item);
        }
        return item;
    });
    return { startMs, endMs, lanes: laneEnds.length, items, links };
}
