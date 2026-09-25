import { expect, test } from 'bun:test';
import { localDayHours, shiftLocalCalendarDays, usageTimestampEligible, usageWindow } from './usageWindow.js';
import { usageHourLabel } from '../../app/renderer/src/usageGraphState.js';
test('local calendar windows preserve date count and instant bounds across zones', () => {
    for (const tz of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kathmandu', 'Pacific/Auckland']) {
        for (const asOf of ['2025-11-03T00:30:00.000Z', '2025-03-10T00:30:00.000Z', '2026-01-01T00:30:00.000Z', '2024-03-01T00:30:00.000Z']) {
            for (const days of [7, 30] as const) {
                const script = `import { usageWindow } from './src/utils/usageWindow.ts'; console.log(JSON.stringify(usageWindow(${days}, '${asOf}')))`;
                const child = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, TZ: tz }, stdout: 'pipe', stderr: 'pipe' });
                expect(child.exitCode).toBe(0);
                const window = usageWindow(days, asOf, tz);
                expect(JSON.parse(child.stdout.toString())).toEqual(window);
                expect(window.dates).toHaveLength(days);
                expect(window.endDateExclusive).toBe(new Date(Date.parse(window.dates.at(-1)! + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10));
                const start = Date.parse(window.startInclusive), end = Date.parse(window.endExclusive), cutoff = Date.parse(asOf);
                expect(end - start).toBeGreaterThanOrEqual((days - 1) * 86400000);
                expect(end - start).toBeLessThanOrEqual((days + 1) * 86400000);
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
test('local hour slots preserve skipped and repeated DST hours', () => {
    expect(localDayHours('2025-03-09', 'America/New_York', true)).toHaveLength(23);
    const fallBack = localDayHours('2025-11-02', 'America/New_York', true);
    expect(fallBack).toHaveLength(25);
    const repeated = fallBack.filter(hour => hour.hour === 1);
    expect(repeated).toHaveLength(2);
    expect(repeated[0]!.offsetMinutes).not.toBe(repeated[1]!.offsetMinutes);
    expect(localDayHours('2025-11-02', 'America/New_York', false).every(hour => hour.tokens === undefined)).toBe(true);
});
test('half-hour DST slots keep the displayed local minute', () => {
    const hours = localDayHours('2026-10-04', 'Australia/Lord_Howe', true);
    expect(hours).toHaveLength(24);
    expect(hours.find(hour => hour.hour === 2)).toMatchObject({ offsetMinutes: 660 });
    expect(usageHourLabel(hours.find(hour => hour.hour === 2)!)).toBe('02:30');
});
test('shifted comparison cutoffs preserve local wall time across DST', () => {
    const zone = 'America/New_York';
    expect(new Date(shiftLocalCalendarDays(Date.parse('2026-03-10T16:30:00.000Z'), -7, zone)).toISOString()).toBe('2026-03-03T17:30:00.000Z');
    expect(new Date(shiftLocalCalendarDays(Date.parse('2025-11-04T17:30:00.000Z'), -7, zone)).toISOString()).toBe('2025-10-28T16:30:00.000Z');
    // The missing 02:30 at spring-forward resolves to the first real 03:30.
    expect(new Date(shiftLocalCalendarDays(Date.parse('2025-03-16T06:30:00.000Z'), -7, zone)).toISOString()).toBe('2025-03-09T07:30:00.000Z');
});
