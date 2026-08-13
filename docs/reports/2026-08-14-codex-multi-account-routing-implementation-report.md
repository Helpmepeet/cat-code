# Codex Multi-Account Routing Implementation Report

**Date:** 2026-08-14

**Scope:** Follow-up implementation, verification, and review of
[`2026-08-13-codex-multi-account-routing-audit.md`](2026-08-13-codex-multi-account-routing-audit.md).

## Outcome

Completed the confirmed multi-account routing repairs, focused regression
coverage, documentation updates, and a review-and-fix pass. The implementation
now applies owner-local Codex account handling across forked work, secondary
model calls, relevant-memory selection, and Codex subscription image generation.

No real Codex account, OAuth credential, quota state, GUI surface, merge,
deployment, or remote push was used.

## Implemented findings

### F1: Lease and transport lifecycle cleanup

`runForkedAgent()` now releases the isolated tool-context owner lease on
completion, error, and abort. It also clears the matching session-scoped
WebSocket transport state. This applies only to forked work and the
background-disabled synchronous AgentTool path, both of which can use the
streaming transport path. `clearWebSocketSession()` is a no-op when no transport
entry exists.

Normal registered foreground and background AgentTool tasks retain their
existing `LocalAgentTask` owner cleanup; `unregisterAgentForeground()` already
releases their account resources.

Key paths:

- `src/utils/forkedAgent.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

### F2: Subagent owner propagation

The compact streaming fallback, WebFetch, and WebFetch secondary Haiku request
now preserve the originating `agentId`. Their account selection and any
subsequent failover therefore remain local to the owning subagent rather than
moving the main lease.

Key paths:

- `src/services/compact/compact.ts`
- `src/tools/WebFetchTool/WebFetchTool.ts`
- `src/tools/WebFetchTool/utils.ts`

### F3: `sideQuery()` account transitions

OpenAI-routed `sideQuery()` calls now use the shared `withRetry()`
account-state classifier. The client SDK retry budget is disabled for these
calls so typed 401 and 429 errors reach the pool transition logic.

A call binds to its explicit subagent lease when supplied, or to the existing
`main-thread` lease otherwise. Relevant-memory prefetch now propagates its
proven subagent owner through the following chain:

```text
query() → startRelevantMemoryPrefetch() → attachments → memory selector → sideQuery()
```

First-party provider overrides stay outside the Codex pool. A Codex side query
with `maxRetries: 0` still receives one bounded failover attempt after a
successful account transition, preventing an exhausted generator from returning
without a response.

Key paths:

- `src/utils/sideQuery.ts`
- `src/query.ts`
- `src/utils/attachments.ts`
- `src/memdir/findRelevantMemories.ts`
- `src/services/api/withRetry.ts`

### F4: Image endpoint 401/429 failover

Codex subscription image endpoint responses now translate into the existing
account transition errors:

- HTTP 429 becomes `CodexAccountCapError`.
- HTTP 401 becomes `CodexAccountAuthError`.

The shared retry path handles owner-local capping, refresh, dead-marking, and
failover. Authentication is resolved per attempt, so a successful refresh or
replacement lease supplies a current token and account header.

API-key image mode remains direct and one-shot. It cannot mutate the Codex pool.

Key path:

- `src/tools/GenerateImageTool/GenerateImageTool.ts`

### F5: Terminal product policy

The selected policy is:

> Automatic continuation is allowed only when every configured Codex account is
> quota-blocked and none needs credential repair or has unresolved transient
> state.

A mixed capped-plus-dead pool therefore produces `account_recovery`, not
`quota_exhausted`. `/continue-after-limit` is not permitted for that state.
The advisory status path now returns `human_recovery` even when the capped
account has a known quota reset.

The implementation already followed this aggregate pool-health policy. The
stale lease-manager assertion was corrected and the status observer, maps, and
audit addendum were aligned with it.

Key paths:

- `src/services/api/codexStatus.ts`
- `src/services/api/codexAccountLeaseManager.test.ts`

### V1: Test timeout isolation

The audit timeout originated in a test entering an unmocked raw-config OAuth
forced-refresh path. It was not evidence of a production recovery hang.

The auth test now uses a temporary `CLAUDE_CONFIG_DIR`, mocks only the expected
OAuth token endpoint, rejects unexpected network requests, and validates the
`invalid_grant` account-recovery result. Production OAuth timeout behavior is
unchanged.

## Review-and-fix pass

The implementation review found and repaired three valid issues:

1. Resource-cleanup tests used global module replacements that contaminated
   combined suites. They now seed and inspect real lease state instead.
2. A `sideQuery()` with zero ordinary retries could move a lease after a cap,
   then exit before trying its replacement. It now permits one bounded Codex
   failover attempt.
3. Image regression coverage lacked proof of subagent lease isolation and
   successful same-account 401 refresh. Tests now cover both.

The review rejected the following as false positives:

- Normal foreground AgentTool work does not leak account resources because the
  registered `LocalAgentTask` cleanup path releases them.
- Fork and background-disabled synchronous-agent WebSocket cleanup is limited
  to owners that can use the streaming transport path; it is safe without an
  allocated entry.
- No registry or SDK schema update was needed because this work added no new
  diagnostic codes, registry data, or serialized shape.

## Documentation and impact surfaces

Updated:

- `docs/maps/codex-core.md`
- `docs/maps/auth-accounts-oauth.md`
- `docs/reports/2026-08-13-codex-multi-account-routing-audit.md`

No desktop-app files, settings schemas, migrations, diagnostic registries, or
SDK schemas changed.

## Verification

```text
VERIFICATION
- bun test src/utils/forkedAgent.test.ts src/tools/AgentTool/AgentTool.cleanup.test.ts src/tools/AgentTool/AgentTool.test.ts src/services/compact/compact.test.ts src/tools/WebFetchTool/WebFetchTool.test.ts src/tools/WebFetchTool/utils.test.ts
  → 41 pass / 0 fail

- bun test src/utils/sideQuery.test.ts src/utils/attachments.test.ts src/query.test.ts src/services/api/withRetry.test.ts src/services/api/codexAccountPool.test.ts src/services/api/codexAccountLeaseManager.test.ts src/services/api/codexStatus.test.ts src/services/deferredContinuation.test.ts src/services/deferredContinuationRunner.test.ts src/services/api/deferredTerminalFailure.test.ts src/tools/GenerateImageTool/GenerateImageTool.test.ts
  → 241 pass / 0 fail

- bun test src/tools/AgentTool/AgentTool.cleanup.test.ts src/services/api/codexAccountLeaseManager.test.ts src/utils/sideQuery.test.ts
  → 61 pass / 0 fail

- bun test src/tools/GenerateImageTool/GenerateImageTool.test.ts
  → 29 pass / 0 fail

- bun run build:dev:full
  → passed; workspace-map lint emitted 8 existing advisory warnings; CLI printed:
    2.1.87-dev.20260813.t164420.sha46853020

- bun run maps:lint
  → passed; 18 maps, 8 existing advisory warnings

- git diff --check
  → clean

Stale-reference sweep:
  → live stale audit wording clean. One historical reference remains in the
    shared migration STATUS log and was intentionally not altered.
```

## Commits

1. `70563f8e fix(codex): release finished subagent resources`
2. `1f0e4652 fix(codex): retry secondary usage on owner leases`
3. `46853020 fix(codex): require pool-wide quota evidence for continuation`
4. `a554b4a1 fix(codex): harden multi-account routing regressions`

## Push and deployment status

The commits were not pushed. The shared `migration` branch already contained
unrelated unpushed work, so pushing it would have published other sessions'
changes. No merge or deployment was performed.

## Remaining limitation

Mocked tests prove account routing, lease isolation, cap/auth transitions,
refresh retry behavior, API-key isolation, and test network isolation. Live
provider behavior remains intentionally unverified because no real Codex
accounts, OAuth credentials, quota state, or subscription usage were authorized.
