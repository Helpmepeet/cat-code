import { addCalendarDays, localMidnight } from '../../../src/utils/usageWindow.js';

export function usageTenMinuteSlotCount(date: string, timezone: string): number {
    return Math.ceil((localMidnight(addCalendarDays(date, 1), timezone) - localMidnight(date, timezone)) / 600000);
}

export function usageTenMinuteClock(date: string, timezone: string, slot: number): string {
    if (slot === usageTenMinuteSlotCount(date, timezone)) return '24:00';
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(new Date(localMidnight(date, timezone) + slot * 600000));
}
