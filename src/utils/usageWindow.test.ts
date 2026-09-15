import { expect, test } from 'bun:test';
import { usageTimestampEligible, usageWindow } from './usageWindow.js';
test('T1/T2: UTC grid and event bounds across DST, year and leap transitions', () => {
    for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kathmandu', 'Pacific/Auckland']) {
        for (const asOf of ['2025-11-03T00:30:00.000Z', '2025-03-10T00:30:00.000Z', '2026-01-01T00:30:00.000Z', '2024-03-01T00:30:00.000Z']) {
            for (const days of [7, 30] as const) {
                const script = `import { usageWindow } from './src/utils/usageWindow.ts'; console.log(JSON.stringify(usageWindow(${days}, '${asOf}')))`;
                const child = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, TZ: tz }, stdout: 'pipe', stderr: 'pipe' });
                expect(child.exitCode).toBe(0);
                const window = usageWindow(days, asOf);
                expect(JSON.parse(child.stdout.toString())).toEqual(window);
                expect(window.dates).toHaveLength(days);
                const start = Date.parse(window.startInclusive), end = Date.parse(window.endExclusive), cutoff = Date.parse(asOf);
                expect(usageTimestampEligible(start - 1, start, end, cutoff)).toBe(false);
                expect(usageTimestampEligible(start, start, end, cutoff)).toBe(true);
                expect(usageTimestampEligible(cutoff, start, end, cutoff)).toBe(true);
                expect(usageTimestampEligible(cutoff + 1, start, end, cutoff)).toBe(false);
                expect(usageTimestampEligible(end, start, end, cutoff)).toBe(false);
                expect(usageTimestampEligible(NaN, start, end, cutoff)).toBe(false);
            }
        }
    }
});
