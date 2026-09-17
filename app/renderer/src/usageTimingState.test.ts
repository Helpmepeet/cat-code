import { expect, test } from 'bun:test';
import type { UsageTimelineEvent } from '../../shared/usageDashboard.js';
import {
    layoutUsageTimeline,
    usageDuration,
    usageOutcome,
} from './usageTimingState.js';

const events: UsageTimelineEvent[] = [
    { id: 'm1', kind: 'model', callId: 'opaque-call-a', label: 'Model A', provider: 'openai', mode: 'streaming', attempt: 1, startedAt: '2026-09-17T10:00:00.000Z', outcome: 'failed', durationMs: 4_000, firstTextMs: 800 },
    { id: 'tool', kind: 'tool', label: 'Bash', startedAt: '2026-09-17T10:00:01.000Z', outcome: 'succeeded', durationMs: 1_000 },
    { id: 'm2', kind: 'model', callId: 'opaque-call-a', label: 'Model A', provider: 'openai', mode: 'streaming', attempt: 2, startedAt: '2026-09-17T10:00:05.000Z', outcome: 'incomplete', durationMs: null, firstTextMs: null },
];

test('duration and incomplete labels never substitute a historical zero', () => {
    expect(usageDuration(450)).toBe('450 ms');
    expect(usageDuration(1_250)).toBe('1.3 s');
    expect(usageDuration(119_600)).toBe('2 min');
    expect(usageDuration(null)).toBe('No end recorded');
    expect(usageOutcome('incomplete')).toBe('No end recorded');
});

test('timeline layout keeps overlaps on separate lanes and groups retries without exposing ids', () => {
    const layout = layoutUsageTimeline(events);
    expect(layout.lanes).toBe(2);
    expect(layout.items.map(item => item.callLabel)).toEqual(['Call 1', null, 'Call 1']);
    expect(layout.links).toHaveLength(1);
    expect(layout.items[1]!.lane).not.toBe(layout.items[0]!.lane);
    expect(JSON.stringify(layout)).not.toContain('Call opaque-call-a');
    expect(layout.startMs).toBe(Date.parse(events[0]!.startedAt));
    expect(layout.endMs).toBe(Date.parse(events[2]!.startedAt));
});
