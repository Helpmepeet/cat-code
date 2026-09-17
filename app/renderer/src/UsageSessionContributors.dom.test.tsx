import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { usageProjectId, type UsageDayContributors } from '../../shared/usageDashboard.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

const contributors: UsageDayContributors = { state: 'full', omitted: 0, items: [{
    id: 'session-a', engineSessionId: 'session-a', project: { id: usageProjectId('/work/project'), label: 'project' },
    tokens: { fresh: 10, read: 0, write: 0, output: 2 }, requests: 1, results: 1, errors: 0,
    models: [], modelDetail: { state: 'full', omitted: 0 },
    timeline: { state: 'truncated', omitted: 1, items: [
        { id: 'model-a', kind: 'model', callId: 'private-call-id', label: 'GPT 5.6', provider: 'openai', mode: 'streaming', attempt: 1, startedAt: '2026-09-17T09:00:00.000Z', outcome: 'succeeded', durationMs: 2_000, firstTextMs: 350 },
    ] },
}] };

const row = {
    sessionId: 'session-a', appSessionId: null, cwd: '/work/project', cwdExists: true,
    title: 'Timing investigation', displayLabel: 'Timing investigation', name: null,
    live: false, restorable: true, parked: false, status: 'history' as const, inRegistry: false,
    modifiedAtMs: 0, createdAtMs: 0, lastMessageSentAt: null, transcriptActivityAtMs: null,
    gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null,
};

test('Timeline expands and collapses the selected session without changing navigation actions', async () => {
    const opened: string[] = [];
    const tree = await harness.mount(<UsageSessionContributors contributors={contributors} rows={[row]} onOpenRow={selected => opened.push(selected.sessionId)}/>);
    const toggle = tree.container.querySelector<HTMLButtonElement>('.usage-session-timeline-toggle')!;
    expect(toggle.textContent).toBe('Timeline');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(tree.container.querySelector('.usage-session-timeline-row')).toBeNull();

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(tree.container.querySelector('.usage-session-timeline-row')?.textContent).toContain('GPT 5.6');
    expect(tree.container.querySelector('.usage-session-timeline-row')?.textContent).toContain('1 more execution event is not shown');
    expect(tree.container.textContent).not.toContain('private-call-id');
    const open = tree.container.querySelector<HTMLButtonElement>('.usage-session-open')!;
    expect(open.textContent).toBe('Open');
    await act(async () => open.click());
    expect(opened).toEqual(['session-a']);

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(tree.container.querySelector('.usage-session-timeline-row')).toBeNull();
});
