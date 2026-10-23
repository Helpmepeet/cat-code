import type { UsageRangeSummary, UsageTokens, UsageTimingSummary } from '../../shared/usageDashboard.js';
import { usageRangeBuilds } from '../../shared/usageBuilds.js';
import type { AutoModeUsageRoute } from '../../shared/usageAutoMode.js';
import { isFilePatchToolName } from '../../../src/tools/FilePatchTool/constants.js';
import { USAGE_TOOL_ERROR_CATEGORIES, USAGE_PATCH_MECHANISMS, USAGE_PATCH_FOLLOWUP_STATES, type UsageTool, type UsageBreakdownTool, type UsageToolErrorCategory, type UsagePatchMechanism, type UsagePatchFollowupState } from '../../shared/usageDashboard.js';

const toolErrorLabels: Record<UsageToolErrorCategory, string> = {
    ambiguity: 'Ambiguous context', 'text-not-found': 'Text not found', 'nonconsecutive-context': 'Nonconsecutive context',
    'order-conflict': 'Order conflict', 'planner-limit': 'Planning limit', 'malformed-patch': 'Malformed patch',
    'permission-denied': 'Permission denied', interrupted: 'Cancelled', other: 'Other',
};
/** A labelled count rendered as `label: value`, with the value emphasized. */
export type AnalyticsCount = { label: string; value: string };
const calls = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'call' : 'calls'}`;
export function analyticsToolErrorReasons(tool: UsageTool): AnalyticsCount[] {
    const categories = tool.errorCategories;
    if (!categories) return [];
    const present = USAGE_TOOL_ERROR_CATEGORIES.filter(category => categories[category]);
    // A lone Other restates the error count without explaining it.
    if (present.every(category => category === 'other')) return [];
    return present.map(category => ({ label: toolErrorLabels[category], value: categories[category]!.toLocaleString() }));
}
const patchMechanismLabels: Record<UsagePatchMechanism, string> = {
    'forward-match': 'Forward match', 'hunk-reorder': 'Hunks reordered', 'indentation-adjustment': 'Indentation adjusted',
};
export function analyticsPatchMechanisms(tool: UsageTool): AnalyticsCount[] {
    return USAGE_PATCH_MECHANISMS.filter(mechanism => tool.patchMechanisms?.[mechanism])
        .map(mechanism => ({ label: patchMechanismLabels[mechanism], value: calls(tool.patchMechanisms![mechanism]!) }));
}

const followupLabels: Record<UsagePatchFollowupState, string> = {
    'retry-result-success': 'Later patch reported success', 'retry-result-missing': 'Later patch result missing',
    'edit-switch': 'Later Edit call', 'write-switch': 'Later Write call', 'shell-switch-unknown': 'Later shell call, attribution unknown',
    unresolved: 'No later action observed', unknown: 'Overlapping activity, sequence unknown',
};
export function analyticsPatchFollowups(tool: UsageTool): AnalyticsCount[] {
    const followups = tool.patchFollowups;
    if (!followups) return [];
    return [
        { label: 'Failed-call sequences', value: followups.episodes.toLocaleString() },
        ...USAGE_PATCH_FOLLOWUP_STATES.filter(state => followups.states[state]).map(state => ({ label: followupLabels[state], value: followups.states[state]!.toLocaleString() })),
        { label: 'Later patch calls', value: followups.retryCalls.toLocaleString() },
        { label: 'Repeat errors', value: followups.repeatErrors.toLocaleString() },
    ];
}
/** Errors per entry of `summary.days`, or null when no reconciled history survived fitting. */
export function analyticsToolDayErrors(summary: UsageRangeSummary, tool: UsageBreakdownTool, detailed: boolean): readonly number[] | null {
    if (tool.dayErrors) return tool.dayErrors;
    if (tool.errors === 0) return summary.days.map(() => 0);
    return detailed ? summary.days.map(day => day.tools.find(item => item.id === tool.id)?.errors ?? 0) : null;
}
export function analyticsPatchCounts(tool: UsageTool): string {
    const missing = tool.requests - tool.results;
    return `${tool.requests.toLocaleString()} ${tool.requests === 1 ? 'call' : 'calls'} · ${tool.errors.toLocaleString()} ${tool.errors === 1 ? 'error' : 'errors'} / ${tool.results.toLocaleString()} ${tool.results === 1 ? 'result' : 'results'} · ${detailPercent(tool.results ? tool.errors / tool.results * 100 : null)}${missing > 0 ? ` · ${missing.toLocaleString()} ${missing === 1 ? 'result' : 'results'} missing` : ''}`;
}

export type UsageAnalyticsDetailProps = { summary: UsageRangeSummary };
export type UsageAnalyticsDateProps = UsageAnalyticsDetailProps & { selectedDate: string; onSelectDate: (date: string) => void };
export type UsageAnalyticsActivityProps = UsageAnalyticsDateProps & { timezone: string };
export type UsageAnalyticsModelsProps = UsageAnalyticsDetailProps & { modelFamilies: readonly string[]; onModelFamiliesChange: (families: string[]) => void };
export type UsageAnalyticsReliabilityProps = UsageAnalyticsDetailProps & { selectedToolId?: string; onSelectTool: (id: string) => void; onSelectRoute: (route: AutoModeUsageRoute) => void; onSelectBuild: (sha: string) => void };
export const detailTotal = (t: UsageTokens) => t.fresh + t.read + t.write + t.output;
export const detailInput = (t: UsageTokens) => t.fresh + t.read + t.write;
export const detailRate = (t: UsageTokens) => detailInput(t) ? t.read / detailInput(t) * 100 : null;
export const detailPercent = (n: number | null) => n === null ? 'Not available' : `${n.toFixed(1)}%`;
export const detailCompact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export function analyticsDuration(ms: number | null): string {
    if (ms === null) return 'Unavailable';
    if (ms < 1000) return `${Number(ms.toFixed(2))} ms`;
    if (ms < 60000) return `${Number((ms / 1000).toFixed(2))} s`;
    return `${Number((ms / 60000).toFixed(2))} min`;
}
export function analyticsModelLatency(models: UsageTimingSummary['models'], tools?: UsageTimingSummary['tools'], width = 590, measure = (text: string) => text.length * 6.1) {
    const rows = [
        { id: 'response', label: 'Model response', ...models.responseDuration },
        { id: 'first-text', label: 'First text', ...models.firstText },
    ].map(row => ({
        ...row,
        p50Ms: models.state === 'available' && row.samples > 0 ? row.p50Ms : null,
        p95Ms: models.state === 'available' && row.samples > 0 ? row.p95Ms : null,
        samples: models.state === 'available' ? row.samples : 0,
    }));
    if (tools) rows.push({
        id: 'tool', label: 'Tool run', ...tools.duration,
        p50Ms: tools.state === 'available' && tools.duration.samples > 0 ? tools.duration.p50Ms : null,
        p95Ms: tools.state === 'available' && tools.duration.samples > 0 ? tools.duration.p95Ms : null,
        samples: tools.state === 'available' ? tools.duration.samples : 0,
    });
    const positive = rows.flatMap(row => [row.p50Ms, row.p95Ms]).filter((n): n is number => n !== null && n > 0);
    const hasZero = rows.some(row => row.p50Ms === 0 || row.p95Ms === 0);
    const low = positive.length ? Math.min(hasZero ? 1 : Infinity, ...positive.map(n => n / 2)) : 1;
    const high = Math.max(low * 10, ...positive.map(n => n * 1.6));
    const labelWidth = Math.max(...rows.flatMap(row => [measure(row.label), measure(`${row.samples.toLocaleString()} samples`)]));
    const zeroX = labelWidth + 16 + measure('0 ms') / 2;
    const positiveLeft = zeroX + measure('0 ms') / 2 + 20;
    // Zero has a separate labelled rail; it is never replaced by a log-scale floor.
    const x = (ms: number) => ms === 0 ? zeroX : positiveLeft + (Math.log(ms) - Math.log(low)) / (Math.log(high) - Math.log(low)) * Math.max(1, width - positiveLeft - 16);
    const candidates = [0.01, 0.1, 1, 10, 100, 1000, 10000, 60000, 600000, 3600000].filter(n => n >= low && n <= high);
    if (!candidates.length) candidates.push(low, high);
    let previousRight = zeroX + measure('0 ms') / 2;
    const ticks = candidates.filter(tick => {
        const half = measure(analyticsDuration(tick)) / 2;
        if (x(tick) - half < previousRight + 8 || x(tick) + half > width) return false;
        previousRight = x(tick) + half;
        return true;
    });
    return { rows, x, ticks, zeroX, positiveLeft };
}
export function analyticsBucketAxis(summary: UsageRangeSummary) {
    const first = Date.parse(`${summary.startDate}T00:00:00Z`);
    const end = Date.parse(`${summary.endDateExclusive}T00:00:00Z`);
    const step = (summary.bucketDays ?? 1) * 86400000;
    const count = Math.max(1, Math.ceil((end - first) / step));
    return { first, last: first + (count - 1) * step, count };
}
export function analyticsActivityAvailable(summary: UsageRangeSummary, mode: 'requests' | 'sessions'): boolean {
    if (!summary.days.length || (summary.bucketDays ?? 1) > 1) return false;
    return mode === 'requests'
        ? summary.range === '7d' && summary.days.every(day => day.hours !== undefined)
        : summary.days.every(day => day.parallel.state === 'available' && day.parallel.tenMinutePeaks !== undefined);
}
export function analyticsModelFamily(label: string): string {
    const value = label.toLowerCase();
    for (const family of ['sol', 'luna', 'terra', 'astra']) if (new RegExp(`(^|[^a-z])${family}([^a-z]|$)`).test(value)) return family;
    if (value.includes('opus')) return 'opus';
    if (value.includes('sonnet')) return 'sonnet';
    if (/gpt[- ]?5[.-]5/.test(value)) return 'gpt-5.5';
    return 'other';
}
export const analyticsFamilyLabels: Record<string, string> = { sol: 'Sol', opus: 'Claude Opus', luna: 'Luna', terra: 'Terra', astra: 'Astra', 'gpt-5.5': 'GPT 5.5', sonnet: 'Claude Sonnet', other: 'Other' };
export function analyticsToolClass(label: string): string {
    if (label === 'WebFetch') return 'uad-tool-webfetch';
    // Match transcriptProjector's deriveToolFamily, including historical names.
    if (isFilePatchToolName(label)) return 'uad-tool-accent';
    switch (label) {
        case 'Bash': case 'PowerShell': case 'bash_code_execution': return 'uad-tool-bash';
        case 'Read': return 'uad-tool-read';
        case 'Write': return 'uad-tool-write';
        case 'Edit': case 'text_editor_code_execution': return 'uad-tool-accent';
        case 'Grep': case 'Glob': case 'tool_search_tool_regex': case 'tool_search_tool_bm25': return 'uad-tool-search';
        case 'WebSearch': case 'web_search': case 'web_fetch': return 'uad-tool-web';
        case 'NotebookEdit': return 'uad-tool-notebook';
        case 'LSP': return 'uad-tool-lsp';
        case 'Skill': case 'ToolSearch': return 'uad-tool-skill';
        case 'Agent': case 'Task': case 'ResumeAgent': return 'uad-tool-accent';
        case 'SendMessage': return 'uad-tool-agent-control';
        case 'GenerateImage': return 'uad-tool-webfetch';
        default: return label.startsWith('mcp__') ? 'uad-tool-mcp' : 'uad-tool-default';
    }
}
/** Matches TranscriptView's FAMILY_STYLE with the approved analytics exceptions. */
export function usageAnalyticsToolColor(label: string): string {
    const colors: Record<string, string> = {
        'uad-tool-bash': 'light-dark(#0f766e,#2dd4bf)',
        'uad-tool-webfetch': 'light-dark(#a21caf,#e879f9)',
        'uad-tool-read': 'light-dark(#2563eb,#60a5fa)',
        'uad-tool-write': 'light-dark(#c2410c,#fb923c)',
        'uad-tool-accent': 'var(--accent)',
        'uad-tool-search': 'light-dark(#a35f00,#fbbf24)',
        'uad-tool-web': 'light-dark(#0e7490,#22d3ee)',
        'uad-tool-mcp': 'light-dark(#7c3aed,#c084fc)',
        'uad-tool-notebook': 'light-dark(#c2410c,#f97316)',
        'uad-tool-lsp': 'light-dark(#dc2626,#f87171)',
        'uad-tool-skill': 'light-dark(#0f766e,#5eead4)',
        'uad-tool-agent-control': 'light-dark(#6d28d9,#a78bfa)',
        'uad-tool-default': 'var(--color-text-muted)',
    };
    return colors[analyticsToolClass(label)]!;
}
export function detailLine(values: readonly (number | null)[], width = 560, height = 120, ceiling?: number, positions?: readonly number[]): string {
    const max = ceiling ?? Math.max(1, ...values.filter((v): v is number => v !== null));
    let drawing = false;
    return values.map((v, i) => {
        if (v === null) { drawing = false; return ''; }
        const command = drawing ? 'L' : 'M'; drawing = true;
        return `${command}${(positions?.[i] ?? i * width / Math.max(1, values.length - 1)).toFixed(2)},${(height - v / max * height).toFixed(2)}`;
    }).join(' ');
}
export function detailCalendarLine(summary: UsageRangeSummary, values: readonly (number | null)[], width: number, height: number, ceiling?: number): string {
    const { first, last } = analyticsBucketAxis(summary);
    const step = (summary.bucketDays ?? 1) * 86400000;
    const points = summary.days.flatMap((day, i) => {
        const time = Date.parse(`${day.date}T00:00:00Z`);
        const previous = i ? Date.parse(`${summary.days[i - 1]!.date}T00:00:00Z`) : first;
        const x = (time - first) / Math.max(86400000, last - first) * width;
        return [...(time - previous > step ? [{ x, value: null }] : []), { x, value: values[i] ?? null }];
    });
    return detailLine(points.map(p => p.value), width, height, ceiling, points.map(p => p.x));
}
export function analyticsBuilds(summary: UsageRangeSummary) {
    const builds = usageRangeBuilds(summary);
    return { items: builds.items.map(build => ({ ...build, first: build.firstObservedAt })), omitted: builds.omitted?.count ?? 0, attributed: builds.items.reduce((sum, build) => sum + build.results, 0) };
}
/** Squarified rows retain relative area without turning small routes into slivers. */
export function analyticsRouteTiles(summary: UsageRangeSummary, width = 600, height = 240) {
    const counts = new Map<AutoModeUsageRoute, { count: number; notAllowed: number }>();
    for (const item of summary.autoMode.routes) {
        const row = counts.get(item.route) ?? { count: 0, notAllowed: 0 };
        row.count += item.count;
        if (item.outcome !== 'allowed') row.notAllowed += item.count;
        counts.set(item.route, row);
    }
    const items = [...counts].filter(([, row]) => row.count > 0).sort((a, b) => b[1].count - a[1].count);
    let x = 0, y = 0, w = width, h = height;
    let remaining = items.reduce((sum, [, row]) => sum + row.count, 0);
    const tiles: Array<{ route: AutoModeUsageRoute; count: number; notAllowed: number; x: number; y: number; width: number; height: number }> = [];
    let index = 0;
    while (index < items.length) {
        const unitArea = w * h / remaining;
        const edge = Math.min(w, h);
        const score = (sum: number, largest: number, smallest: number) => {
            const area = sum * unitArea;
            const side = edge * edge * ((1 + Math.sqrt(5)) / 2);
            return Math.max(side * largest * unitArea / (area * area), area * area / (side * smallest * unitArea));
        };
        let end = index + 1, sum = items[index]![1].count;
        const largest = sum;
        let best = score(sum, largest, sum);
        while (end < items.length) {
            const smallest = items[end]![1].count;
            const next = score(sum + smallest, largest, smallest);
            if (next > best) break;
            sum += smallest; best = next; end++;
        }
        const vertical = w >= h;
        const thickness = vertical ? w * sum / remaining : h * sum / remaining;
        let offset = 0;
        for (const [route, row] of items.slice(index, end)) {
            const length = (vertical ? h : w) * row.count / sum;
            tiles.push({ route, ...row, x: vertical ? x : x + offset, y: vertical ? y + offset : y, width: vertical ? thickness : length, height: vertical ? length : thickness });
            offset += length;
        }
        if (vertical) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
        remaining -= sum; index = end;
    }
    return tiles.map(tile => ({
        ...tile,
        x: Math.round(tile.x), y: Math.round(tile.y),
        width: Math.round(tile.x + tile.width) - Math.round(tile.x),
        height: Math.round(tile.y + tile.height) - Math.round(tile.y),
    }));
}
export const analyticsRouteLabels: Record<AutoModeUsageRoute, string> = { base: 'Base rules', forced: 'Forced', guard: 'Guard', accept_edits: 'Accept edits', allowlist: 'Allowed tools', stage1: 'Classifier, first pass', stage2: 'Classifier, second pass', unknown: 'Unknown route' };
