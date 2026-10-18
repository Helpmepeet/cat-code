import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageAnalyticsFamily, usageAnalyticsFamilyColor, usageCalendarAverage, usageDailyBar, usageDailyCalendar, usageDailyComposition, usageDailyDateLabels, usageDailyDeltaTone, usageDailyDonut, usageDailyLine, usageDailyMarks, usageDailyMetricDelta, usageDailyPlot, usageDailySeries, usageDailyTextWidth, usageDailyTooltip, usageDailyTotal, usageLatestBuild, usageMetricSpark, usageSelectedToolId, usageToolRate } from './usageDailyChartState.js';
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
test('sparse All buckets retain real calendar spacing and include empty days in the average', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 1;
    const template = snapshot.ranges['7d'].days[0]!;
    summary.days = ['2026-09-01', '2026-09-03', '2026-09-10'].map(date => ({ ...structuredClone(template), date }));
    const calendar = usageDailyCalendar(summary);
    expect(calendar.slots.map(slot => slot.center)).toEqual([.05, .25, .95]);
    expect(calendar.groups).toEqual([[0], [1], [2]]);
    expect(usageCalendarAverage(summary, [10, 20, 30])).toBe(6);
});
test('multi-day All buckets clamp the partial final bucket to the range end', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 4;
    const template = snapshot.ranges['7d'].days[0]!;
    summary.days = ['2026-09-01', '2026-09-05', '2026-09-09'].map(date => ({ ...structuredClone(template), date }));
    const calendar = usageDailyCalendar(summary);
    expect(calendar.slots.map(slot => slot.end - slot.start)).toEqual([.4, .4, 1 - .8]);
    expect(calendar.slots.at(-1)?.center).toBe(.9);
    expect(calendar.groups).toEqual([[0, 1, 2]]);
    expect(usageCalendarAverage(summary, [40, 40, 20])).toBe(40);
});
test('model families retain prototype order and Claude provider token', () => {
    expect(['gpt-6.1-sol', 'claude-opus-4-6', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-5.5', 'claude-sonnet-4-6', 'unknown'].map(usageAnalyticsFamily)).toEqual(['Sol', 'Claude Opus', 'Luna', 'Terra', 'Astra', 'GPT 5.5', 'Claude Sonnet', 'Other']);
    expect(usageAnalyticsFamilyColor('Claude Opus')).toBe('var(--provider-claude)');
});
test('tokens by source use exclusive token totals and request efforts reconcile the model request total', () => {
    const summary = structuredClone(snapshot.ranges['7d']), day = summary.days[0]!;
    day.tokenSources.chat = { fresh: 10, read: 20, write: 2, output: 3 }; day.tokenSources.subagents.output = 7;
    const sources = usageDailySeries(summary, 'tokens', 'source');
    expect(sources.map(item => item.value(day))).toEqual([35, 7, 0]);
    day.requests = 99; day.effort.requests.high = 4; day.effort.unattributedRequests = 7; summary.effort.requests.high = 4;
    expect(usageDailySeries(summary, 'requests', 'family').map(item => item.value(day))).toEqual([4, 7]);
});
test('tool error rate divides errors by matched results and does not turn missing samples into zero', () => {
    expect(usageToolRate({ results: 0, errors: 0 })).toBeNull(); expect(usageToolRate({ results: 20, errors: 1 })).toBe(5);
    const summary = structuredClone(snapshot.ranges['7d']); summary.days[0]!.results = 20; summary.days[0]!.errors = 1;
    expect(usageDailyTotal(summary, 'toolErrors')).toBe(1); expect(usageDailyTotal(summary, 'errorRate')).toBe(5);
});
test('latest build merges all tools and days and median uses builds with enough results', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    summary.days[0]!.tools = [{ id: 'bash', requests: 200, results: 200, errors: 2, builds: { items: [{ sha: 'abc', dirty: false, requests: 200, results: 200, errors: 2, firstObservedAt: '2026-09-07T00:00:00Z' }] } }];
    summary.days[1]!.tools = [{ id: 'read', requests: 200, results: 200, errors: 4, builds: { items: [{ sha: 'def', dirty: true, requests: 200, results: 200, errors: 4, firstObservedAt: '2026-09-08T00:00:00Z' }] } }];
    const builds = usageLatestBuild(summary); expect(builds.latest?.sha).toBe('def'); expect(builds.latest?.dirty).toBe(true); expect(builds.median).toBe(1.5);
});

test('source colors are blue, teal and amber and effort intensities do not shift with missing levels', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    expect(usageDailySeries(summary, 'tokens', 'source').map(item => item.color)).toEqual(['var(--usage-category-0)', 'var(--usage-category-3)', 'var(--usage-category-4)']);
    summary.effort.requests.high = 3; summary.effort.requests.ultra = 1;
    const colors = () => Object.fromEntries(usageDailySeries(summary, 'requests', 'family').map(item => [item.id, item.color]));
    const sparse = colors();
    summary.effort.requests.low = 2; summary.effort.requests.medium = 1;
    expect(colors().high).toBe(sparse.high);
    expect(colors().ultra).toBe('var(--usage-sequential-5)');
    expect(sparse.high).toBe('var(--usage-sequential-2)');
});

test('plot uses form-specific margins, peak headroom and final date labels', () => {
    const summary = snapshot.ranges['7d'], format = (value: number) => `${value}`;
    const area = usageDailyPlot(summary, 'tokens', 640, [100, 99], format, 99);
    const line = usageDailyPlot(summary, 'sessions', 640, [100, 99], format, 99);
    const bar = usageDailyPlot(summary, 'auto', 640, [100, 99], format, 99);
    expect(area.top).toBe(22); expect(line.top).toBe(16); expect(bar.top).toBe(16);
    expect(area.bottom).toBe(274);
    expect(area.max).toBeGreaterThan(100);
    expect(area.right).toBe(634); expect(bar.right).toBe(636);
    expect(line.right).toBeLessThan(area.right);
    expect(area.labels.at(-1)).toBe(summary.days.length - 1);
    const narrow = usageDailyPlot(summary, 'tokens', 240, [100, 99], format, 99);
    expect(narrow.labels.at(-1)).toBe(summary.days.length - 1);
    expect(narrow.labels.length).toBeLessThan(area.labels.length);
    const tall = usageDailyPlot(summary, 'tokens', 640, [100, 99], format, 99, 420);
    expect(tall.bottom).toBe(394);
    expect(tall.y(0)).toBe(394);
    expect(usageDailyPlot(summary, 'errorRate', 640, [.2, .3], String, .3).max).toBeLessThan(1);
});

test('sparse date labels use physical text extents instead of retained-row intervals', () => {
    const summary = structuredClone(snapshot.ranges.all), template = snapshot.ranges['7d'].days[0]!;
    summary.startDate = '2026-08-15'; summary.endDateExclusive = '2026-10-19'; summary.bucketDays = 1;
    summary.days = ['2026-08-15', '2026-09-16', ...Array.from({ length: 8 }, (_, index) => `2026-10-${11 + index}`)].map(date => ({ ...structuredClone(template), date }));
    const format = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    for (const width of [240, 600, 1000]) for (const metric of ['tokens', 'requests', 'sessions', 'errorRate', 'toolErrors', 'auto'] as const) {
        const plot = usageDailyPlot(summary, metric, width, summary.days.map(() => 10), String, 10);
        expect(plot.labels.at(-1)).toBe(summary.days.length - 1);
        const extents = plot.labels.map(index => {
            const half = usageDailyTextWidth(format.format(new Date(`${summary.days[index]!.date}T12:00:00Z`))) / 2;
            return { left: plot.x(index) - half, right: plot.x(index) + half };
        });
        extents.slice(1).forEach((extent, index) => expect(extent.left - extents[index]!.right).toBeGreaterThanOrEqual(14 - 1e-9));
        if (metric === 'tokens') {
            expect(plot.x(0)).toBeCloseTo(plot.slotStart(0) + plot.slotWidth(0) / 2);
            expect(plot.x(1) - plot.x(0)).toBeCloseTo(32 * plot.slotWidth(0));
        }
    }
});

test('date label selection honors individual measured widths and always retains the final date', () => {
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03'];
    expect(usageDailyDateLabels(dates, index => index * 40, () => 20)).toEqual([0, 1, 2]);
    expect(usageDailyDateLabels(dates, index => index * 40, text => text === 'Oct 3' ? 70 : 20)).toEqual([0, 2]);
    expect(usageDailyDateLabels(dates, () => 0, () => 200)).toEqual([2]);
    expect(usageDailyDateLabels([], () => 0)).toEqual([]);
});

test('line paths preserve unknown observations and sparse calendar gaps', () => {
    const summary = structuredClone(snapshot.ranges.all), template = snapshot.ranges['7d'].days[0]!;
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-06'; summary.bucketDays = 1;
    summary.days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05'].map(date => ({ ...structuredClone(template), date }));
    const plot = usageDailyPlot(summary, 'errorRate', 640, [1, 0, 3, 4], String, 4);
    const line = usageDailyLine([1, null, 3, 4], plot);
    expect(line.path.match(/M/g)).toHaveLength(3);
    expect(line.path).not.toContain('NaN');
    expect(line.wash.match(/Z/g)).toHaveLength(3);
    expect(line.path).not.toContain(`L${plot.x(1)},`);
    summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 4;
    summary.days = ['2026-09-01', '2026-09-09'].map(date => ({ ...structuredClone(template), date }));
    const partial = usageDailyPlot(summary, 'sessions', 640, [10, 20], String, 20);
    expect(partial.x(1)).toBeLessThan(partial.right);
    expect(partial.slotWidth(1)).toBeCloseTo(partial.slotWidth(0) / 2);
});

test('only exposed bar stack tops are rounded and internal separators do not round each segment', () => {
    const summary = snapshot.ranges['7d'], plot = usageDailyPlot(summary, 'toolErrors', 640, [10], String, 10);
    const marks = usageDailyMarks(summary.days.map((_, index) => index ? [0, 0] : [4, 6]), plot);
    expect(marks.bars).toHaveLength(2);
    expect(marks.bars[0]!.path).not.toContain('Q');
    expect(marks.bars[1]!.path).toContain('Q');
    expect(usageDailyBar(0, 20, 10, 30, true)).toStartWith('M0,30V14Q0,10 4,10');
    expect(usageDailyBar(0, 20, 10, 10, true)).toBe('');
});

test('partial final bars remain inside their actual bucket even below the outer-padding fraction', () => {
    const summary = structuredClone(snapshot.ranges.all), template = snapshot.ranges['7d'].days[0]!;
    summary.startDate = '2024-01-01'; summary.bucketDays = 100;
    const bounds = (path: string) => {
        let x = 0;
        const positions: number[] = [];
        for (const match of path.matchAll(/([MHVQZhv])([^MHVQZhv]*)/g)) {
            const values = match[2]!.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/ig)?.map(Number) ?? [];
            if (match[1] === 'M' || match[1] === 'H') { x = values[0]!; positions.push(x); }
            else if (match[1] === 'h') { x += values[0]!; positions.push(x); }
            else if (match[1] === 'Q') { positions.push(values[0]!, values[2]!); x = values[2]!; }
        }
        return { left: Math.min(...positions), right: Math.max(...positions) };
    };
    // One, two and seven retained days are all shorter than the prototype's .08 outer-padding allowance.
    for (const [end, date] of [['2026-06-20', '2026-06-19'], ['2026-06-21', '2026-06-19'], ['2026-06-26', '2026-06-19']]) {
        summary.endDateExclusive = end!;
        summary.days = [{ ...structuredClone(template), date: date! }];
        for (const metric of ['toolErrors', 'auto'] as const) {
            const plot = usageDailyPlot(summary, metric, 600, [10], String, 10);
            const slotLeft = plot.slotStart(0), slotRight = slotLeft + plot.slotWidth(0);
            for (const values of [[[10]], [[4, 6]]]) {
                const marks = usageDailyMarks(values, plot);
                expect(marks.bars).toHaveLength(values[0]!.length);
                for (const mark of marks.bars) {
                    const actual = bounds(mark.path);
                    expect(mark.path).not.toBe('');
                    expect(actual.left).toBeGreaterThanOrEqual(slotLeft);
                    expect(actual.right).toBeLessThanOrEqual(slotRight);
                    expect(actual.left).toBeGreaterThanOrEqual(plot.left);
                    expect(actual.right).toBeLessThanOrEqual(plot.right);
                    expect(actual.right - actual.left).toBeGreaterThan(0);
                }
            }
            expect(plot.x(0)).toBeCloseTo((slotLeft + slotRight) / 2);
        }
    }
});

test('complete calendar buckets retain prototype band padding and capped bar width', () => {
    const summary = structuredClone(snapshot.ranges['7d']), template = snapshot.ranges['7d'].days[0]!;
    summary.startDate = '2026-10-01'; summary.endDateExclusive = '2026-10-08'; summary.bucketDays = 1;
    summary.days = Array.from({ length: 7 }, (_, index) => ({ ...structuredClone(template), date: `2026-10-0${index + 1}` }));
    for (const width of [240, 600]) {
        const plot = usageDailyPlot(summary, 'toolErrors', width, [10, 10, 10, 10, 10, 10, 10], String, 10);
        const step = (plot.right - plot.left) / (7 - .08);
        summary.days.forEach((_, index) => {
            expect(plot.x(index)).toBeCloseTo(plot.left + (index + .46) * step);
            const path = usageDailyMarks(summary.days.map(() => [10]), plot).bars[index]!.path;
            const start = Number(path.match(/^M([^,]+),/)![1]);
            expect(plot.x(index) - start).toBeCloseTo(Math.min(24, step * .76) / 2);
        });
    }
});

test('rounded donut arcs have true annular bounds and remain finite for tiny, empty and single slices', () => {
    const arcs = usageDailyDonut([60, 30, 10]);
    expect(arcs).toHaveLength(3);
    for (const path of arcs) { expect(path).toContain('A56,56'); expect(path).toContain('A43,43'); expect(path).toContain('A3,3'); expect(path).not.toMatch(/NaN|Infinity/); }
    expect(usageDailyDonut([0, 0])).toEqual(['', '']);
    expect(usageDailyDonut([100])[0]).toContain('58,114');
    for (const path of usageDailyDonut([1e9, 1, 1e-6])) expect(path).not.toMatch(/NaN|Infinity/);
});

test('donut sectors match prototype D3 geometry including independent small-slice corners and collapsed edges', () => {
    // Captured from the prototype's D3 7.9 pie/arc configuration, without its centre translation.
    const fixtures = [
        { values: [60, 30, 10], index: 0, path: 'M0.883,-52.858A3,3,0,0,1,4.102,-55.85A56,56,0,1,1,-28.551,48.175A3,3,0,0,1,-29.483,43.88L-25.47,38.118A3,3,0,0,1,-21.508,37.234A43,43,0,1,0,3.629,-42.847A3,3,0,0,1,0.883,-45.836Z' },
        { values: [99, 1], index: 1, path: 'M-3.87,-54.321A1.497,1.497,0,1,1,-0.883,-54.451L-0.883,-43.998A1.04,1.04,0,0,1,-2.958,-43.907Z' },
        { values: [500, 1], index: 1, path: 'M-1.209,-55.821A0.164,0.164,0,1,1,-0.882,-55.827L-0.805,-42.992Z' },
        { values: [1000, 1], index: 1, path: 'M-0.874,-55.993L-0.671,-42.995Z' },
        { values: [1000000, 1], index: 1, path: 'M-0.7,-55.996L-0.538,-42.997Z' },
    ];
    const tokens = (path: string, translate: boolean) => {
        let command = '', index = 0;
        return path.match(/[MLAZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/ig)!.map(token => {
            if (/^[MLAZ]$/i.test(token)) { command = token; index = 0; return token; }
            const at = index++;
            return Number(token) - (translate && (command === 'M' || command === 'L' || command === 'A' && at >= 5) ? 58 : 0);
        });
    };
    for (const fixture of fixtures) {
        const actual = tokens(usageDailyDonut(fixture.values)[fixture.index]!, true), expected = tokens(fixture.path, false);
        expect(actual).toHaveLength(expected.length);
        expected.forEach((token, index) => {
            if (typeof token === 'number') expect(Math.abs(Number(actual[index]) - token)).toBeLessThan(.00051);
            else expect(actual[index]).toBe(token);
        });
    }
});

test('token composition keeps physical two-pixel gaps without dropping tiny nonzero shares', () => {
    for (const width of [260, 420, 800]) {
        const parts = usageDailyComposition([1000, 0, 100, .01], width);
        expect(parts[1]!.width).toBe(0);
        expect(parts[2]!.x - parts[0]!.x - parts[0]!.width).toBeCloseTo(2);
        expect(parts[3]!.x - parts[2]!.x - parts[2]!.width).toBeCloseTo(2);
        expect(parts[3]!.width).toBeGreaterThan(0);
        expect(parts[3]!.x + parts[3]!.width).toBeCloseTo(width);
    }
});

test('tooltips flip beside the observation and bound vertical placement', () => {
    const rows = [{ label: 'Claude Opus', value: '23.5M' }, { label: 'Total', value: '1.2B' }];
    const tip = usageDailyTooltip(600, 280, 640, 300, 'Sep 13', rows);
    expect(tip.x).toBeLessThan(600);
    expect(tip.x + tip.width).toBeLessThanOrEqual(640);
    expect(tip.y + tip.height).toBeLessThanOrEqual(300);
    expect(usageDailyTooltip(0, 0, 640, 300, 'Sep 13', rows).y).toBe(0);
});

test('summary sparks retain prototype dimensions and beneficial tones apply to rates only', () => {
    const spark = usageMetricSpark([10, null, 20])!;
    expect(spark.last.x).toBe(58);
    expect(spark.wash).toEndWith('L58,28L2,28Z');
    expect(usageMetricSpark([null, 10])).toBeNull();
    const up = usageDailyMetricDelta(53, 50, 'points');
    expect(usageDailyDeltaTone('cache', up)).toBe(' usage-change-good');
    expect(usageDailyDeltaTone('errorRate', up)).toBe(' usage-change-bad');
    expect(usageDailyDeltaTone('requests', up)).toBe('');
});

test('delta tone thresholds use raw magnitudes rather than percent or grouped display text', () => {
    const small = usageDailyMetricDelta(203, 200)!;
    expect(small.description).toContain('1.5%');
    expect(usageDailyDeltaTone('toolErrors', small)).toBe('');
    expect(usageDailyDeltaTone('toolErrors', usageDailyMetricDelta(197, 200))).toBe('');
    expect(usageDailyDeltaTone('toolErrors', usageDailyMetricDelta(10199, 10000))).toBe('');
    expect(usageDailyDeltaTone('toolErrors', usageDailyMetricDelta(204, 200))).toBe(' usage-change-bad');
    expect(usageDailyDeltaTone('toolErrors', usageDailyMetricDelta(196, 200))).toBe(' usage-change-good');
    const large = usageDailyMetricDelta(11, 1)!;
    expect(large.description).toContain('1,000%');
    expect(large.magnitude).toBe(1000);
    expect(usageDailyDeltaTone('toolErrors', large)).toBe(' usage-change-bad');
    expect(usageDailyDeltaTone('cache', usageDailyMetricDelta(.199, 0, 'points'))).toBe('');
    expect(usageDailyDeltaTone('cache', usageDailyMetricDelta(.2, 0, 'points'))).toBe(' usage-change-good');
    expect(usageDailyDeltaTone('errorRate', usageDailyMetricDelta(.2, 0, 'points'))).toBe(' usage-change-bad');
    expect(usageDailyDeltaTone('toolErrors', null)).toBe('');
});

test('active tool identity exists only for one visible named tool in the tool-error metric', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    summary.tools = [
        { id: 'bash', kind: 'named', label: 'Bash', requests: 2, results: 2, errors: 1 },
        { id: 'other', kind: 'other', label: 'Other', requests: 2, results: 2, errors: 1 },
    ];
    expect(usageSelectedToolId(summary, 'toolErrors', [])).toBeUndefined();
    expect(usageSelectedToolId(summary, 'toolErrors', ['other'])).toBe('bash');
    expect(usageSelectedToolId(summary, 'toolErrors', ['bash'])).toBeUndefined();
    expect(usageSelectedToolId(summary, 'tokens', ['other'])).toBeUndefined();
});
