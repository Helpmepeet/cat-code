import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { usageProjectId, type UsageDayContributors } from '../../shared/usageDashboard.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

const contributors: UsageDayContributors = { state: 'truncated', omitted: 2, items: [{
    id: 'session-a', engineSessionId: 'session-a', project: { id: usageProjectId('/work/project'), label: 'project' },
    tokens: { fresh: 10, read: 0, write: 0, output: 2 }, requests: 1, results: 1, errors: 0,
    models: [], modelDetail: { state: 'full', omitted: 0 },
    timeline: { state: 'unavailable', omitted: 0, items: [] },
}] };
const row = {
    sessionId: 'session-a', appSessionId: null, cwd: '/work/project', cwdExists: true,
    title: 'Timing investigation', displayLabel: 'Timing investigation', name: null,
    live: false, restorable: true, parked: false, status: 'history' as const, inRegistry: false,
    modifiedAtMs: 0, createdAtMs: 0, lastMessageSentAt: null, transcriptActivityAtMs: null,
    gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null,
};

test('three-column session table opens a matched session and preserves complete day totals', async () => {
    const opened: string[] = [];
    const tree = await harness.mount(<UsageSessionContributors contributors={contributors} rows={[row]} onOpenRow={selected => opened.push(selected.sessionId)}/>);
    expect([...tree.container.querySelectorAll('thead th')].map(item => item.textContent)).toEqual(['Session', 'Tokens', 'Est. cost']);
    expect(tree.container.textContent).toContain('Showing 1 of 3 sessions. Day totals include all.');
    expect(tree.container.querySelector('.usage-session-timeline-row')).toBeNull();
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-session-name')!.click());
    expect(opened).toEqual(['session-a']);
});
