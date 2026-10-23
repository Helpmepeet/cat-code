import type { UsagePatchFollowupState } from '../../app/shared/usageDashboard.js';

export type PatchActivityCall = {
    key: string;
    scope: string;
    timestamp: number;
    kind: 'patch' | 'edit' | 'write' | 'shell' | 'boundary';
    result?: { timestamp: number; error: boolean };
};
export type PatchFollowupEpisode = { origin: string; retryCalls: number; repeatErrors: number; state: UsagePatchFollowupState };

/** Same-source, same-agent temporal observations only. No target or intent inference. */
export function observedPatchFollowups(calls: readonly PatchActivityCall[]): PatchFollowupEpisode[] {
    const scopes = new Map<string, PatchActivityCall[]>();
    for (const call of calls) {
        const list = scopes.get(call.scope) ?? [];
        list.push(call);
        scopes.set(call.scope, list);
    }
    const episodes: PatchFollowupEpisode[] = [];
    for (const source of scopes.values()) {
        source.sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
        let pending: { episode: PatchFollowupEpisode; after: number } | undefined;
        const finish = (state: UsagePatchFollowupState) => {
            if (pending) { pending.episode.state = state; episodes.push(pending.episode); pending = undefined; }
        };
        for (const [index, call] of source.entries()) {
            const result = call.result && call.result.timestamp >= call.timestamp ? call.result : undefined;
            if (call.kind === 'boundary') {
                finish(pending && call.timestamp <= pending.after ? 'unknown' : 'unresolved');
                continue;
            }
            const concurrent = source[index - 1]?.timestamp === call.timestamp || source[index + 1]?.timestamp === call.timestamp;
            if (concurrent) {
                finish('unknown');
                if (call.kind === 'patch' && result?.error) episodes.push({ origin: call.key, retryCalls: 0, repeatErrors: 0, state: 'unknown' });
                continue;
            }
            if (pending && call.timestamp <= pending.after) finish('unknown');
            if (pending) {
                if (call.kind !== 'patch') {
                    finish(call.kind === 'edit' ? 'edit-switch' : call.kind === 'write' ? 'write-switch' : 'shell-switch-unknown');
                    continue;
                }
                pending.episode.retryCalls++;
                if (!result) { finish('retry-result-missing'); continue; }
                if (!result.error) { finish('retry-result-success'); continue; }
                pending.episode.repeatErrors++;
                pending.after = result.timestamp;
            } else if (call.kind === 'patch' && result?.error) {
                pending = { episode: { origin: call.key, retryCalls: 0, repeatErrors: 0, state: 'unresolved' }, after: result.timestamp };
            }
        }
        finish('unresolved');
    }
    return episodes;
}
