# Codex Subagent Account Leasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class Codex account leases so subagents choose healthy accounts deliberately, stay pinned for their run, fail over independently, avoid known-capped accounts before first request, and surface lease state in existing UI.

**Architecture:** Keep `src/services/api/codexAccountPool.ts` as the inventory and health source, then add a new in-process lease manager that assigns accounts per worker. Route Codex client creation and retry through the lease owner ID rather than the pool's shared `activeIndex`, while preserving current single-account behavior when the pool is inactive.

**Tech Stack:** Bun, TypeScript, Ink, Zod, existing Bun test runner (`bun test`)

---

## File structure

### Create
- `src/services/api/codexAccountLeaseManager.ts` — In-process lease registry, selection, failover, snapshot helpers.
- `src/services/api/codexAccountLeaseManager.test.ts` — Unit tests for lease selection, release, and failover behavior.

### Modify
- `src/services/api/codexAccountPool.ts` — Add helpers for lease-aware account state transitions and candidate access.
- `src/services/api/codexUsage.ts` — Pre-mark capped/unavailable accounts from usage snapshots.
- `src/services/api/client.ts` — Resolve Codex credentials via lease owner identity.
- `src/services/api/withRetry.ts` — Perform lease-local failover instead of global failover.
- `src/services/api/claude.ts` — Pass lease owner identity into `getAnthropicClient()` on query paths.
- `src/tools/AgentTool/AgentTool.tsx` — Register subagent owner labels and release them on task completion paths if needed.
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` — Release leases on completion/failure/kill and include lease-aware notification summaries.
- `src/components/StatusLine.tsx` — Show main lease account instead of shared pool `activeIndex`.
- `src/commands/accounts/accounts.ts` — Show lease counts, holders, strategy, and main lease.
- `src/utils/settings/types.ts` — Add `codexSubagentAccountStrategy` setting.
- `src/query.ts` — Adjust main-thread rotation to operate through the main lease instead of global routing.

### Existing tests to run
- `src/utils/providerPromptRegressions.test.ts` — existing Bun test style reference

---

### Task 1: Add the settings and lease-manager skeleton

**Files:**
- Create: `src/services/api/codexAccountLeaseManager.ts`
- Modify: `src/utils/settings/types.ts:333-347`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing test for default strategy and lease creation API**

```ts
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createCodexLeaseForTest,
  getCodexLeaseSnapshotForTest,
  resetCodexLeaseManagerForTest,
} from './codexAccountLeaseManager.js'

describe('codexAccountLeaseManager', () => {
  beforeEach(() => {
    resetCodexLeaseManagerForTest()
  })

  test('creates a subagent lease with the spread strategy by default', () => {
    const lease = createCodexLeaseForTest({
      ownerId: 'agent-1',
      ownerType: 'subagent',
      ownerLabel: 'research-agent',
    })

    expect(lease.strategy).toBe('spread')

    const snapshot = getCodexLeaseSnapshotForTest()
    expect(snapshot.leases).toHaveLength(1)
    expect(snapshot.leases[0]?.ownerId).toBe('agent-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because `codexAccountLeaseManager.ts` and its exports do not exist yet.

- [ ] **Step 3: Add the new settings field**

```ts
codexSubagentAccountStrategy: z
  .enum(['spread', 'follow-main'])
  .optional()
  .describe(
    'How new Codex subagents choose accounts from the pool (default: spread).',
  ),
```

- [ ] **Step 4: Write the minimal lease manager skeleton**

```ts
export type CodexLeaseStrategy = 'spread' | 'follow-main'
export type CodexLeaseOwnerType = 'main' | 'subagent'
export type CodexLeaseState = 'active' | 'released' | 'failed'

export type CodexLease = {
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

const leases = new Map<string, CodexLease>()

export function resetCodexLeaseManagerForTest(): void {
  leases.clear()
}

export function createCodexLeaseForTest(input: {
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
}): CodexLease {
  const lease: CodexLease = {
    leaseId: `lease:${input.ownerId}`,
    ownerId: input.ownerId,
    ownerType: input.ownerType,
    ownerLabel: input.ownerLabel,
    accountId: 'test-account',
    strategy: 'spread',
    state: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    failoverCount: 0,
    selectionReason: 'test default',
  }
  leases.set(input.ownerId, lease)
  return lease
}

export function getCodexLeaseSnapshotForTest(): { leases: CodexLease[] } {
  return { leases: [...leases.values()] }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with 1 passing test.

- [ ] **Step 6: Commit**

```bash
git add src/utils/settings/types.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: add codex lease manager skeleton"
```

---

### Task 2: Implement lease selection with crowding and account filtering

**Files:**
- Modify: `src/services/api/codexAccountLeaseManager.ts`
- Modify: `src/services/api/codexAccountPool.ts:27-44,171-260,611-689`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing tests for spread ranking and capped filtering**

```ts
test('spread prefers the least crowded healthy account and deprioritizes main', () => {
  const state = seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 20, usageWeekly: 10 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 25, usageWeekly: 10 },
    { accountId: 'backup2', status: 'healthy', usagePrimary: 30, usageWeekly: 10 },
  ])

  setMainLeaseForTest('main')
  seedExistingLeaseForTest({ ownerId: 'agent-a', ownerType: 'subagent', ownerLabel: 'a', accountId: 'backup1' })

  const lease = acquireCodexLease({
    ownerId: 'agent-b',
    ownerType: 'subagent',
    ownerLabel: 'b',
    strategy: 'spread',
  })

  expect(lease.accountId).toBe('backup2')
})

test('lease acquisition excludes capped and dead accounts before first request', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'capped', usagePrimary: 100, usageWeekly: 50 },
    { accountId: 'backup1', status: 'dead', usagePrimary: 0, usageWeekly: 0 },
  ])

  expect(() =>
    acquireCodexLease({
      ownerId: 'agent-c',
      ownerType: 'subagent',
      ownerLabel: 'c',
      strategy: 'spread',
    }),
  ).toThrow('All Codex accounts are capped or unavailable')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because the pool seeding helpers and real acquisition logic do not exist yet.

- [ ] **Step 3: Add pool helpers needed by lease selection**

```ts
export function getPoolAccountsForLeaseSelection(): readonly PoolAccount[] {
  return pool.accounts
}

export function markPoolAccountStatus(
  accountId: string,
  status: PoolAccount['status'],
  reason?: string,
): void {
  const acct = pool.accounts.find(a => a.accountId === accountId)
  if (!acct) return
  acct.status = status
  acct.lastError = reason
  if (status === 'capped') {
    acct.usagePrimary = 100
  }
}

export function touchPoolAccountUsage(accountId: string): void {
  const acct = pool.accounts.find(a => a.accountId === accountId)
  if (!acct) return
  acct.lastUsedAt = Date.now()
}
```

- [ ] **Step 4: Replace the lease-manager stub with real selection logic**

```ts
function scoreCandidate(input: {
  account: PoolAccount
  leaseCount: number
  isMainAccount: boolean
}): number {
  const usageScore = (input.account.usagePrimary ?? 50) * 3 + (input.account.usageWeekly ?? 50)
  const mainPenalty = input.isMainAccount ? 25 : 0
  return input.leaseCount * 1_000 + usageScore + mainPenalty
}

function selectAccountForLease(strategy: CodexLeaseStrategy): PoolAccount {
  const accounts = getPoolAccountsForLeaseSelection().filter(
    account => account.status === 'healthy',
  )

  if (accounts.length === 0) {
    throw new Error('All Codex accounts are capped or unavailable')
  }

  const mainAccountId = getMainLease()?.accountId

  if (strategy === 'follow-main' && mainAccountId) {
    const mainAccount = accounts.find(account => account.accountId === mainAccountId)
    if (mainAccount) {
      return mainAccount
    }
  }

  return [...accounts]
    .sort((a, b) => {
      const scoreA = scoreCandidate({
        account: a,
        leaseCount: getLeaseCountForAccount(a.accountId),
        isMainAccount: a.accountId === mainAccountId,
      })
      const scoreB = scoreCandidate({
        account: b,
        leaseCount: getLeaseCountForAccount(b.accountId),
        isMainAccount: b.accountId === mainAccountId,
      })
      return scoreA - scoreB || a.lastUsedAt - b.lastUsedAt
    })[0]!
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with the spread and capped-filter tests succeeding.

- [ ] **Step 6: Commit**

```bash
git add src/services/api/codexAccountPool.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: add codex lease selection and filtering"
```

---

### Task 3: Implement lease release and lease-local failover behavior

**Files:**
- Modify: `src/services/api/codexAccountLeaseManager.ts`
- Modify: `src/services/api/codexAccountPool.ts:228-260,380-395`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing tests for release and isolated failover**

```ts
test('releasing a lease decrements occupancy without touching other leases', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5 },
  ])

  acquireCodexLease({ ownerId: 'agent-a', ownerType: 'subagent', ownerLabel: 'a', strategy: 'spread' })
  acquireCodexLease({ ownerId: 'agent-b', ownerType: 'subagent', ownerLabel: 'b', strategy: 'spread' })

  releaseCodexLease('agent-a')

  const snapshot = getCodexLeaseSnapshotForTest()
  expect(snapshot.leases.map(lease => lease.ownerId)).toEqual(['agent-b'])
})

test('failover only reassigns the lease that hit a cap', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5 },
    { accountId: 'backup2', status: 'healthy', usagePrimary: 20, usageWeekly: 5 },
  ])

  const a = acquireCodexLease({ ownerId: 'agent-a', ownerType: 'subagent', ownerLabel: 'a', strategy: 'spread' })
  const b = acquireCodexLease({ ownerId: 'agent-b', ownerType: 'subagent', ownerLabel: 'b', strategy: 'spread' })

  const next = failoverCodexLease('agent-a', a.accountId, 'Usage cap hit (429)')

  expect(next.accountId).not.toBe(a.accountId)
  expect(getCodexLease('agent-b')?.accountId).toBe(b.accountId)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because release and failover behavior is not implemented.

- [ ] **Step 3: Add minimal release and failover methods**

```ts
export function releaseCodexLease(ownerId: string): void {
  leases.delete(ownerId)
}

export function failoverCodexLease(
  ownerId: string,
  failedAccountId: string,
  reason: string,
): CodexLease {
  const existing = leases.get(ownerId)
  if (!existing) {
    throw new Error(`No Codex lease found for owner ${ownerId}`)
  }

  markPoolAccountStatus(failedAccountId, 'capped', reason)
  leases.delete(ownerId)

  const replacement = acquireCodexLease({
    ownerId,
    ownerType: existing.ownerType,
    ownerLabel: existing.ownerLabel,
    strategy: existing.strategy,
  })

  replacement.failoverCount = existing.failoverCount + 1
  replacement.lastFailureReason = reason
  replacement.selectionReason = `failover after ${failedAccountId}`
  leases.set(ownerId, replacement)
  return replacement
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with release and isolated-failover tests succeeding.

- [ ] **Step 5: Commit**

```bash
git add src/services/api/codexAccountPool.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: add codex lease release and failover"
```

---

### Task 4: Route Codex client creation through lease owner identity

**Files:**
- Modify: `src/services/api/client.ts:99-185,335-350`
- Modify: `src/services/api/claude.ts:552-559,862-867,1823-1830`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing integration test for lease-based credential resolution**

```ts
test('client resolution uses the owner lease account instead of the shared active account', async () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5, accessToken: 'main-token' },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5, accessToken: 'backup-token' },
  ])

  setMainLeaseForTest('main')
  seedExistingLeaseForTest({ ownerId: 'agent-a', ownerType: 'subagent', ownerLabel: 'a', accountId: 'backup1' })

  const resolved = resolveCodexAccountForRequestForTest({
    codexLeaseOwnerId: 'agent-a',
    codexLeaseOwnerType: 'subagent',
  })

  expect(resolved?.accessToken).toBe('backup-token')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because client resolution still depends on `getActiveAccount()`.

- [ ] **Step 3: Extend `getAnthropicClient()` to accept lease-owner identity**

```ts
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  provider,
  fetchOverride,
  source,
  codexLeaseOwnerId,
  codexLeaseOwnerType,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  provider?: APIProvider
  fetchOverride?: ClientOptions['fetch']
  source?: string
  codexLeaseOwnerId?: string
  codexLeaseOwnerType?: 'main' | 'subagent'
}): Promise<Anthropic> {
  // ...existing code...
}
```

- [ ] **Step 4: Replace shared active-account resolution with lease-based resolution**

```ts
const poolAcct = isPoolActive()
  ? resolveCodexAccountForRequest({
      ownerId: codexLeaseOwnerId,
      ownerType: codexLeaseOwnerType,
    })
  : null
```

- [ ] **Step 5: Pass owner identity from the query call sites**

```ts
getAnthropicClient({
  maxRetries: 0,
  model: options.model,
  fetchOverride: options.fetchOverride,
  source: options.querySource,
  codexLeaseOwnerId: options.agentId ?? getSessionId(),
  codexLeaseOwnerType: options.agentId ? 'subagent' : 'main',
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with lease-based client resolution succeeding.

- [ ] **Step 7: Commit**

```bash
git add src/services/api/client.ts src/services/api/claude.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: route codex clients through worker leases"
```

---

### Task 5: Change retry failover from global pool rotation to lease-local reassignment

**Files:**
- Modify: `src/services/api/withRetry.ts:133-149,268-283`
- Modify: `src/services/api/claude.ts:1883-1891,914-923`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

**Additional requirement:**
- When a Codex account/profile has hit usage limits, the user-facing failure should not be surfaced as a generic connectivity error. This task should classify that condition as account exhaustion / usage cap, prefer lease-local failover when a replacement account exists, and emit a clear usage-limit message when no replacement is available.

- [ ] **Step 1: Write the failing tests for retry failover scope and usage-limit classification**

```ts
test('retry failover switches only the current owner lease', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5 },
    { accountId: 'backup2', status: 'healthy', usagePrimary: 20, usageWeekly: 5 },
  ])

  const failing = acquireCodexLease({ ownerId: 'agent-fail', ownerType: 'subagent', ownerLabel: 'fail', strategy: 'spread' })
  const stable = acquireCodexLease({ ownerId: 'agent-stable', ownerType: 'subagent', ownerLabel: 'stable', strategy: 'spread' })

  failoverCodexLease('agent-fail', failing.accountId, 'Usage cap hit (429)')

  expect(getCodexLease('agent-stable')?.accountId).toBe(stable.accountId)
})

test('usage-cap failures are classified as account exhaustion rather than connectivity errors', () => {
  const message = formatCodexUsageLimitMessageForTest({
    accountAlias: 'backup2',
    ownerLabel: 'research-agent',
  })

  expect(message).toContain('usage limit')
  expect(message).toContain('backup2')
  expect(message).not.toContain('Unable to connect to API')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL or remain unimplemented because the retry loop does not yet pass owner IDs.

- [ ] **Step 3: Extend retry options with owner identity**

```ts
interface RetryOptions {
  // ...existing fields...
  codexLeaseOwnerId?: string
  codexLeaseOwnerType?: 'main' | 'subagent'
}
```

- [ ] **Step 4: Replace global `rotateOnFailure()` with lease-local failover and usage-limit classification**

```ts
if (error instanceof CodexAccountCapError && isPoolActive()) {
  if (options.codexLeaseOwnerId) {
    const nextLease = tryFailoverCodexLease(
      options.codexLeaseOwnerId,
      error.accountId,
      'Usage cap hit (429)',
    )

    if (nextLease) {
      logForDebugging(
        `[codex-pool] Lease failover for ${options.codexLeaseOwnerId}: ${error.accountId} -> ${nextLease.accountId}`,
      )
      applyPostCodexAccountSwitchRefresh()
      options.onCodexAccountSwitch?.()
      client = null
      continue
    }

    throw new Error(
      formatCodexUsageLimitMessage({
        accountId: error.accountId,
        ownerId: options.codexLeaseOwnerId,
      }),
    )
  }
}
```

- [ ] **Step 5: Pass owner identity into both streaming and non-streaming retry paths**

```ts
{
  model: options.model,
  fallbackModel: options.fallbackModel,
  thinkingConfig,
  ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
  signal,
  querySource: options.querySource,
  onCodexAccountSwitch: options.onCodexAccountSwitch,
  codexLeaseOwnerId: options.agentId ?? getSessionId(),
  codexLeaseOwnerType: options.agentId ? 'subagent' : 'main',
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with failover keeping sibling leases unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/services/api/withRetry.ts src/services/api/claude.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: make codex failover lease-local"
```

---

### Task 6: Register and release leases from the real agent/task lifecycle

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.tsx`
- Modify: `src/tasks/LocalAgentTask/LocalAgentTask.tsx:223-268,446-463,474-522,534-622`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing test for owner label registration and release**

```ts
test('subagent labels are registered for snapshots and removed on release', () => {
  registerCodexLeaseOwner({
    ownerId: 'agent-1',
    ownerType: 'subagent',
    ownerLabel: 'research-agent',
  })

  acquireCodexLease({
    ownerId: 'agent-1',
    ownerType: 'subagent',
    ownerLabel: 'research-agent',
    strategy: 'spread',
  })

  expect(getCodexLeaseSnapshotForTest().leases[0]?.ownerLabel).toBe('research-agent')

  releaseCodexLease('agent-1')

  expect(getCodexLeaseSnapshotForTest().leases).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL until owner-label registration helpers exist.

- [ ] **Step 3: Register owner labels from the subagent launch path**

```ts
registerCodexLeaseOwner({
  ownerId: agentId,
  ownerType: 'subagent',
  ownerLabel: description,
})
```

Place this immediately after the task/agent ID is known in the async and foreground launch paths.

- [ ] **Step 4: Release the lease on task completion, failure, and kill**

```ts
releaseCodexLease(taskId)
```

Add that to the common terminal transitions in `completeAsyncAgent`, `failAgentTask`, and `killAsyncAgent`.

- [ ] **Step 5: Include lease-failover text in task notifications**

```ts
const summary =
  status === 'completed'
    ? `Agent "${description}" completed`
    : status === 'failed'
      ? `Agent "${description}" failed: ${error || 'Unknown error'}`
      : `Agent "${description}" was stopped`
```

Extend the details payload so a lease failover event can append a concise line when present.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with owner labels visible and leases released on cleanup.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/AgentTool.tsx src/tasks/LocalAgentTask/LocalAgentTask.tsx src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: bind codex leases to agent lifecycle"
```

---

### Task 7: Expose lease state in the status line and `/accounts`

**Files:**
- Modify: `src/components/StatusLine.tsx:127-136`
- Modify: `src/commands/accounts/accounts.ts:27-75`
- Modify: `src/services/api/codexAccountLeaseManager.ts`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing test for snapshot formatting helpers**

```ts
test('lease snapshot exposes main lease and per-account holder counts', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5 },
  ])

  acquireCodexLease({ ownerId: 'session-1', ownerType: 'main', ownerLabel: 'main thread', strategy: 'spread' })
  acquireCodexLease({ ownerId: 'agent-1', ownerType: 'subagent', ownerLabel: 'research-agent', strategy: 'spread' })

  const snapshot = getCodexLeaseSnapshotForTest()
  expect(snapshot.mainLease?.ownerLabel).toBe('main thread')
  expect(snapshot.accounts.find(account => account.accountId === 'backup1')?.leaseCount).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because the rich snapshot shape does not exist yet.

- [ ] **Step 3: Add a rich snapshot helper to the lease manager**

```ts
export function getCodexLeaseSnapshot(): {
  mainLease: CodexLease | null
  strategy: CodexLeaseStrategy
  accounts: Array<{
    accountId: string
    leaseCount: number
    holders: string[]
  }>
} {
  const mainLease = [...leases.values()].find(lease => lease.ownerType === 'main') ?? null
  const accounts = getPoolAccountsForLeaseSelection().map(account => ({
    accountId: account.accountId,
    leaseCount: [...leases.values()].filter(lease => lease.accountId === account.accountId).length,
    holders: [...leases.values()]
      .filter(lease => lease.accountId === account.accountId)
      .map(lease => lease.ownerLabel),
  }))
  return {
    mainLease,
    strategy: getDefaultSubagentLeaseStrategy(),
    accounts,
  }
}
```

- [ ] **Step 4: Update the status line to read the main lease account**

```ts
const leaseSnapshot = getCodexLeaseSnapshot()
if (leaseSnapshot.mainLease) {
  return { active_profile: leaseSnapshot.mainLease.ownerLabel === 'main thread'
    ? (getPoolStatus().accounts.find(a => a.accountId === leaseSnapshot.mainLease?.accountId)?.alias ?? leaseSnapshot.mainLease.accountId.slice(0, 12))
    : leaseSnapshot.mainLease.accountId.slice(0, 12) }
}
```

- [ ] **Step 5: Update `/accounts` output to include lease counts and holders**

```ts
const leaseSnapshot = getCodexLeaseSnapshot()
lines.push(`Subagent strategy: ${leaseSnapshot.strategy}`)
lines.push('')
for (const account of leaseSnapshot.accounts) {
  const acct = accounts.find(a => a.accountId === account.accountId)
  if (!acct) continue
  const label = acct.alias ?? acct.accountId.slice(0, 12)
  const holders = account.holders.length > 0 ? `   holders: ${account.holders.join(', ')}` : ''
  lines.push(`  ${label}   leases: ${account.leaseCount}${holders}`)
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with the snapshot shape test succeeding.

- [ ] **Step 7: Commit**

```bash
git add src/components/StatusLine.tsx src/commands/accounts/accounts.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts
git commit -m "feat: surface codex lease state in existing UI"
```

---

### Task 8: Pre-mark capped accounts from usage refresh and preserve main-thread compatibility

**Files:**
- Modify: `src/services/api/codexUsage.ts:97-144,150-154`
- Modify: `src/services/api/codexAccountPool.ts:189-221`
- Test: `src/services/api/codexAccountLeaseManager.test.ts`

- [ ] **Step 1: Write the failing test for usage-based capped marking**

```ts
test('usage refresh marks limit-reached accounts as capped before lease selection', () => {
  seedPoolForLeaseTests([
    { accountId: 'main', status: 'healthy', usagePrimary: 10, usageWeekly: 5 },
    { accountId: 'backup1', status: 'healthy', usagePrimary: 15, usageWeekly: 5 },
  ])

  applyUsageHintsForTest([
    {
      accountId: 'backup1',
      allowed: false,
      limitReached: true,
      primaryWindow: { usedPercent: 100 },
      secondaryWindow: { usedPercent: 20 },
    },
  ])

  const lease = acquireCodexLease({
    ownerId: 'agent-x',
    ownerType: 'subagent',
    ownerLabel: 'x',
    strategy: 'spread',
  })

  expect(lease.accountId).toBe('main')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: FAIL because usage refresh does not yet mark capped accounts in pool state.

- [ ] **Step 3: Update usage refresh to mark pool account status from snapshot results**

```ts
for (const usage of results) {
  if (!usage.allowed || usage.limitReached) {
    markPoolAccountStatus(usage.accountId, 'capped', 'Marked capped from wham/usage')
  } else {
    markPoolAccountStatus(usage.accountId, 'healthy')
  }
}
```

- [ ] **Step 4: Keep main-thread turn rotation compatible by switching through the main lease**

```ts
export function selectAccountForTurn(): { from: string; to: string; turns: number } | null {
  const mainLease = getOrCreateMainCodexLease()
  if (!mainLease) return null
  // preserve existing threshold counting, but move only the main lease
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with usage-marked capped accounts excluded during selection.

- [ ] **Step 6: Commit**

```bash
git add src/services/api/codexUsage.ts src/services/api/codexAccountPool.ts src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts src/query.ts
git commit -m "feat: avoid capped codex accounts before first request"
```

---

### Task 9: Run verification for the full slice

**Files:**
- Test: `src/services/api/codexAccountLeaseManager.test.ts`
- Test: `src/utils/providerPromptRegressions.test.ts`

- [ ] **Step 1: Run the targeted lease-manager tests**

Run: `bun test /Users/pt/cat-code/src/services/api/codexAccountLeaseManager.test.ts`
Expected: PASS with all new lease tests green.

- [ ] **Step 2: Run the nearby regression test file**

Run: `bun test /Users/pt/cat-code/src/utils/providerPromptRegressions.test.ts`
Expected: PASS with existing provider-prompt regressions still green.

- [ ] **Step 3: Run a TypeScript-safe project check via build**

Run: `bun run build`
Expected: PASS with no TypeScript or bundling errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/api/codexAccountLeaseManager.ts src/services/api/codexAccountLeaseManager.test.ts src/services/api/codexAccountPool.ts src/services/api/codexUsage.ts src/services/api/client.ts src/services/api/withRetry.ts src/services/api/claude.ts src/tools/AgentTool/AgentTool.tsx src/tasks/LocalAgentTask/LocalAgentTask.tsx src/components/StatusLine.tsx src/commands/accounts/accounts.ts src/utils/settings/types.ts src/query.ts
git commit -m "feat: add lease-based codex account routing for subagents"
```

---

## Self-review

### Spec coverage
- Spawn-time account selection: covered in Tasks 2 and 4.
- Whole-run pinning: covered in Tasks 2 through 6.
- Lease-local failover: covered in Tasks 3 and 5.
- Explicit lease tracking: covered in Tasks 1, 2, 3, and 7.
- Capped-account avoidance before first request: covered in Tasks 2 and 8.
- User visibility: covered in Tasks 6 and 7.
- Strategy setting: covered in Task 1.

### Placeholder scan
- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every code-change step includes concrete code or exact change shape.
- Every verification step includes an exact command and expected outcome.

### Type consistency
- Lease strategy naming is consistent: `spread | follow-main`.
- Owner types are consistent: `main | subagent`.
- The same `codexLeaseOwnerId` and `codexLeaseOwnerType` names are used across client and retry integration.

---

Plan complete and saved to `docs/codex/2026-04-30-subagent-account-leasing-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
