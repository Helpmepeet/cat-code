import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageFlowSamples, usageSmoothCurve, usageStackedAreaGeometry } from './usageStackedAreaState.js';

const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');

test('stacked boundaries preserve totals without negative thickness or invalid coordinates', () => {
    const geometry = usageStackedAreaGeometry([
        { x: 0, values: [2, 3, -4] },
        { x: 10, values: [6, 1, Number.NaN] },
        { x: 20, values: [0, 0, 0] },
    ], 10, 0, 100);

    expect(geometry.boundaries).toHaveLength(4);
    expect(geometry.boundaries[1]!.map(point => point.y)).toEqual([80, 40, 100]);
    expect(geometry.boundaries[2]!.map(point => point.y)).toEqual([50, 30, 100]);
    for (let layer = 1; layer < geometry.boundaries.length; layer++) {
        geometry.boundaries[layer]!.forEach((point, index) => {
            expect(point.y).toBeLessThanOrEqual(geometry.boundaries[layer - 1]![index]!.y);
        });
    }
    expect(geometry.paths.every(path => path.includes(' C') && !/NaN|Infinity/.test(path))).toBe(true);
});

test('bounded curves handle empty, single and duplicate points without false endpoint tapering', () => {
    expect(usageSmoothCurve([])).toBe('');
    expect(usageSmoothCurve([{ x: 4, y: 8 }])).toBe('M4,8');
    expect(usageSmoothCurve([{ x: 0, y: 50 }, { x: 0, y: 40 }, { x: 10, y: 50 }])).toBe('M0,50 L0,40 C3.6,40 6.4,50 10,50');
    const geometry = usageStackedAreaGeometry([
        { x: 0, values: [5] },
        { x: 5, values: [5] },
        { x: 10, values: [5] },
    ], 10, 0, 100);
    expect(geometry.paths[0]).toStartWith('M0,50');
    expect(geometry.boundaries[1]!.map(point => point.y)).toEqual([50, 50, 50]);
});

test('sparse ranges add only gap boundaries and retain calendar bucket positions', () => {
    const summary = structuredClone(snapshot.ranges.all);
    const template = structuredClone(snapshot.ranges['7d'].days[0]!);
    summary.startInclusive = '2026-09-01T00:00:00.000Z';
    summary.endExclusive = '2026-09-14T00:00:00.000Z';
    summary.bucketDays = 1;
    summary.days = [
        { ...structuredClone(template), date: '2026-09-01', tokens: { fresh: 10, read: 2, write: 0, output: 1 } },
        { ...structuredClone(template), date: '2026-09-10', tokens: { fresh: 20, read: 4, write: 0, output: 2 } },
    ];
    const samples = usageFlowSamples(summary, [
        { value: day => day.tokens.fresh },
        { value: day => day.tokens.output },
    ]);

    expect(samples).toEqual([
        { date: '2026-09-01', values: [10, 1] },
        { date: '2026-09-02', values: [0, 0] },
        { date: '2026-09-09', values: [0, 0] },
        { date: '2026-09-10', values: [20, 2] },
        { date: '2026-09-11', values: [0, 0] },
        { date: '2026-09-13', values: [0, 0] },
    ]);

    summary.bucketDays = 5;
    summary.days = [summary.days[0]!];
    expect(usageFlowSamples(summary, [{ value: day => day.tokens.fresh }])).toEqual([
        { date: '2026-09-01', values: [10] },
        { date: '2026-09-06', values: [0] },
        { date: '2026-09-11', values: [0] },
    ]);
});
