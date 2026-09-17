import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageSessionTimeline, UsageTimingSummary } from '../../shared/usageDashboard.js';
import { UsageLatencyPanel, UsageSessionTimelineView } from './UsageTiming.js';

const timing: UsageTimingSummary = {
    models: {
        state: 'available', logicalCalls: 4, retriedCalls: 1, streamingAttempts: 5,
        outcomes: { started: 6, succeeded: 3, failed: 1, cancelled: 1, incomplete: 1 },
        responseDuration: { samples: 3, p50Ms: 1_200, p95Ms: 8_400 },
        firstText: { samples: 2, p50Ms: 420, p95Ms: 900 },
    },
    tools: {
        state: 'available',
        outcomes: { started: 3, succeeded: 2, failed: 0, cancelled: 0, incomplete: 1 },
        duration: { samples: 2, p50Ms: 250, p95Ms: 1_250 },
    },
};

const timeline: UsageSessionTimeline = {
    state: 'truncated', omitted: 2, items: [
        { id: 'a', kind: 'model', callId: 'raw-correlation-id', label: 'GPT 5.6', provider: 'openai', mode: 'streaming', attempt: 1, startedAt: '2026-09-17T10:00:00.000Z', outcome: 'failed', durationMs: 2_500, firstTextMs: 450 },
        { id: 'b', kind: 'model', callId: 'raw-correlation-id', label: 'GPT 5.6', provider: 'openai', mode: 'streaming', attempt: 2, startedAt: '2026-09-17T10:00:03.000Z', outcome: 'incomplete', durationMs: null, firstTextMs: null },
        { id: 'c', kind: 'tool', label: 'Read', startedAt: '2026-09-17T10:00:01.000Z', outcome: 'succeeded', durationMs: 800 },
    ],
};

test('latency panel keeps populations accurate without explanatory clutter', () => {
    const html = renderToStaticMarkup(<UsageLatencyPanel timing={timing} invalidTimings={2}/>);
    expect(html).toContain('First text');
    expect(html).toContain('2 samples');
    expect(html).toContain('3 samples');
    expect(html).toContain('p50');
    expect(html).toContain('p95');
    expect(html).toContain('Successful model attempts only');
    expect(html).toContain('Transport retries within one attempt are not counted separately');
    expect(html).toContain('2 invalid timing records were excluded');
    expect(html).not.toContain('6 model attempts');
    expect(html).not.toContain('logical calls');
    expect(html).not.toContain('streaming attempts');
    expect(html).not.toContain('First text measures');
});

test('session timeline shows retries, incomplete starts, overlap scale and omissions without raw ids', () => {
    const html = renderToStaticMarkup(<UsageSessionTimelineView timeline={timeline}/>);
    expect(html).toContain('Call 1 · attempt 1');
    expect(html).toContain('Call 1 · attempt 2');
    expect(html).toContain('No end recorded');
    expect(html).toContain('First text 450 ms');
    expect(html).toContain('Showing 3 recent events');
    expect(html).toContain('overlaps remain visible');
    expect(html).toContain('2 more execution events are not shown');
    expect(html).not.toContain('raw-correlation-id');
});

test('unavailable timing states and timeline stay unavailable instead of rendering zeros', () => {
    const unavailable = structuredClone(timing);
    unavailable.models.state = 'unavailable';
    unavailable.models.firstText = { samples: 0, p50Ms: null, p95Ms: null };
    unavailable.models.responseDuration = { samples: 0, p50Ms: null, p95Ms: null };
    unavailable.tools.state = 'unavailable';
    unavailable.tools.duration = { samples: 0, p50Ms: null, p95Ms: null };
    const latencyHtml = renderToStaticMarkup(<UsageLatencyPanel timing={unavailable}/>);
    expect(latencyHtml.match(/No data/g)).toHaveLength(3);
    expect(latencyHtml).not.toContain('0 samples');
    expect(latencyHtml).not.toContain('Model timing is unavailable');
    expect(latencyHtml).not.toContain('Tool timing is unavailable');
    expect(latencyHtml).not.toContain('0 ms');
    expect(renderToStaticMarkup(<UsageSessionTimelineView timeline={{ state: 'unavailable', omitted: 0, items: [] }}/>)).toContain('Timeline unavailable for this selected day');
});

test('an empty truncated timeline reports hidden events instead of claiming nothing was recorded', () => {
    const html = renderToStaticMarkup(<UsageSessionTimelineView timeline={{ state: 'truncated', omitted: 4, items: [] }}/>);
    expect(html).toContain('No recent execution events are shown');
    expect(html).toContain('4 execution events are not shown');
    expect(html).not.toContain('No execution intervals were recorded');
});

test('a schema-valid extreme duration cannot crash timeline rendering', () => {
    const html = renderToStaticMarkup(<UsageSessionTimelineView timeline={{ state: 'available', omitted: 0, items: [{
        id: 'extreme', kind: 'tool', label: 'Bash', startedAt: '2026-09-17T10:00:00.000Z',
        outcome: 'succeeded', durationMs: Number.MAX_SAFE_INTEGER,
    }] }}/>);
    expect(html).toContain('Bash');
    expect(html).toContain('Unknown time UTC');
});
