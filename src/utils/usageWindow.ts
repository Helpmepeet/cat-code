import type { UsageHour } from '../../app/shared/usageDashboard.js';

const dateFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dateTimeFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
});

export function localDateKey(timestamp: number, timeZone: string): string {
    const parts = Object.fromEntries(dateFormatter(timeZone).formatToParts(timestamp).map(part => [part.type, part.value]));
    const year = Number(parts.year) + (parts.era === 'BC' ? -1 : 0);
    return `${String(year).padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function dateParts(date: string): { year: number; month: number; day: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error('Invalid local date');
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
function utcMillis(year: number, month: number, day: number): number {
    const value = new Date(0);
    value.setUTCHours(0, 0, 0, 0);
    value.setUTCFullYear(year, month - 1, day);
    return value.getTime();
}

export function addCalendarDays(date: string, days: number): string {
    const p = dateParts(date);
    const value = new Date(utcMillis(p.year, p.month, p.day + days));
    return value.toISOString().slice(0, 10);
}

export function calendarDayDistance(start: string, end: string): number {
    const a = dateParts(start), b = dateParts(end);
    return (utcMillis(b.year, b.month, b.day) - utcMillis(a.year, a.month, a.day)) / 86400000;
}

/** Resolve local midnight to its UTC instant without assuming a fixed offset. */
export function localMidnight(date: string, timeZone: string): number {
    const target = dateParts(date);
    const desired = utcMillis(target.year, target.month, target.day);
    let guess = desired;
    for (let i = 0; i < 6; i++) {
        const parts = Object.fromEntries(dateTimeFormatter(timeZone).formatToParts(guess).map(part => [part.type, part.value]));
        const representedDate = new Date(0);
        representedDate.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
        representedDate.setUTCFullYear(Number(parts.year) + (parts.era === 'BC' ? -1 : 0), Number(parts.month) - 1, Number(parts.day));
        const represented = representedDate.getTime();
        const next = guess + desired - represented;
        if (next === guess) break;
        guess = next;
    }
    const parts = Object.fromEntries(dateTimeFormatter(timeZone).formatToParts(guess).map(part => [part.type, part.value]));
    if (localDateKey(guess, timeZone) !== date || parts.hour !== '00' || parts.minute !== '00') {
        // A few historical zones moved clocks at midnight. Use the first real
        // instant in the date when a 00:00 wall time did not occur.
        let low = desired - 36 * 3600000, high = desired + 36 * 3600000;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (localDateKey(middle, timeZone) < date) low = middle + 1;
            else high = middle;
        }
        if (localDateKey(low, timeZone) === date) return low;
        throw new Error(`Local midnight does not exist: ${date} ${timeZone}`);
    }
    return guess;
}

export function localHourParts(timestamp: number, timeZone: string): { hour: number; offsetMinutes: number } {
    const parts = Object.fromEntries(dateTimeFormatter(timeZone).formatToParts(timestamp).map(part => [part.type, part.value]));
    const offset = /^GMT([+-])(\d{2}):(\d{2})$/.exec(parts.timeZoneName ?? 'GMT+00:00');
    const magnitude = offset ? Number(offset[2]) * 60 + Number(offset[3]) : 0;
    return { hour: Number(parts.hour), offsetMinutes: offset?.[1] === '-' ? -magnitude : magnitude };
}

/** Shift a cutoff by calendar days while keeping its local wall-clock time. */
export function shiftLocalCalendarDays(timestamp: number, days: number, timeZone: string): number {
    const base = timestamp + days * 86400000;
    const currentOffset = localHourParts(timestamp, timeZone).offsetMinutes;
    let guess = base, previous = Number.NaN;
    for (let attempt = 0; attempt < 6; attempt++) {
        const targetOffset = localHourParts(guess, timeZone).offsetMinutes;
        const next = base + (currentOffset - targetOffset) * 60000;
        if (next === guess) return next;
        // A target wall time in a spring-forward gap has no exact instant.
        // Choose the first real time after the gap instead of oscillating.
        if (next === previous) return Math.max(guess, next);
        previous = guess;
        guess = next;
    }
    return guess;
}

export function localDayHours(date: string, timeZone: string, withTokens: boolean): UsageHour[] {
    const start = localMidnight(date, timeZone);
    const end = localMidnight(addCalendarDays(date, 1), timeZone);
    const hours: UsageHour[] = [];
    for (let instant = start; instant < end; instant += 3600000) {
        const part = localHourParts(instant, timeZone);
        hours.push({ ...part, startAt: new Date(instant).toISOString(), requests: 0, ...(withTokens ? { tokens: 0 } : {}) });
    }
    return hours;
}

/** Recent windows are local calendar days with UTC-instant boundaries. */
export function usageWindow(days: 7 | 30, asOf: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): {
    startDate: string;
    endDateExclusive: string;
    startInclusive: string;
    endExclusive: string;
    dates: string[];
} {
    const now = new Date(asOf);
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid usage cutoff');
    const endDateExclusive = addCalendarDays(localDateKey(now.getTime(), timeZone), 1);
    const startDate = addCalendarDays(endDateExclusive, -days);
    return {
        startDate,
        endDateExclusive,
        startInclusive: new Date(localMidnight(startDate, timeZone)).toISOString(),
        endExclusive: new Date(localMidnight(endDateExclusive, timeZone)).toISOString(),
        dates: Array.from({ length: days }, (_, index) => addCalendarDays(startDate, index)),
    };
}

export function usageTimestampEligible(timestamp: number, start: number, end: number, cutoff: number): boolean {
    return Number.isFinite(timestamp) && timestamp >= start && timestamp < end && timestamp <= cutoff;
}
