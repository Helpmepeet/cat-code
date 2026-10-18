import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { analyticsActivityAvailable, analyticsBucketAxis, analyticsBuilds, analyticsModelFamily, analyticsRouteLabels, analyticsRouteTiles, detailCalendarLine, detailLine, detailRate, usageAnalyticsToolColor, analyticsModelLatency, analyticsDuration } from './usageAnalyticsDetailsState.js';
import { analyticsAreaPath, analyticsBuildGeometry, analyticsCacheRows, analyticsCalendar, analyticsCalendarValues, analyticsCompositionSegments, analyticsConcurrencyLevel, analyticsDateTicks, analyticsMonotonePath, analyticsNearestPoint, analyticsPointCalendar, analyticsRateDomain, analyticsRequestFill, analyticsSparkGeometry, analyticsTicks } from './usageAnalyticsChartState.js';
import { analyticsAxisLabels, analyticsBuildAxisLabels, analyticsTextWidth, analyticsUncachedGroups } from './usageAnalyticsChartState.js';

test('cache rate uses all reported input and zero input is unavailable', () => {
    expect(detailRate({ fresh: 20, read: 60, write: 20, output: 500 })).toBe(60);
    expect(detailRate({ fresh: 0, read: 0, write: 0, output: 5 })).toBeNull();
    expect(analyticsRouteLabels.allowlist).toBe('Allowed tools');
});
test('model families use word boundaries rather than incidental substrings', () => {
    expect(analyticsModelFamily('GPT-6.1 Sol')).toBe('sol');
    expect(analyticsModelFamily('claude-opus-4-6')).toBe('opus');
    expect(analyticsModelFamily('gpt-5.5')).toBe('gpt-5.5');
    expect(analyticsModelFamily('solution')).toBe('other');
});
test('shared tool colors follow transcript classification with analytics exceptions', () => {
    const groups: [string[], string][] = [
        [['Bash', 'PowerShell', 'bash_code_execution'], 'light-dark(#0f766e,#2dd4bf)'],
        [['WebFetch', 'GenerateImage'], 'light-dark(#a21caf,#e879f9)'],
        [['Read'], 'light-dark(#2563eb,#60a5fa)'],
        [['Grep', 'Glob', 'tool_search_tool_regex', 'tool_search_tool_bm25'], 'light-dark(#a35f00,#fbbf24)'],
        [['Skill', 'ToolSearch'], 'light-dark(#0f766e,#5eead4)'],
        [['Write'], 'light-dark(#c2410c,#fb923c)'],
        [['NotebookEdit'], 'light-dark(#c2410c,#f97316)'],
        [['LSP'], 'light-dark(#dc2626,#f87171)'],
        [['SendMessage'], 'light-dark(#6d28d9,#a78bfa)'],
        [['WebSearch', 'web_search', 'web_fetch'], 'light-dark(#0e7490,#22d3ee)'],
        [['mcp__example__call'], 'light-dark(#7c3aed,#c084fc)'],
        [['Edit', 'apply_patch', 'Apply_patch', 'text_editor_code_execution', 'Agent', 'Task', 'ResumeAgent'], 'var(--accent)'],
        [['code_execution', 'future_tool'], 'var(--color-text-muted)'],
    ];
    for (const [labels, color] of groups) for (const label of labels) expect(usageAnalyticsToolColor(label)).toBe(color);
});
test('line gaps do not connect unavailable rates', () => {
    expect(detailLine([10, null, 30], 100, 30, 30)).toBe('M0.00,20.00  M100.00,0.00');
});
test('latency geometry preserves samples, log spacing, zeros and null quantiles', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const models = snapshot.ranges['7d'].timing.models;
    models.state = 'available';
    models.responseDuration = { samples: 3, p50Ms: 0, p95Ms: 1000 };
    models.firstText = { samples: 1, p50Ms: null, p95Ms: 10 };
    const data = analyticsModelLatency(models);
    expect(data.rows.map(row => row.samples)).toEqual([3, 1]);
    expect(data.rows[1]!.p50Ms).toBeNull();
    expect(data.x(0)).toBe(data.zeroX);
    expect(data.zeroX).toBeLessThan(data.positiveLeft);
    expect(data.x(1000) - data.x(100)).toBeCloseTo(data.x(100) - data.x(10));
    expect(analyticsDuration(0)).toBe('0 ms');
    expect(analyticsDuration(null)).toBe('Unavailable');
    models.state = 'unavailable';
    expect(analyticsModelLatency(models).rows.every(row => row.p50Ms === null && row.p95Ms === null)).toBe(true);
});
test('build grouping preserves dirty identity and sums only displayed attribution', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.days[0]!.tools = [{ id: 'bash', requests: 9, results: 7, errors: 2, builds: { items: [{ sha: 'abc', dirty: false, requests: 3, results: 2, errors: 1, firstObservedAt: '2026-10-12T12:00:00Z' }, { sha: 'abc', dirty: true, requests: 4, results: 3, errors: 1, firstObservedAt: '2026-10-12T13:00:00Z' }], omitted: { count: 1, requests: 2, results: 2, errors: 0 } } }];
    const builds = analyticsBuilds(summary);
    expect(builds.items).toHaveLength(2);
    expect(builds.attributed).toBe(5);
    expect(builds.omitted).toBe(1);
});
test('route tiles preserve total area and unknown outcomes are not treated as allowed', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.autoMode.routes = [{ route: 'base', outcome: 'allowed', count: 6 }, { route: 'guard', outcome: 'unknown_outcome', count: 2 }, { route: 'guard', outcome: 'policy_blocked', count: 2 }];
    const tiles = analyticsRouteTiles(summary);
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBeCloseTo(600 * 240);
    expect(tiles.find(tile => tile.route === 'guard')?.notAllowed).toBe(4);
});
test('bucket axis includes the final partial bucket without projecting beyond the chart', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges.all;
    summary.startDate = '2026-10-01';
    summary.endDateExclusive = '2026-10-10';
    summary.bucketDays = 4;
    expect(analyticsBucketAxis(summary)).toEqual({ first: Date.parse('2026-10-01T00:00:00Z'), last: Date.parse('2026-10-09T00:00:00Z'), count: 3 });
});
test('sparse rate lines do not bridge missing buckets, and missing concurrency slots stay unavailable', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['30d'];
    summary.days = [summary.days[0]!, summary.days[3]!];
    const path = detailCalendarLine(summary, [10, 30], 100, 30, 30);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).not.toContain('L');
    summary.days[0]!.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    summary.days[1]!.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0 };
    expect(analyticsActivityAvailable(summary, 'sessions')).toBe(false);
    summary.days[1]!.parallel.tenMinutePeaks = [];
    expect(analyticsActivityAvailable(summary, 'sessions')).toBe(true);
    expect(analyticsActivityAvailable(summary, 'requests')).toBe(false);
});

test('focused rate domains preserve zero, null and the weighted range reference', () => {
    expect(analyticsRateDomain([92, 97, null])).toEqual([84, 100]);
    expect(analyticsRateDomain([92, 97], 81)).toEqual([74, 100]);
    expect(analyticsRateDomain([92, 97], 90, true)).toEqual([89, 100]);
    expect(analyticsRateDomain([0, null, 100])).toEqual([0, 100]);
    expect(analyticsRateDomain([null, null])).toEqual([74, 100]);
    expect(analyticsTicks(85, 100, 5)).toEqual([86, 88, 90, 92, 94, 96, 98, 100]);
});

test('calendar bands fill the range without shifting weekends or collapsing sparse gaps', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    const calendar = analyticsCalendar(summary, 40, 740);
    expect(calendar.bandWidth(summary.days[0]!.date)).toBe(100);
    expect(calendar.start(summary.days[0]!.date)).toBe(40);
    expect(calendar.center(summary.days[0]!.date)).toBe(90);
    expect(calendar.start(summary.days[6]!.date) + calendar.bandWidth(summary.days[6]!.date)).toBe(740);
    const points = analyticsPointCalendar(summary, 40, 700);
    expect(points.center(summary.days[0]!.date)).toBeCloseTo(70);
    expect(points.center(summary.days[6]!.date)).toBeCloseTo(670);
    expect(points.start(summary.days[0]!.date)).toBe(40);
    expect(points.start(summary.days[0]!.date) + points.bandWidth(summary.days[0]!.date)).toBeCloseTo(points.start(summary.days[1]!.date));
    summary.days = [summary.days[0]!, summary.days[3]!];
    expect(analyticsCalendarValues(summary, () => 12)).toEqual([12, null, null, 12, null, null, null]);
    expect(analyticsDateTicks(summary, 600)).toHaveLength(7);
    expect(analyticsDateTicks(summary, 200).length).toBeLessThan(7);
});

test('sparks use a padded local extent, a terminal point and disconnected missing buckets', () => {
    const geometry = analyticsSparkGeometry([90, 100, null, 95, 105], 110, 28);
    expect(geometry.line.match(/M/g)).toHaveLength(2);
    expect(geometry.area.match(/Z/g)).toHaveLength(2);
    expect(geometry.last?.x).toBe(105);
    expect(geometry.last?.y).toBeCloseTo(4.833333333333332);
    const low = Number(geometry.line.match(/^M2,([\d.]+)/)?.[1]);
    expect(low).toBeGreaterThan(20);
    expect(geometry.line).toContain('L27.75,');
    expect(analyticsSparkGeometry([1], 110, 28).line).toBe('');
    expect(analyticsSparkGeometry([null, null], 110, 28).last).toBeUndefined();
});

test('hourly profiles use monotone cubic geometry rather than bars or straight segments', () => {
    const path = analyticsMonotonePath([{ x: 0, y: 40 }, { x: 30, y: 0 }, { x: 60, y: 40 }]);
    expect(path).toBe('M0,40 C10,20 20,0 30,0 C40,0 50,20 60,40');
    expect(analyticsAreaPath([{ x: 0, y: 3 }, null, { x: 3, y: 0 }], 10)).toBe('M0,3 L0,10 L0,10 Z M3,0 L3,10 L3,10 Z');
    expect([0, 1, 2, 3, 4, 5, 12].map(analyticsConcurrencyLevel)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    expect(analyticsRequestFill(25, 100)).toContain('59%');
    expect(analyticsRequestFill(26, 100)).not.toBe(analyticsRequestFill(25, 100));
    expect(analyticsRequestFill(0, 100)).toContain('5%');
});

test('composition strips preserve ratios with two-pixel seams and no zero-width seams', () => {
    const segments = analyticsCompositionSegments([6, 2, 0, 2]);
    expect(segments[0]!.width / segments[1]!.width).toBeCloseTo(3);
    expect(segments[1]!.x - segments[0]!.width).toBe(2);
    expect(segments[2]!.width).toBe(0);
    expect(segments[3]!.x + segments[3]!.width).toBeCloseTo(600);
    expect(analyticsCompositionSegments([0, 0]).every(s => s.width === 0)).toBe(true);
});

test('tool duration is independent of unavailable model timing and keeps its own samples and zero rail', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const timing = snapshot.ranges['7d'].timing;
    timing.models.state = 'unavailable';
    timing.models.responseDuration = { samples: 99, p50Ms: 10, p95Ms: 100 };
    timing.tools.state = 'available';
    timing.tools.duration = { samples: 4, p50Ms: 0, p95Ms: 250 };
    const geometry = analyticsModelLatency(timing.models, timing.tools, 450);
    expect(geometry.rows.map(row => row.samples)).toEqual([0, 0, 4]);
    expect(geometry.rows[0]!.p50Ms).toBeNull();
    expect(geometry.rows[2]!.p50Ms).toBe(0);
    expect(geometry.x(0)).toBe(geometry.zeroX);
    expect(geometry.x(250)).toBeLessThan(434);
    timing.tools.state = 'unavailable';
    expect(analyticsModelLatency(timing.models, timing.tools).rows[2]!.p95Ms).toBeNull();
});

test('cache dot geometry focuses the domain, reserves values, and measures label columns', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.models = [
        { id: 'small', kind: 'named', label: 'Sol', tokens: { fresh: 5, read: 95, write: 0, output: 0 } },
        { id: 'large', kind: 'named', label: 'A much longer model label', tokens: { fresh: 50, read: 950, write: 0, output: 0 } },
    ];
    summary.cachedInputShare = 95;
    const geometry = analyticsCacheRows(summary, 340);
    expect(geometry.rows.map(row => row.id)).toEqual(['large', 'small']);
    expect(geometry.domain).toEqual([93, 100]);
    expect(geometry.left).toBeGreaterThan(100);
    expect(geometry.x(95)).toBeGreaterThan(geometry.left);
    expect(geometry.x(100)).toBe(geometry.right);
    expect(geometry.right).toBeLessThan(340 - 36);
});

test('build scatter sizes and orders dots by volume, pads singleton dates and excludes subthreshold rates', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.days[0]!.tools = [{ id: 'bash', requests: 0, results: 0, errors: 0, builds: { items: [
        { sha: 'small', dirty: false, requests: 199, results: 199, errors: 199, firstObservedAt: '2026-10-12T12:00:00Z' },
        { sha: 'hot', dirty: true, requests: 200, results: 200, errors: 20, firstObservedAt: '2026-10-12T12:00:00Z' },
        { sha: 'large', dirty: false, requests: 800, results: 800, errors: 0, firstObservedAt: '2026-10-12T12:00:00Z' },
    ] } }];
    const geometry = analyticsBuildGeometry(summary, 600);
    expect(geometry.points.map(point => point.sha)).toEqual(['large', 'hot']);
    expect(geometry.points.map(point => point.r)).toEqual([15, 9]);
    expect(geometry.median).toBe(5);
    expect(geometry.points[1]!.hot).toBe(true);
    expect(geometry.points[0]!.x).toBeGreaterThan(geometry.left + 20);
    expect(geometry.points[0]!.x).toBeLessThan(geometry.right - 20);
    expect(new Set(geometry.tickTimes).size).toBe(geometry.tickTimes.length);
    expect(analyticsNearestPoint(geometry.points, geometry.points[1]!.x + 30, geometry.points[1]!.y + 10)?.sha).toBe('hot');
});

test('treemap reflows at measured width with rounded shared edges and the same total area', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.autoMode.routes = [
        { route: 'base', outcome: 'allowed', count: 60 },
        { route: 'guard', outcome: 'unknown_outcome', count: 20 },
        { route: 'stage1', outcome: 'review_required', count: 15 },
        { route: 'stage2', outcome: 'policy_blocked', count: 5 },
    ];
    const narrow = analyticsRouteTiles(summary, 320, 230), wide = analyticsRouteTiles(summary, 620, 230);
    expect(narrow.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(320 * 230);
    expect(wide.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(620 * 230);
    expect(narrow.map(tile => tile.height)).not.toEqual(wide.map(tile => tile.height));
    for (const tile of [...narrow, ...wide]) for (const n of [tile.x, tile.y, tile.width, tile.height]) expect(Number.isInteger(n)).toBe(true);
    expect(narrow.find(tile => tile.route === 'guard')?.notAllowed).toBe(20);
});

test('partial final calendar buckets clip widths and midpoints without equal-band distortion or gap padding', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges.all;
    summary.startDate = '2026-10-01'; summary.endDateExclusive = '2026-10-10'; summary.bucketDays = 4;
    summary.days = [1, 5, 9].map((date, i) => ({ ...snapshot.ranges['7d'].days[i]!, date: `2026-10-${String(date).padStart(2, '0')}`, tokens: { fresh: 20, write: 10, read: 0, output: 0 } }));
    const calendar = analyticsCalendar(summary, 40, 940);
    expect(calendar.count).toBe(2.25);
    expect(summary.days.map(day => calendar.bandWidth(day.date))).toEqual([400, 400, 100]);
    expect(summary.days.map(day => calendar.center(day.date))).toEqual([240, 640, 890]);
    const points = analyticsPointCalendar(summary, 40, 940);
    expect((points.center('2026-10-05') - points.center('2026-10-01')) / (points.center('2026-10-09') - points.center('2026-10-01'))).toBeCloseTo(8 / 13);
    summary.days.splice(1, 1);
    const groups = analyticsUncachedGroups(summary, 40, 940);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map(point => point.x)).toEqual([40, 240, 440]);
    expect(groups[1]!.map(point => point.x)).toEqual([840, 890, 940]);
    expect(groups.flat().every(point => point.x <= 440 || point.x >= 840)).toBe(true);
    summary.days = [summary.days[1]!];
    expect(analyticsUncachedGroups(summary, 40, 940)[0]![0]!.x).toBe(840);
});

test('latency ticks reserve measured label extents at paired-card widths without changing log distances or zero identity', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const timing = snapshot.ranges['7d'].timing;
    timing.models.state = 'available';
    timing.models.responseDuration = { samples: 10, p50Ms: 1, p95Ms: 3600000 };
    timing.models.firstText = { samples: 10, p50Ms: 0, p95Ms: 1 };
    const measure = (text: string) => text.length * 6.1;
    for (const width of [383, 403, 445, 590]) {
        const geometry = analyticsModelLatency(timing.models, timing.tools, width, measure);
        let right = geometry.zeroX + measure('0 ms') / 2;
        expect(geometry.ticks.length).toBeGreaterThan(1);
        for (const tick of geometry.ticks) {
            const half = measure(analyticsDuration(tick)) / 2;
            expect(geometry.x(tick) - half).toBeGreaterThanOrEqual(right + 8 - 1e-9);
            expect(geometry.x(tick) + half).toBeLessThanOrEqual(width);
            right = geometry.x(tick) + half;
        }
        expect(geometry.x(100) - geometry.x(10)).toBeCloseTo(geometry.x(10) - geometry.x(1));
        expect(geometry.x(0)).toBe(geometry.zeroX);
        expect(geometry.x(1)).toBeGreaterThan(geometry.zeroX);
    }
});

test('point picking shares exact neighboring mid-boundaries for partial buckets but never fills an omitted bucket', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges.all;
    summary.startDate = '2026-10-01'; summary.endDateExclusive = '2026-10-10'; summary.bucketDays = 4;
    const dates = ['2026-10-01', '2026-10-05', '2026-10-09'];
    summary.days = dates.map(date => ({ ...snapshot.ranges['7d'].days[0]!, date }));
    const plot = analyticsPointCalendar(summary, 40, 940);
    const bands = dates.map(date => ({ start: plot.start(date), end: plot.start(date) + plot.bandWidth(date) }));
    expect(bands[0]!.start).toBe(40);
    expect(bands[2]!.end).toBe(940);
    for (let i = 0; i < 2; i++) {
        const midpoint = (plot.center(dates[i]!) + plot.center(dates[i + 1]!)) / 2;
        expect(bands[i]!.end).toBeCloseTo(midpoint);
        expect(bands[i + 1]!.start).toBeCloseTo(midpoint);
        expect(bands[i]!.end).toBe(bands[i + 1]!.start);
    }
    summary.days.splice(1, 1);
    const sparse = analyticsPointCalendar(summary, 40, 940);
    expect(sparse.start(dates[0]!) + sparse.bandWidth(dates[0]!)).toBe(bands[0]!.end);
    expect(sparse.start(dates[2]!)).toBe(bands[2]!.start);
    expect(sparse.start(dates[2]!) - sparse.start(dates[0]!) - sparse.bandWidth(dates[0]!)).toBeCloseTo(bands[1]!.end - bands[1]!.start);
});

test('short-span build ticks distinguish minutes and thin to physical label bounds for one build', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.days[0]!.tools = [{ id: 'bash', requests: 208, results: 208, errors: 2, builds: { items: [{ sha: 'one', dirty: false, requests: 208, results: 208, errors: 2, firstObservedAt: '2026-10-12T12:00:00Z' }] } }];
    const start = Date.parse('2026-10-12T12:00:00Z');
    const minutes = analyticsBuildAxisLabels([start, start + 900000, start + 1800000], time => (time - start) / 1800000 * 1000 + 40, 40, 1040);
    expect(minutes.map(tick => tick.label)).toEqual(['Oct 12, 12:00 PM', 'Oct 12, 12:15 PM', 'Oct 12, 12:30 PM']);
    for (const width of [300, 340, 552, 640]) {
        const plot = analyticsBuildGeometry(summary, width);
        const labels = analyticsBuildAxisLabels(plot.tickTimes, plot.x, plot.left, plot.right);
        expect(labels.length).toBeGreaterThan(1);
        expect(new Set(labels.map(tick => tick.label)).size).toBe(labels.length);
        expect(labels.length).toBeLessThan(plot.tickTimes.length);
        let previous = plot.left - 12;
        for (const tick of labels) {
            expect(tick.label).toMatch(/\d{1,2}:\d{2}\s[AP]M/);
            const textWidth = analyticsTextWidth(tick.label);
            const left = tick.x - (tick.anchor === 'start' ? 0 : tick.anchor === 'middle' ? textWidth / 2 : textWidth);
            expect(left).toBeGreaterThanOrEqual(previous + 12 - 1e-9);
            expect(left + textWidth).toBeLessThanOrEqual(plot.right);
            previous = left + textWidth;
        }
    }
});

test('compact elapsed-hour ticks preserve their coordinates while removing physical collisions', () => {
    const ticks = Array.from({ length: 8 }, (_, i) => ({ x: 80 + i * 13, label: String(i * 3).padStart(2, '0'), anchor: 'start' as const }));
    const labels = analyticsAxisLabels(ticks, 80, 184);
    expect(labels.map(tick => tick.label)).toEqual(['00', '06', '12', '18']);
    expect(labels.map(tick => tick.x)).toEqual([80, 106, 132, 158]);
    expect(analyticsAxisLabels([{ x: 80, label: '00', anchor: 'start' }, { x: 120, label: '00', anchor: 'start' }], 80, 184)).toHaveLength(1);
});
