# Codex Subagent Account Leasing — Design

## Summary

The current Codex multi-account path is still globally routed around a shared active account in `src/services/api/codexAccountPool.ts`, even though subagents often behave as if they are pinned because their clients are reused. That works well enough for light use, but it breaks the quality-of-life goal the repo now needs: deliberate spawn-time account spreading, per-subagent pinning, lease-local failover, capped-account avoidance before first request, and visibility into which running worker is using which account.

This design adds an in-process **Codex lease manager** that sits on top of the existing account pool. The pool remains responsible for account inventory, aliases, token material, and health hints. The lease manager becomes responsible for assigning accounts to running workers, tracking live occupancy, and failing over only the worker that encountered a cap.

The implementation is intentionally scoped to the current Cat Code process. The interfaces are designed so a future shared backend could coordinate leases across multiple processes, but this phase does not add cross-process persistence or locking.

---

## Goals

1. **Spawn-time account selection per subagent**
   - New subagents should choose from healthy accounts only.
   - Selection should prefer the least crowded and least-used accounts.
   - Under the default spread policy, the main thread's account should be deprioritized but not forbidden.

2. **Pinning for the lifetime of the worker**
   - Once a worker gets an account, it stays on that account until the worker finishes or the account caps.

3. **Failover per worker, not globally**
   - If subagent A caps, only A should move.
   - Subagent B and the main thread should stay on their current accounts.

4. **Pre-filter known bad accounts**
   - Dead and capped accounts should be excluded before first request.
   - If all accounts are unavailable, fail immediately with a clear message instead of wasting a request.

5. **User visibility**
   - The main status line should show the main lease account.
   - `/accounts` should show current lease occupancy and current holders.
   - Task notifications should include lease-local failovers.

6. **Small-surface integration**
   - Reuse existing task and notification surfaces instead of introducing a new panel or agent dashboard.

---

## Non-goals

1. Cross-process lease coordination.
2. A new persistent database or lock protocol for leases.
3. A full rewrite of `codexAccountPool.ts`.
4. A new standalone UI for live subagent account monitoring.
5. Provider-agnostic leasing for non-Codex providers.

---

## Relevant existing files

### Account pool and usage
- `src/services/api/codexAccountPool.ts`
- `src/services/api/codexUsage.ts`
- `src/services/oauth/codex-client.ts`

### Request creation and retry
- `src/services/api/client.ts`
- `src/services/api/withRetry.ts`
- `src/services/api/claude.ts`
- `src/query.ts`

### Agent lifecycle and background tasks
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

### UI and settings
- `src/components/StatusLine.tsx`
- `src/commands/accounts/accounts.ts`
- `src/utils/settings/types.ts`
- `src/utils/taskNotification.ts`

---

## Current behavior and the gap

Today the routing flow is global:

- `src/query.ts` calls `selectAccountForTurn()` once per main-thread turn.
- `src/services/api/client.ts` calls `getActiveAccount()` when provider resolution lands on OpenAI/Codex.
- `src/services/api/withRetry.ts` calls `rotateOnFailure()` on `CodexAccountCapError`.

That means the real routing primitive is still the pool's shared `activeIndex`. Even when a subagent appears to stay pinned, that pinning is incidental to client reuse, not a first-class lease.

The missing concept is: **"this running worker currently owns account X"**.

---

## Design overview

### Keep the pool, add leases

The design does **not** replace `codexAccountPool.ts` as the inventory source. Instead:

- `codexAccountPool.ts` remains responsible for account loading, aliases, token material, and coarse account status.
- A new `codexAccountLeaseManager.ts` owns runtime lease assignment and occupancy tracking.

The lease manager makes account decisions for:
- the main thread
- local subagents launched through `AgentTool`

Any code path without a subagent owner ID is treated as main-thread work and uses the main lease.

---

## Lease model

Each live worker gets a lease record:

```ts
type CodexLeaseStrategy = 'spread' | 'follow-main'

type CodexLeaseOwnerType = 'main' | 'subagent'

type CodexLeaseState = 'active' | 'released' | 'failed'

type CodexLease = {
  leaseId: string
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
  accountId: string
  strategy: CodexLeaseStrategy
  state: CodexLeaseState
  createdAt: number
  updatedAt: number
  failoverCount: number
  selectionReason: string
  lastFailureReason?: string
}
```

This state is process-local and in-memory only.

### Owner identity

- Main thread owner ID: the current session ID
- Subagent owner ID: the existing `agentId`

### Owner label

To make `/accounts` understandable, the lease manager also tracks a human-readable label:
- main thread → `main thread`
- subagent → the `description` passed to `AgentTool`

The label is registered from the task/agent launch path before the first request.

---

## Account state model

The pool keeps account inventory and status. This phase expands the meaning of status slightly:

```ts
type PoolAccountStatus = 'healthy' | 'capped' | 'dead' | 'cooling_down'
```

`cooling_down` is optional in this phase. The lease manager and `/accounts` formatter should understand it, but the first implementation can treat it the same as temporarily unavailable without adding automatic retry scheduling.

Known capped accounts must be excluded before assignment.

---

## Selection policy

### New setting

Add a settings field in `src/utils/settings/types.ts`:

```ts
codexSubagentAccountStrategy: z.enum(['spread', 'follow-main']).optional()
```

Default: `spread`

This setting applies to subagent leases only.

### Spread strategy

When a new subagent lease is created:

1. Exclude `dead`, `capped`, and `cooling_down` accounts.
2. If no candidates remain, fail immediately.
3. Rank remaining candidates by:
   - lower live lease count
   - lower usage score (`5h * 3 + weekly`)
   - not being the main thread's current account
   - older `lastUsedAt`
4. Assign the best candidate and pin it.

This gives real spreading while still letting the main thread's account win when it is clearly the least-bad choice.

### Follow-main strategy

When a new subagent lease is created:

1. Try the main thread's current account if it is healthy and available.
2. If that is not possible, fall back to the spread ranking.

---

## Lease lifecycle

### 1. Registration

When `AgentTool` launches a subagent, it already has:
- `agentId`
- `description`

That launch path should register a lease owner label with the lease manager before the first Codex request.

### 2. Acquisition

Lease acquisition should be lazy.

The first time a worker needs a Codex client:
- resolve owner ID and owner type
- ask the lease manager for that owner's existing lease or a new assignment
- create the Codex fetch adapter with that account's access token

### 3. Steady state

All later requests from the same worker keep using the same lease.

### 4. Failover

On `CodexAccountCapError`:
- identify the current owner
- mark the failed account capped in the pool
- ask the lease manager to fail over that owner only
- if a replacement exists, recreate the client and continue
- if no replacement exists, fail that worker immediately

### 5. Release

When a subagent finishes, fails, or is killed:
- release its lease
- unregister its owner label

The main-thread lease persists for the life of the session.

---

## Request-path integration

### Client creation

`src/services/api/client.ts` currently builds Codex clients from `getActiveAccount()`.

This changes to:
- accept optional `codexLeaseOwnerId` and `codexLeaseOwnerType`
- resolve a lease account when Codex is active
- fall back to the existing single-account config only when the pool is inactive

### Retry loop

`src/services/api/withRetry.ts` currently calls `rotateOnFailure()` globally.

This changes to:
- accept optional `codexLeaseOwnerId`
- on `CodexAccountCapError`, call `failoverCodexLease(ownerId, failedAccountId)`
- recreate the client with the new lease assignment
- leave other leases untouched

### Query API call sites

`src/services/api/claude.ts` already distinguishes subagents via `options.agentId`. That is enough for this phase.

Each `getAnthropicClient()` call site on the query path should pass:

```ts
codexLeaseOwnerId: options.agentId ?? getSessionId(),
codexLeaseOwnerType: options.agentId ? 'subagent' : 'main'
```

That keeps the change small and avoids widening unrelated context types.

---

## Pool integration

`codexAccountPool.ts` remains the source of account data, but it needs a few new capabilities:

1. `markAccountCapped(accountId, reason)`
2. `markAccountHealthy(accountId)` for future reset/recovery cases
3. `getHealthyPoolAccounts()` or equivalent candidate access
4. `touchAccountAssignment(accountId)` to update `lastUsedAt`
5. `syncMainLeaseToActiveAccount(accountId)` or a small wrapper so legacy main-thread surfaces still behave correctly

The existing exported helpers should keep working where possible:
- `getActiveAccount()` becomes “current main-lease account” when the lease manager is active
- `selectAccountForTurn()` becomes a main-lease rotation wrapper instead of a global router
- `switchToAccount()` should update the main lease if one already exists

This preserves current command behavior while shifting routing to leases.

---

## Usage-based capped avoidance

`src/services/api/codexUsage.ts` currently updates only soft usage hints.

This phase should also let usage snapshots influence account availability:

- if `limitReached === true` or `allowed === false`, mark the pool account capped
- if a later refresh shows the account is usable again, restore it to healthy

That lets spawn and first-request selection avoid accounts we already know are exhausted.

If every account is capped or unavailable, surface a clear message immediately.

---

## Visibility

### Status line

`src/components/StatusLine.tsx` should display the main lease account instead of directly reading `activeIndex`.

### `/accounts`

`src/commands/accounts/accounts.ts` should display:
- main lease account
- per-account lease count
- current holders by short label
- account status including capped/cooling-down
- configured subagent strategy

Example shape:

```text
Codex Account Pool:

● main        [healthy]   leases: 1   holders: main thread
  backup1     [healthy]   leases: 2   holders: research-agent, test-agent
  backup2     [capped]    leases: 0   avoided: usage cap

Subagent strategy: spread
```

### Notifications

Task notifications already exist. The summary should mention failovers when they occur, for example:

```text
Agent "research-agent" switched Codex backup2 -> main after usage cap
```

This is enough visibility for this phase without building a new task list UI.

---

## Error handling

When a worker cannot acquire a lease because every account is unavailable, return a message that clearly states:
- all healthy accounts are exhausted or unavailable
- no automatic global switch will happen
- the failure is scoped to the current worker

That is materially better than selecting a known-capped account and discovering it on the first request.

---

## Testing strategy

### Unit tests

Add a dedicated test file for the lease manager to cover:
- spread selection prefers fewer live leases
- spread deprioritizes the main account
- follow-main uses the main account when healthy
- capped/dead accounts are filtered before assignment
- failover only changes the targeted lease
- releasing a lease decrements occupancy

### Integration/regression checks

Verify:
- main and two subagents receive distinct assignments when possible
- one subagent capping does not move other workers
- status line shows the main lease account
- `/accounts` shows lease counts and holders

### Critical regression to prevent

A subagent hitting a cap must **not** perturb the main thread or sibling subagents.

---

## Rollout notes

This change should preserve current single-account behavior. If the pool is inactive or only one healthy account exists, the system should continue using the existing single-account path without any extra UI noise.

The lease manager should be dormant in that case.

---

## Recommended implementation sequence

1. Add the lease manager and unit tests.
2. Register owner labels from agent launch paths.
3. Route Codex client creation through leases.
4. Change retry failover from global to lease-local.
5. Wire status line and `/accounts` to lease snapshots.
6. Extend usage refresh to pre-mark capped accounts.

That sequence keeps the behavior testable at every step and limits the blast radius of the retry change.
