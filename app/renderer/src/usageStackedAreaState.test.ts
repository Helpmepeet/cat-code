import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageFlowSamples, usageStackedAreaGeometry } from './usageStackedAreaState.js';

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
        geometry.curves[layer]!.forEach((curve, index) => {
            expect(curve.control1.y).toBeLessThanOrEqual(geometry.curves[layer - 1]![index]!.control1.y);
            expect(curve.control2.y).toBeLessThanOrEqual(geometry.curves[layer - 1]![index]!.control2.y);
        });
    }
    expect(geometry.paths.every(path => path.includes(' C') && !/NaN|Infinity/.test(path))).toBe(true);
    expect(geometry.centerPaths).toHaveLength(3);
});

test('live stacked-area curves preserve endpoint tangents, exact construction, and repeated x coordinates', () => {
    const geometry = usageStackedAreaGeometry([
        { x: 0, values: [0] },
        { x: 10, values: [10] },
        { x: 20, values: [0] },
    ], 10, 0, 10);
    expect(geometry.curves[1]).toEqual([
        {
            from: { x: 0, y: 10 },
            control1: { x: 2, y: 8 },
            control2: { x: 6, y: 0 },
            to: { x: 10, y: 0 },
        },
        {
            from: { x: 10, y: 0 },
            control1: { x: 14, y: 0 },
            control2: { x: 18, y: 8 },
            to: { x: 20, y: 10 },
        },
    ]);
    expect(geometry.paths[0]).toBe('M0,10 C2,8 6,0 10,0 C14,0 18,8 20,10 L20,10 C18,10 14,10 10,10 C6,10 2,10 0,10 Z');

    const repeatedX = usageStackedAreaGeometry([
        { x: 0, values: [5] },
        { x: 0, values: [6] },
        { x: 10, values: [5] },
    ], 10, 0, 100);
    expect(repeatedX.paths.join(' ')).not.toMatch(/NaN|Infinity/);
});

test('center indicators stop across intervals where a series is absent', () => {
    const geometry = usageStackedAreaGeometry([
        { x: 0, values: [0] },
        { x: 10, values: [5] },
        { x: 20, values: [0] },
        { x: 30, values: [0] },
        { x: 40, values: [5] },
        { x: 50, values: [0] },
    ], 10, 0, 100);
    expect(geometry.centerPaths[0]).toHaveLength(2);
    expect(geometry.centerPaths[0]![0]).toStartWith('M0,100');
    expect(geometry.centerPaths[0]![0]).not.toContain('40,75');
    expect(geometry.centerPaths[0]![1]).toStartWith('M30,100');
});

test('sparse ranges add only gap boundaries and retain calendar bucket positions', () => {
    const summary = structuredClone(snapshot.ranges.all);
    const template = structuredClone(snapshot.ranges['7d'].days[0]!);
    summary.startDate = '2026-09-01';
    summary.endDateExclusive = '2026-09-14';
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
