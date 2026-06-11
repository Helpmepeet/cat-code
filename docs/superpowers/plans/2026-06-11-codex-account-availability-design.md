# Codex Account Availability Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating saved `id_token` plan metadata as an availability blocker anywhere. Plan metadata becomes structured facts on `PoolAccount` that a single derived-availability classifier turns into warnings; hard blocks come only from runtime signals (dead auth, runtime caps, fresh blocked live usage). `/accounts`, `/switch-account`, lease selection, and request-time token resolution all consume the classifier.

**Architecture:**
- `PoolAccount.status` carries only auth/runtime state (`healthy` / `dead` / runtime `capped`). Vault load never sets `capped` from plan metadata.
- Plan metadata is stored as raw facts: `planType` and `planExpiresAt` (the raw ISO string from the JWT). No message strings are stored; messages are formatted at the edge. No regex-parsing of `lastError`.
- `getCodexAccountAvailability(account, now)` returns a discriminated union: `{ kind: 'available' } | { kind: 'warned', warnings } | { kind: 'blocked', reason }`. Invalid combinations are unrepresentable.
- Explicit switch is allowed for `available` and `warned` (user intent wins; the warning is shown). Auto-selection (leases, active-account reroll) prefers `available` accounts and uses `warned` ones only when no clean account exists.
- `appendAccount` updates the plan-metadata fields whenever an `id_token` is provided, so login and `/touch-all` refresh reclassify in memory with no restart. Because load never blocks on plan metadata, nothing needs to persist "verified stale" state across restarts.

**Accepted behavior changes (by design):**
- Explicitly switching to an account whose plan really is expired now succeeds with a warning; the next request fails at runtime and the existing runtime-cap handling takes over. One failed request is preferred over a false "not switchable" dead end.
- Auto-failover may route to a warned account when no clean account exists — preferred over failing with "all accounts capped".
- A lease pinned to a blocked account is bypassed at token-resolution time but the lease record itself is not rewritten; lease repair stays with the existing failover/reassign paths.

**Out of scope:** auto-expiring runtime caps via `usageResetAt` (the `reset_at` units from `wham/usage` are unverified); changes to `updateAccountUsageHints` (its existing usage_cap-clearing behavior is untouched).

**Tech Stack:** TypeScript, Bun tests, existing Codex account pool and lease manager modules.

---

## File Structure

- Modify `src/services/api/codexAccountPool.ts`
  - Replace `getVaultPlanHealthFromIdToken`/`VaultPlanHealth` with a `getCodexPlanMetadataFromIdToken` fact parser; add `planType`/`planExpiresAt` to `PoolAccount`; add the availability union and classifier; delegate `isCodexAccountSwitchable`/`isCodexAccountLeaseSelectable` to it; update `appendAccount` and `loadVaultAccounts`; prefer clean accounts in `findLRUHealthy`; remove `plan_expired`/`plan_ineligible` from `PoolAccountStatusReason`.
- Modify `src/services/api/codexTokenRefresh.ts` and `src/codex-core/accounts.ts`
  - Pass the refreshed `id_token` into `appendAccount` so plan metadata updates in memory.
- Modify `src/services/api/codexAccountLeaseManager.ts`
  - Main lease re-checks selectability; spread selection prefers clean over warned.
- Modify `src/services/api/client.ts`
  - Re-check lease-resolved accounts before returning tokens; fall back to `getActiveAccount()` (which returns null when nothing is selectable).
- Modify `src/commands/switch-account/switch-account.ts`
  - Warned switches succeed with a warning line; block reasons come from the classifier.
- Modify `src/services/api/codexUsage.ts`
  - Display derives tags/reasons/warnings from the classifier; delete the `plan_expired` regex special case.
- Modify tests:
  - `src/services/api/codexAccountPool.test.ts`
  - `src/services/api/codexUsage.test.ts`
  - `src/services/api/codexTokenRefresh.test.ts`
  - `src/services/api/codexAccountLeaseManager.test.ts`
  - `src/commands/switch-account/switch-account.test.ts`

Do not create new source files. Tests may be added only to the existing test files listed above.

Do not commit during execution unless the user explicitly asks for commits.

**Canonical warning messages** (used verbatim in code and tests):
- expired: `saved plan metadata says expired (<planExpiresAt>); live usage decides availability`
- ineligible: `saved plan metadata says plan type <planType> is not eligible for Codex; live usage decides availability`

---

### Task 1: Store plan metadata as structured facts

**Files:**
- Modify: `src/services/api/codexAccountPool.test.ts`
- Modify: `src/services/api/codexAccountPool.ts`

- [ ] **Step 1: Write failing parser test and delete the old plan-health tests**

In `src/services/api/codexAccountPool.test.ts`:

1. Delete the two tests `marks expired plus subscriptions capped from id_token claims` and `marks free plans capped from id_token claims` (around lines 305–334). They assert the old `VaultPlanHealth` shape, which this task removes. Keep the local `createIdToken` helper they use.
2. Add in their place:

```ts
test('extracts plan metadata facts from id_token claims', () => {
  expect(
    getCodexPlanMetadataFromIdToken(
      createIdToken({
        chatgpt_plan_type: 'Plus',
        chatgpt_subscription_active_until: '2026-04-12T03:30:01+00:00',
      }),
    ),
  ).toEqual({ planType: 'plus', planExpiresAt: '2026-04-12T03:30:01+00:00' })

  expect(getCodexPlanMetadataFromIdToken(undefined)).toEqual({})
  expect(getCodexPlanMetadataFromIdToken('not-a-jwt')).toEqual({})
})
```

3. Replace `getVaultPlanHealthFromIdToken` with `getCodexPlanMetadataFromIdToken` in the import list.
4. In the local `buildPoolAccount` helper, add after the `statusReason` line:

```ts
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts
```

Expected: FAIL — `getCodexPlanMetadataFromIdToken` does not exist.

- [ ] **Step 3: Implement the fact parser and fields**

In `src/services/api/codexAccountPool.ts`:

1. Add to `PoolAccount` after `usageResetAt?: number`:

```ts
  // Saved id_token plan metadata. May be stale — warning only, never a blocker.
  planType?: string
  planExpiresAt?: string        // raw ISO string from chatgpt_subscription_active_until
```

2. Replace `getVaultPlanHealthFromIdToken` and the `VaultPlanHealth` type entirely with:

```ts
export type CodexPlanMetadata = {
  planType?: string
  planExpiresAt?: string
}

export function getCodexPlanMetadataFromIdToken(
  idToken: string | undefined,
): CodexPlanMetadata {
  if (!idToken) return {}
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    ) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const planType = typeof auth?.chatgpt_plan_type === 'string'
      ? auth.chatgpt_plan_type.toLowerCase()
      : undefined
    const planExpiresAt = typeof auth?.chatgpt_subscription_active_until === 'string'
      ? auth.chatgpt_subscription_active_until
      : undefined
    return {
      ...(planType ? { planType } : {}),
      ...(planExpiresAt ? { planExpiresAt } : {}),
    }
  } catch {
    return {}
  }
}
```

3. In `loadVaultAccounts()` (the `results.push` around line 931), stop deriving status from plan health. Replace the `planHealth`/`status` computation and the conditional `lastError`/`statusReason` spreads with:

```ts
      const status = checkAccountHealth(lastRefresh)
      const planMetadata = getCodexPlanMetadataFromIdToken(
        typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
      )

      results.push({
        accountId,
        accessToken: String(tokens.access_token),
        refreshToken: String(tokens.refresh_token),
        expiresAt,
        source: 'vault',
        status,
        lastUsedAt: 0,
        lastRefreshIso: lastRefresh,
        vaultFilePath: join(accountsDir, file),
        alias: typeof data.alias === 'string' && data.alias ? data.alias : undefined,
        planType: planMetadata.planType,
        planExpiresAt: planMetadata.planExpiresAt,
        ...(status === 'dead'
          ? { lastError: 'Token expired (>7 days since last refresh)', statusReason: 'auth_dead' as const }
          : {}),
      })
```

4. In `appendAccount()`, apply plan metadata in both branches whenever `tokens.idToken` is provided (when absent, leave the existing fields untouched — last-known metadata stands). In the update branch (after the `vaultFilePath` line):

```ts
    if (tokens.idToken) {
      const planMetadata = getCodexPlanMetadataFromIdToken(tokens.idToken)
      acct.planType = planMetadata.planType
      acct.planExpiresAt = planMetadata.planExpiresAt
    }
```

In the push branch, add to the new account object:

```ts
      ...(tokens.idToken ? getCodexPlanMetadataFromIdToken(tokens.idToken) : {}),
```

- [ ] **Step 4: Add an appendAccount metadata test and run**

In `src/services/api/codexAccountPool.test.ts`:

```ts
test('appendAccount updates plan metadata facts from a provided id_token', () => {
  seedCodexAccountPoolForTest({
    accounts: [
      buildPoolAccount({ accountId: 'acct-1', planType: 'plus', planExpiresAt: '2020-01-01T00:00:00.000Z' }),
    ],
  })

  appendAccount(
    {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct-1',
      idToken: createIdToken({
        chatgpt_plan_type: 'plus',
        chatgpt_subscription_active_until: '2999-01-01T00:00:00.000Z',
      }),
    },
    { preserveCapped: true, writer: 'test' },
  )

  const account = getPoolStatus().accounts[0]!
  expect(account.planType).toBe('plus')
  expect(account.planExpiresAt).toBe('2999-01-01T00:00:00.000Z')
})
```

Run:

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts
```

Expected: PASS.

---

### Task 2: Derived availability classifier

**Files:**
- Modify: `src/services/api/codexAccountPool.test.ts`
- Modify: `src/services/api/codexAccountPool.ts`

- [ ] **Step 1: Write failing classifier tests**

Add a `describe('codexAccountPool availability', () => { ... })` block in `src/services/api/codexAccountPool.test.ts`:

```ts
const NOW = Date.parse('2026-04-21T00:00:00+00:00')

test('expired plan metadata is a warning, not a blocker', () => {
  const account = buildPoolAccount({
    accountId: 'plan-account',
    planType: 'plus',
    planExpiresAt: '2026-04-12T03:30:01+00:00',
  })

  expect(getCodexAccountAvailability(account, NOW)).toEqual({
    kind: 'warned',
    warnings: [
      {
        code: 'plan_metadata_expired',
        message: 'saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
      },
    ],
  })
  expect(isCodexAccountSwitchable(account, NOW)).toBe(true)
  expect(isCodexAccountLeaseSelectable(account, NOW)).toBe(true)
})

test('free plan metadata is a warning, not a blocker', () => {
  const account = buildPoolAccount({ accountId: 'free-account', planType: 'free' })

  expect(getCodexAccountAvailability(account, NOW)).toEqual({
    kind: 'warned',
    warnings: [
      {
        code: 'plan_metadata_ineligible',
        message: 'saved plan metadata says plan type free is not eligible for Codex; live usage decides availability',
      },
    ],
  })
})

test('future plan expiry is available with no warnings', () => {
  const account = buildPoolAccount({
    accountId: 'ok-account',
    planType: 'plus',
    planExpiresAt: '2999-01-01T00:00:00.000Z',
  })

  expect(getCodexAccountAvailability(account, NOW)).toEqual({ kind: 'available' })
})

test('runtime caps are blocked regardless of plan metadata', () => {
  const account = buildPoolAccount({
    accountId: 'capped-account',
    status: 'capped',
    statusReason: 'usage_cap',
    lastError: 'Usage cap hit (429)',
  })

  expect(getCodexAccountAvailability(account, NOW)).toEqual({
    kind: 'blocked',
    reason: 'Usage cap hit (429)',
  })
  expect(isCodexAccountSwitchable(account, NOW)).toBe(false)
})

test('dead auth is blocked', () => {
  const account = buildPoolAccount({
    accountId: 'dead-account',
    status: 'dead',
    statusReason: 'auth_dead',
    lastError: 'Token expired (>7 days since last refresh)',
  })

  expect(getCodexAccountAvailability(account, NOW)).toEqual({
    kind: 'blocked',
    reason: 'Token expired (>7 days since last refresh)',
  })
})

test('fresh blocked usage hints block a healthy account; stale hints do not', () => {
  const freshBlocked = buildPoolAccount({
    accountId: 'fresh-blocked',
    usageAllowed: false,
    usageLimitReached: true,
    usageFetchedAt: NOW - 1_000,
  })
  expect(getCodexAccountAvailability(freshBlocked, NOW)).toEqual({
    kind: 'blocked',
    reason: 'fresh usage data reports this account is capped',
  })

  const staleBlocked = buildPoolAccount({
    accountId: 'stale-blocked',
    usageAllowed: false,
    usageLimitReached: true,
    usageFetchedAt: NOW - 10 * 60 * 1000,
  })
  expect(getCodexAccountAvailability(staleBlocked, NOW)).toEqual({ kind: 'available' })
})
```

Add `getCodexAccountAvailability` to the import list.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts
```

Expected: FAIL — `getCodexAccountAvailability` does not exist.

- [ ] **Step 3: Implement the classifier and delegate the predicates**

In `src/services/api/codexAccountPool.ts`, near `isCodexAccountSwitchable()`:

```ts
export type CodexAccountAvailabilityWarningCode =
  | 'plan_metadata_expired'
  | 'plan_metadata_ineligible'

export type CodexAccountAvailabilityWarning = {
  code: CodexAccountAvailabilityWarningCode
  message: string
}

export type CodexAccountAvailability =
  | { kind: 'available' }
  | { kind: 'warned'; warnings: CodexAccountAvailabilityWarning[] }
  | { kind: 'blocked'; reason: string }

function getPlanMetadataWarnings(
  account: PoolAccount,
  now: number,
): CodexAccountAvailabilityWarning[] {
  const warnings: CodexAccountAvailabilityWarning[] = []
  if (account.planType === 'free') {
    warnings.push({
      code: 'plan_metadata_ineligible',
      message: `saved plan metadata says plan type ${account.planType} is not eligible for Codex; live usage decides availability`,
    })
  }
  const expiresAtMs = account.planExpiresAt ? Date.parse(account.planExpiresAt) : Number.NaN
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    warnings.push({
      code: 'plan_metadata_expired',
      message: `saved plan metadata says expired (${account.planExpiresAt}); live usage decides availability`,
    })
  }
  return warnings
}

export function getCodexAccountAvailability(
  account: PoolAccount,
  now = Date.now(),
): CodexAccountAvailability {
  if (account.status === 'dead') {
    return { kind: 'blocked', reason: account.lastError ?? 'account auth is unavailable' }
  }
  if (account.status === 'capped') {
    return { kind: 'blocked', reason: account.lastError ?? 'account is capped' }
  }
  if (
    hasFreshPoolAccountUsageHint(account, now) &&
    (account.usageAllowed === false || account.usageLimitReached === true)
  ) {
    return { kind: 'blocked', reason: 'fresh usage data reports this account is capped' }
  }

  const warnings = getPlanMetadataWarnings(account, now)
  return warnings.length > 0 ? { kind: 'warned', warnings } : { kind: 'available' }
}
```

Replace the bodies of the existing predicates:

```ts
export function isCodexAccountSwitchable(
  account: PoolAccount,
  now = Date.now(),
): boolean {
  return getCodexAccountAvailability(account, now).kind !== 'blocked'
}

export function isCodexAccountLeaseSelectable(
  account: PoolAccount,
  now = Date.now(),
): boolean {
  return getCodexAccountAvailability(account, now).kind !== 'blocked'
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts
```

Expected: PASS, including all pre-existing pool tests. (Tests that directly seed `status: 'capped', statusReason: 'plan_expired'` still see `blocked` via the generic capped branch; they are migrated in Task 8.)

---

### Task 3: Refresh and login update plan metadata in memory

**Files:**
- Modify: `src/services/api/codexTokenRefresh.test.ts`
- Modify: `src/services/api/codexTokenRefresh.ts`
- Modify: `src/codex-core/accounts.ts`

- [ ] **Step 1: Write failing refresh test**

In `src/services/api/codexTokenRefresh.test.ts`:

1. The local `buildPoolAccount` helper (lines 24–44) does **not** copy `statusReason`, `usageAllowed`, `usageLimitReached`, `planType`, or `planExpiresAt`. Add all five to the copied fields. This matters: seeds silently drop omitted fields otherwise.
2. There is no `createIdToken` helper in this file. Copy the `createIdToken` helper from `codexAccountPool.test.ts` into this file (same base64url JWT construction as the local `createAccessToken`).
3. Add this test, following the file's existing pattern of `mkdtempSync` temp dirs and inline `globalThis.fetch` stubbing (see the test at line 66 for the shape — there are no shared `mockTokenRefreshResponse`/`tempAccountsDir` helpers):

```ts
test('refresh updates plan metadata facts from a fresh id_token without restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-test-'))
  const accountsDir = join(dir, 'accounts')
  mkdirSync(accountsDir, { recursive: true })

  const accountId = '78c15115-7a20-4568-9aec-cfa886dd71ae'
  const filePath = join(accountsDir, `${accountId}.json`)
  writeFileSync(
    filePath,
    JSON.stringify({
      tokens: {
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
    }),
    'utf-8',
  )

  seedCodexAccountPoolForTest({
    activeAccountId: accountId,
    accounts: [
      buildPoolAccount({
        accountId,
        refreshToken: 'old-refresh',
        vaultFilePath: filePath,
        planType: 'plus',
        planExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
  })

  const freshIdToken = createIdToken({
    chatgpt_plan_type: 'plus',
    chatgpt_subscription_active_until: '2999-01-01T00:00:00.000Z',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        access_token: createAccessToken(accountId),
        refresh_token: 'new-refresh',
        expires_in: 3600,
        id_token: freshIdToken,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  try {
    await refreshAccountTokens(accountId, 'old-refresh', filePath)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }

  const account = getPoolStatus().accounts[0]!
  expect(account.planExpiresAt).toBe('2999-01-01T00:00:00.000Z')
  expect(getCodexAccountAvailability(account)).toEqual({ kind: 'available' })
})
```

Import `getCodexAccountAvailability` from `./codexAccountPool.js`. Match `refreshAccountTokens`'s real signature against the existing tests in this file before running.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexTokenRefresh.test.ts
```

Expected: FAIL — `appendAccount` is called without `idToken`, so `planExpiresAt` keeps the stale seed value.

- [ ] **Step 3: Pass the refreshed id_token into appendAccount**

1. In `src/services/api/codexTokenRefresh.ts`, both `appendAccount` calls (identity-mismatch path ~line 215 and same-account path ~line 273) have `newIdToken` in scope. Add to each token object:

```ts
        idToken: newIdToken,
```

2. In `src/codex-core/accounts.ts`, the `appendAccount` call at ~line 184 uses the result of a refresh. Inspect the `refreshed` object's type (it comes from `refreshAccountTokens`, which returns `idToken`); add `idToken: refreshed.idToken || undefined` to the token object, using the actual field name.

3. `src/components/ConsoleOAuthFlow.tsx` line 192 already spreads `codexTokens`, and `CodexTokens.idToken` exists — login already passes it. Verify, do not change.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexTokenRefresh.test.ts src/services/api/codexAccountPool.test.ts
```

Expected: PASS.

---

### Task 4: Auto-selection prefers clean accounts over warned ones

**Files:**
- Modify: `src/services/api/codexAccountLeaseManager.test.ts`
- Modify: `src/services/api/codexAccountLeaseManager.ts`
- Modify: `src/services/api/codexAccountPool.ts`

- [ ] **Step 1: Write failing lease tests**

In `src/services/api/codexAccountLeaseManager.test.ts`, following the file's existing `moduleUnderTest.createCodexLeaseForTest` pattern and its `buildPoolAccount` helper (add `planType`/`planExpiresAt` to that helper's copied fields first):

```ts
test('main-thread lease skips a blocked active account', () => {
  seedCodexAccountPoolForTest({
    activeAccountId: 'active-capped',
    accounts: [
      buildPoolAccount({
        accountId: 'active-capped',
        alias: 'active',
        usageAllowed: false,
        usageLimitReached: true,
        usageFetchedAt: Date.now(),
      }),
      buildPoolAccount({ accountId: 'backup-clean', alias: 'backup' }),
    ],
  })

  const lease = moduleUnderTest.createCodexLeaseForTest({
    ownerId: 'main-thread',
    ownerType: 'main',
    ownerLabel: 'main thread',
  })

  expect(lease.accountId).toBe('backup-clean')
})

test('spread lease prefers a clean account over a warned one', () => {
  seedCodexAccountPoolForTest({
    activeAccountId: 'warned-account',
    accounts: [
      buildPoolAccount({
        accountId: 'warned-account',
        alias: 'warned',
        planType: 'plus',
        planExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
      buildPoolAccount({ accountId: 'clean-account', alias: 'clean' }),
    ],
  })

  const lease = moduleUnderTest.createCodexLeaseForTest({
    ownerId: 'agent-1',
    ownerType: 'subagent',
    ownerLabel: 'agent 1',
    strategy: 'spread',
  })

  expect(lease.accountId).toBe('clean-account')
})

test('spread lease uses a warned account when no clean account exists', () => {
  seedCodexAccountPoolForTest({
    activeAccountId: 'warned-account',
    accounts: [
      buildPoolAccount({
        accountId: 'warned-account',
        alias: 'warned',
        planType: 'plus',
        planExpiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
  })

  const lease = moduleUnderTest.createCodexLeaseForTest({
    ownerId: 'agent-2',
    ownerType: 'subagent',
    ownerLabel: 'agent 2',
    strategy: 'spread',
  })

  expect(lease.accountId).toBe('warned-account')
})
```

Adapt setup/teardown (provider, pool reset) to match neighboring tests in the file.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountLeaseManager.test.ts
```

Expected: FAIL — `selectMainAccountForLease()` returns the activeIndex account without checking selectability. (The spread-prefers-clean test may already pass via usage-score ranking; if it passes, keep it as a regression test and note that.)

- [ ] **Step 3: Update lease selection**

In `src/services/api/codexAccountLeaseManager.ts`, import `getCodexAccountAvailability` from `./codexAccountPool.js`.

Replace `selectMainAccountForLease()`:

```ts
function selectMainAccountForLease(): { account: PoolAccount; reason: string } {
  const pool = getPoolStatus()
  if (!pool.initialized || pool.accounts.length === 0) {
    throw new Error(NO_HEALTHY_ACCOUNTS_ERROR)
  }

  const active = pool.activeIndex >= 0 ? pool.accounts[pool.activeIndex] : undefined
  if (active && isCodexAccountLeaseSelectable(active)) {
    // The user chose this account; a plan-metadata warning does not override that.
    return { account: active, reason: 'main lease pinned to pool activeIndex' }
  }

  const selectable = pool.accounts.filter((account) => isCodexAccountLeaseSelectable(account))
  const replacement =
    selectable.find((account) => getCodexAccountAvailability(account).kind === 'available') ??
    selectable[0]
  if (!replacement) {
    throw new Error(NO_HEALTHY_ACCOUNTS_ERROR)
  }
  return { account: replacement, reason: 'main lease repaired from non-selectable active account' }
}
```

In `selectAccountForLease()`, after the `healthyCandidates.length === 0` throw, narrow the ranked pool to clean accounts when any exist. Keep the follow-main branch searching `healthyCandidates` (the main account wins even when warned), then rank over the narrowed list:

```ts
  const cleanCandidates = healthyCandidates.filter(
    (account) => getCodexAccountAvailability(account).kind === 'available',
  )
  const rankableCandidates = cleanCandidates.length > 0 ? cleanCandidates : healthyCandidates
```

Use `rankableCandidates` in place of `healthyCandidates` in the `hasFreshUsage` check and the `rankedCandidates` sort that follow.

- [ ] **Step 4: Apply the same preference to pool-internal reroll**

In `findLRUHealthy()` in `src/services/api/codexAccountPool.ts`, after building `candidates`, add:

```ts
  const cleanCandidates = candidates.filter(
    (candidate) => getCodexAccountAvailability(candidate.acct, now).kind === 'available',
  )
  const rankable = cleanCandidates.length > 0 ? cleanCandidates : candidates
```

and use `rankable` in place of `candidates` for the fresh-usage check, the sort, and the LRU loop. This path (active-account reroll) is covered indirectly by existing pool tests plus the lease tests above; no dedicated test.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountLeaseManager.test.ts src/services/api/codexAccountPool.test.ts
```

Expected: PASS.

---

### Task 5: Re-check leased accounts at token resolution

**Files:**
- Modify: `src/services/api/codexAccountLeaseManager.test.ts`
- Modify: `src/services/api/client.ts`

- [ ] **Step 1: Write failing token-resolution test**

Decision: the test lives in `src/services/api/codexAccountLeaseManager.test.ts` (no client test file exists; this file already has the pool/lease seeding harness). Import `resolveCodexOAuthTokensForLeaseOwner` from `./client.js`:

```ts
test('token resolution falls back when the leased account is blocked', () => {
  seedCodexAccountPoolForTest({
    activeAccountId: 'backup-clean',
    accounts: [
      buildPoolAccount({
        accountId: 'leased-capped',
        alias: 'leased',
        status: 'capped',
        statusReason: 'usage_cap',
        lastError: 'Usage cap hit (429)',
      }),
      buildPoolAccount({ accountId: 'backup-clean', alias: 'backup' }),
    ],
  })
  seedCodexLeaseForTest(/* pin the main-thread lease to 'leased-capped'; match the helper's real signature, already used by codexTokenRefresh.test.ts */)

  const tokens = resolveCodexOAuthTokensForLeaseOwner({ codexLeaseOwnerType: 'main' })

  expect(tokens?.accountId).toBe('backup-clean')
})
```

Before writing, inspect `seedCodexLeaseForTest`'s signature in `codexAccountLeaseManager.ts` and any provider/session setup the resolver needs (`isPoolActive()` must be true; neighboring tests show the required `setSessionProvider` call if any).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountLeaseManager.test.ts
```

Expected: FAIL — the resolver returns the leased capped account's tokens.

- [ ] **Step 3: Update token resolution**

In `src/services/api/client.ts`, import `isCodexAccountLeaseSelectable` from `./codexAccountPool.js` and replace the `poolAccount` selection (around line 244):

```ts
  const leasedAccount = leasedAccountId
    ? poolAccountById.get(leasedAccountId)
    : null
  const poolAccount =
    leasedAccount && isCodexAccountLeaseSelectable(leasedAccount)
      ? leasedAccount
      : getActiveAccount()
```

Keep the existing `return null` fallback. Notes on intentional behavior: a lease pointing at an account missing from the pool now falls back to the active account instead of returning null; `getActiveAccount()` rerolls away from blocked accounts and returns null when nothing is selectable; the lease record is deliberately not rewritten here.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountLeaseManager.test.ts
```

Expected: PASS.

---

### Task 6: `/switch-account` — warned switches succeed with a warning

**Files:**
- Modify: `src/commands/switch-account/switch-account.test.ts`
- Modify: `src/commands/switch-account/switch-account.ts`

- [ ] **Step 1: Write failing warned-switch test and rewrite the blocked-switch test**

In `src/commands/switch-account/switch-account.test.ts` (the `createCodexAccount` helper spreads overrides, so the new fields pass through):

1. Add:

```ts
test('explicit Codex switch to an account with stale plan metadata succeeds with a warning', async () => {
  setSessionProvider('openai')
  codexPoolModule.seedCodexAccountPoolForTest({
    accounts: [
      createCodexAccount('codex-current', 'current'),
      createCodexAccount('codex-plan', 'plan', 0, {
        planType: 'plus',
        planExpiresAt: '2026-04-12T03:30:01+00:00',
      }),
    ],
    activeAccountId: 'codex-current',
  })

  const result = await call(
    'plan',
    {
      onChangeAPIKey: mock(() => {}),
      setMessages: mock(() => {}),
      setAppState: mock(() => {}),
    } as Parameters<typeof call>[1],
  )

  expect(result?.value).toContain('Switched to plan')
  expect(result?.value).toContain(
    'Warning: saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
  )
})
```

2. Rewrite the existing test `explicit Codex switch reports existing account that is not switchable` (~line 427): plan metadata no longer blocks, so the seed must use a runtime cap. Change the blocked account's overrides to:

```ts
        status: 'capped',
        statusReason: 'usage_cap',
        lastError: 'Usage cap hit (429)',
```

and the reason assertion to:

```ts
    expect(result?.value).toContain('Reason: Usage cap hit (429)')
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/pt/cat-code && bun test src/commands/switch-account/switch-account.test.ts
```

Expected: FAIL — success messages carry no warnings, and `formatCodexAccountBlockReason` still prepends `capped: `.

- [ ] **Step 3: Update switch messaging**

In `src/commands/switch-account/switch-account.ts`, import `getCodexAccountAvailability` from the codexAccountPool module (match the file's existing import style).

In `performCodexSwitch()`, replace the `if (idPrefix)` success return:

```ts
  if (idPrefix) {
    const label = result.alias ?? result.accountId.slice(0, 12)
    const availability = getCodexAccountAvailability(result)
    const warningLines =
      availability.kind === 'warned'
        ? availability.warnings.map((warning) => `Warning: ${warning.message}`)
        : []
    return { type: 'text', value: [`Switched to ${label}`, ...warningLines].join('\n') }
  }
```

Replace `formatCodexAccountBlockReason()` entirely:

```ts
function formatCodexAccountBlockReason(
  account: ReturnType<typeof getPoolStatus>['accounts'][number],
): string {
  const availability = getCodexAccountAvailability(account)
  if (availability.kind === 'blocked') {
    return availability.reason
  }
  return 'account is unavailable for switching'
}
```

(The old `plan_expired` regex branch and the manual usage-fields branch are both superseded by the classifier.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/commands/switch-account/switch-account.test.ts
```

Expected: PASS.

---

### Task 7: `/accounts` display — classifier-driven reasons and warnings

**Files:**
- Modify: `src/services/api/codexUsage.test.ts`
- Modify: `src/services/api/codexUsage.ts`

- [ ] **Step 1: Write failing display tests and rewrite the pinned ones**

In `src/services/api/codexUsage.test.ts` (add `planType`/`planExpiresAt` to this file's `buildPoolAccount` helper first):

1. Add:

```ts
test('formatPoolUsage shows stale plan metadata as a warning on a switchable account', () => {
  seedCodexAccountPoolForTest({
    activeAccountId: 'main-account',
    accounts: [
      buildPoolAccount({
        accountId: 'main-account',
        alias: 'main',
        planType: 'plus',
        planExpiresAt: '2026-04-12T03:30:01+00:00',
      }),
    ],
  })

  const output = formatPoolUsage({
    accounts: [buildUsage('main-account', 1, 72, { allowed: true, limitReached: false })],
    fetchedAt: Date.now(),
    errors: [],
  })

  expect(output).toContain('● main')
  expect(output).not.toContain('[not switchable')
  expect(output).toContain(
    'warning: saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
  )
})
```

2. Rewrite the existing test `formatPoolUsage shows internal capped status even when live usage is available` (~line 705): change the blocked account's seed from `statusReason: 'plan_expired'` to a runtime cap:

```ts
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
```

Keep the `[not switchable: capped] [usage available]` assertion and change the reason assertion to:

```ts
    expect(output).toContain('reason: Usage cap hit (429)')
```

3. In the test `fetchPoolUsage clears only usage-derived capped status when live usage is allowed` (~line 314), the `plan-account` seed exists to prove non-usage caps survive a usage refresh. Re-point it at a runtime reason so the intent survives this redesign: change its seed to `statusReason: 'runtime_cap'`, `lastError: 'Runtime turn failure (429)'`, and the assertions at ~line 387 to expect `statusReason` `'runtime_cap'` (status stays `'capped'`).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexUsage.test.ts
```

Expected: FAIL — no warning lines are printed and the reason line still routes through the `plan_expired` special case.

- [ ] **Step 3: Derive display fields from the classifier**

In `src/services/api/codexUsage.ts`, import `getCodexAccountAvailability` from `./codexAccountPool.js`.

1. Extend `PoolUsageDisplayAccount`:

```ts
  availabilityReason?: string
  availabilityWarnings: string[]
```

2. In `buildPoolUsageDisplayAccounts()`, compute availability once per account and derive both `switchable` and the new fields from it:

```ts
  return poolAccounts.map((account, index) => {
    const availability = getCodexAccountAvailability(account)
    return {
      accountId: account.accountId,
      alias: account.alias,
      isActive: index === activeIndex,
      status: account.status,
      statusReason: account.statusReason,
      lastError: account.lastError,
      switchable: availability.kind !== 'blocked',
      availabilityReason: availability.kind === 'blocked' ? availability.reason : undefined,
      availabilityWarnings:
        availability.kind === 'warned'
          ? availability.warnings.map((warning) => warning.message)
          : [],
      usage: usageById.get(account.accountId) ?? null,
      error: errorById.get(account.accountId) ?? null,
    }
  })
```

3. In `formatPoolUsage()`, replace the reason block:

```ts
    if (account.availabilityReason) {
      lines.push(`  reason: ${account.availabilityReason}`)
    }
    for (const warning of account.availabilityWarnings) {
      lines.push(`  warning: ${warning}`)
    }
```

4. Delete `formatDisplayBlockReason()` (superseded by `availabilityReason`). Leave `formatDisplayStatusTag()` as is — it keys off `switchable` and live usage, which still describe runtime-blocked accounts correctly.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexUsage.test.ts
```

Expected: PASS.

---

### Task 8: Remove the dead plan status reasons

**Files:**
- Modify: `src/services/api/codexAccountPool.ts`
- Modify: any remaining files flagged by the searches below

- [ ] **Step 1: Remove the union members**

In `PoolAccountStatusReason` in `src/services/api/codexAccountPool.ts`, delete `'plan_ineligible'` and `'plan_expired'`. Nothing produces them after Tasks 1–7.

- [ ] **Step 2: Sweep for stale references**

```bash
cd /Users/pt/cat-code && rg -n "plan_expired|plan_ineligible|getVaultPlanHealthFromIdToken|VaultPlanHealth|planMetadataWarning" src
```

Expected: zero hits. Fix any stragglers (likely leftover test seeds). Historical docs under `docs/` may keep the old terms.

- [ ] **Step 3: Type-check via the documented build**

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Expected: PASS and prints a `cli-dev` Cat Code version.

---

### Task 9: Focused verification

**Files:**
- No source edits unless verification exposes a bug.

- [ ] **Step 1: Run focused account tests**

```bash
cd /Users/pt/cat-code && bun test src/services/api/codexAccountPool.test.ts src/services/api/codexUsage.test.ts src/services/api/codexTokenRefresh.test.ts src/services/api/codexAccountLeaseManager.test.ts src/commands/switch-account/switch-account.test.ts src/commands/accounts/accounts.test.ts
```

Expected: PASS.

- [ ] **Step 2: Search for stale hard-block wording**

```bash
cd /Users/pt/cat-code && rg -n "restart Cat Code if it still appears blocked|saved plan metadata says expired \(" src --glob '*.{ts,tsx}'
```

Expected: the only remaining "saved plan metadata says expired" occurrences are the canonical warning message (classifier + tests); the "restart Cat Code" guidance is gone.

- [ ] **Step 3: Review focused diff**

```bash
cd /Users/pt/cat-code && git diff --stat -- src/services/api src/commands/switch-account src/codex-core/accounts.ts
```

Expected: changes confined to Codex availability behavior, tests, and wording — no unrelated refactors.

- [ ] **Step 4: Report verification honestly**

Report these exact categories:

```text
Implemented:
- Plan metadata stored as structured facts; never sets status.
- Derived availability classifier (available / warned / blocked) consumed by switch, accounts display, lease selection, and token resolution.
- Auto-selection prefers clean accounts over warned ones.
- Refresh and login update plan metadata in memory without restart.

Verified:
- <focused test command and result>
- <build command and result>
- <stale-reference search result>

Not verified:
- Full `bun test` unless it was run and passed.
```

Do not claim full repository green unless full `bun test` exits 0 in this worktree.

---

## Self-Review

**Spec coverage:**
- Saved plan metadata never hard-blocks: Task 1 (load), Task 2 (classifier), Task 6 (switch).
- Warnings shown on `/switch-account` success and in `/accounts`: Tasks 6 and 7.
- Auto-selection prefers clean over warned and only falls back to warned: Task 4.
- Leases and request token resolution avoid blocked accounts: Tasks 4 and 5.
- `/touch-all` and login reclassify in memory without restart: Task 3 (plus Task 1's `appendAccount` change).
- Restart resurrection is structurally impossible: load stores facts, never a blocked status (Task 1).
- Runtime auth and quota failures remain hard blockers: Task 2 tests; Task 7 preserves the usage-refresh test's runtime-cap intent.

**Known traps this plan routes around:**
- `codexTokenRefresh.test.ts`'s `buildPoolAccount` omits `statusReason`/usage fields — Task 3 Step 1 fixes the builder before seeding.
- `createIdToken`/fetch-mock helpers do not exist in the refresh test file — Task 3 says to copy/build them following the file's existing patterns.
- `resolveCodexOAuthTokensForLeaseOwner` has no existing test home — Task 5 places its test in the lease-manager test file explicitly.
- Two existing tests pin wording the redesign changes (`switch-account.test.ts` ~427, `codexUsage.test.ts` ~705) and one pins plan-cap survival semantics (`codexUsage.test.ts` ~314) — Tasks 6 and 7 rewrite them explicitly.

**Type consistency:**
- `CodexAccountAvailability` is a discriminated union; `reason` exists only on `blocked`, `warnings` only on `warned`.
- `planType`/`planExpiresAt` are introduced once on `PoolAccount` (Task 1) and reused everywhere; warning text is formatted only inside `getPlanMetadataWarnings`.
- `isCodexAccountSwitchable` and `isCodexAccountLeaseSelectable` are both `kind !== 'blocked'`; they remain separate exports so future policy can diverge without another consumer migration.
