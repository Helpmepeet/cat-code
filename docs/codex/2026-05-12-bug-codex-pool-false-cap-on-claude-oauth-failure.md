# Bug: Codex pool falsely caps accounts after Claude OAuth connection errors

## Executive summary

A Cat Code session appeared to stop responding after a later request in the run. The visible symptom looked like a stalled chat: user prompts were accepted and recorded, but no assistant reply appeared.

The first obvious error in the debug log was:

```text
All Codex accounts are capped or unavailable
```

That wording is misleading if read as provider truth. The investigation did **not** find evidence that the user's real Codex/OpenAI accounts were all exhausted. Instead, the strongest supported diagnosis is:

```text
Cat Code converted Anthropic Claude OAuth / small-model connection failures into Codex account-cap state. That poisoned the local in-memory Codex account pool. Later prompts failed account selection, and the REPL logged the error without rendering a visible chat message.
```

The session started on Codex profile `account-a`, successfully routed GPT/Codex requests through `account-a`, then failed over away from `account-a` after a Claude OAuth refresh error against `https://platform.claude.com/v1/oauth/token`. Actual routed requests later used `account-e`, while the footer continued showing `account-a` for a while. Eventually local pool state reached a point where fresh account selection reported no healthy accounts.

This document intentionally records only what was observed in the transcript, debug log, and source code during the investigation. Items that remain uncertain are listed separately.

## Primary artifacts

Debug log (sanitized placeholder):

```text
$HOME/project/debug/synthetic-session-a.txt
```

Transcript (sanitized placeholder):

```text
$HOME/project/transcripts/synthetic-session-a.jsonl
```

Documentation file created from the investigation:

```text
docs/codex/2026-05-12-bug-codex-pool-false-cap-on-claude-oauth-failure.md
```

## Glossary for future readers

- **Codex pool**: Cat Code's in-process pool of saved Codex/OpenAI accounts.
- **Vault profile / account alias**: Human-readable labels such as `account-a` through `account-e` mapped to account IDs in the Codex vault.
- **Main-thread lease**: The Codex lease used by the main chat thread. It can be reassigned across accounts on failover.
- **Capped**: Cat Code local status for an account believed to have hit a cap. In this bug, generic connection errors appear to have produced this status without a confirmed provider cap.
- **Existing lease routing**: Existing leases may still point at account IDs and route requests even if later pool health state changes.
- **Fresh selection**: Code path that picks a healthy account from the pool. This can fail if all pool accounts are marked `capped` or unavailable.

## Synthetic account mapping used in this report

The investigation printed only non-secret metadata from the Codex vault. Tokens were not printed. The real labels and IDs are replaced here with neutral names and synthetic IDs.

```text
account-a -> acct-a-001
account-b -> acct-b-002
account-c -> acct-c-003
account-d -> acct-d-004
account-e -> acct-e-005
```

The old session began with:

```text
Switched to account-a
```

So the user was initially on the `account-a` Codex profile.

## User-visible symptom

After the last visible assistant response, the user submitted several more prompts. The transcript recorded the prompts, but no assistant response followed. From the user's point of view, the session looked stalled or unresponsive.

The debug log shows the prompts did enter the normal query path and failed quickly. This was not proven to be an infinite loop or a blocked query guard.

## High-level timeline

| Sequence | What happened | Sanitized evidence |
| --- | --- | --- |
| Early in the run | Local command switched the session to `account-a`. | `Switched to account-a` |
| Before the failure | GPT/Codex requests succeeded through `account-a`. | `owner=main-thread account=acct-a-001 model=gpt-5.5` |
| Trigger point | Claude small-model OAuth refresh returned HTTP 400. | `platform.claude.com/v1/oauth/token,status=400` |
| Immediate retry sequence | A generic connection error caused lease reassignment. | `account-a -> account-b -> account-c -> account-d -> account-e` |
| After failover | GPT/Codex traffic used `account-e`; the footer still displayed `account-a`. | `owner=main-thread account=acct-e-005 model=gpt-5.5` |
| Later prompts | Fresh account selection failed. | `All Codex accounts are capped or unavailable` |

## Detailed timeline and evidence

### 1. `account-a` was used successfully

The session successfully routed GPT/Codex traffic through `account-a` / `acct-a-001` earlier in the run:

```text
[codex-cache] request account=acct-a-001 model=gpt-5.5
[codex-cache] owner=main-thread account=acct-a-001 model=gpt-5.5
```

Later successful `account-a` usage continued:

```text
[codex-cache] owner=main-thread account=acct-a-001 model=gpt-5.5
[codex-cache] owner=main-thread account=acct-a-001 model=gpt-5.5
```

A per-account timeline found many `acct-a-001` routing entries before the failover and no routed `account-a` requests after the failover.

This means `account-a` was not dead from session start. It served real GPT/Codex traffic successfully.

### 2. A Claude small-model / OAuth path failed

Immediately before the failover cascade, the debug log shows a Claude small-model path:

```text
Tool search disabled for model 'claude-haiku-4-5-20251001': model does not support tool_reference blocks.
Cached MC gate: enabled=false modelSupported=false model=claude-haiku-4-5-20251001
```

Then Claude OAuth refresh failed:

```text
[ERROR] AxiosError: [url=https://platform.claude.com/v1/oauth/token,status=400] AxiosError: Request failed with status code 400
```

The retry layer then logged a generic connection error:

```text
[ERROR] API error (attempt 1/6): undefined Connection error.
```

This is important because the immediate failing endpoint in the log is Anthropic Claude OAuth, not an OpenAI/Codex endpoint.

### 3. Codex failover ran on that generic connection error

On retry attempts, Cat Code reassigned the main-thread Codex lease across multiple accounts:

```text
[codex-pool] Reassigned lease main-thread from acct-a-001 to acct-b-002 on connection error
[codex-pool] Reassigned lease main-thread from acct-b-002 to acct-c-003 on connection error
[codex-pool] Reassigned lease main-thread from acct-c-003 to acct-d-004 on connection error
[codex-pool] Reassigned lease main-thread from acct-d-004 to acct-e-005 on connection error
```

Expanded with aliases:

```text
account-a -> account-b on connection error
account-b -> account-c on connection error
account-c -> account-d on connection error
account-d -> account-e on connection error
```

The observed behavior is suspicious because the trigger was a generic connection error immediately following a Claude OAuth refresh failure.

### 4. Actual routing moved from `account-a` to `account-e`

After the failover cascade, actual routed GPT/Codex traffic moved to `account-e` / `acct-e-005`:

```text
account_id=acct-e-005 model=gpt-5.5 completed=true
account_id=acct-e-005 model=gpt-5.5 completed=true
account_id=acct-e-005 model=gpt-5.5 completed=true
```

The debug log also shows main-thread ownership on `account-e` near the end of successful operation:

```text
[codex-cache] owner=main-thread account=acct-e-005 model=gpt-5.5
[codex-cache] owner=main-thread account=acct-e-005 model=gpt-5.5
[codex-cache] owner=main-thread account=acct-e-005 model=gpt-5.5
```

This resolves one of the main contradictions in the investigation: if `account-a` had been marked capped, the same process should stop using it. The logs show exactly that. The process stopped routing through `account-a` after failover and used `account-e` instead.

### 5. The footer/status line was stale or misleading

Even after routing had moved to `account-e`, debug screen samples continued to show:

```text
GPT 5.5 · high · account-a
```

The footer made it look like the user was still talking through `account-a`, while actual request-routing logs showed `account-e`. For this incident, request-routing logs are more authoritative than footer text.

### 6. Later prompts failed without visible assistant output

A later user prompt entered normal query handling.

Then failed immediately:

```text
[REPL:onQuery] onQueryImpl error: All Codex accounts are capped or unavailable
```

The query guard cleaned up:

```text
[QueryGuard] end -> idle generation=<synthetic-generation>
[REPL:onQuery] cleanup for generation=<synthetic-generation>
[REPL:onQuery] finally complete generation=<synthetic-generation>
```

The API retry path also logged:

```text
No valid Codex (OpenAI) account found. All accounts may have hit their usage limit. Use /switch-account to switch to another account, or /accounts to check status.
```

The same failure pattern repeated for later prompts.

The session did not appear to be stuck in an infinite running state. It accepted prompts, failed, cleaned up, and returned idle, but did not show the user a useful visible error message.

## What was not found

A full debug-log scan did not find direct provider-side cap evidence for `account-a` or all accounts.

No matches were found for real cap markers such as:

```text
CodexAccountCapError
Usage cap hit
Account ... capped
[codex-pool] All accounts exhausted
API error ... 429
status=429
Codex API error ... 429
```

There were occurrences of phrases like `usage limit`, but those came from Cat Code's downstream error text:

```text
No valid Codex (OpenAI) account found. All accounts may have hit their usage limit.
```

That message reflects local account-resolution failure. It is not itself proof that a provider reported quota exhaustion.

## Important corrections made during the investigation

### Correction 1: Do not equate local pool exhaustion with real account exhaustion

The initial interpretation was too strong. The evidence does not prove that `account-a`, or all accounts, were truly exhausted at the provider level.

The precise statement is:

```text
Cat Code's local in-memory Codex pool believed all accounts were capped or unavailable.
```

That local state appears to have been produced by retry/failover logic.

### Correction 2: The user was not necessarily still talking through `account-a`

The footer showed `account-a`, but actual routing logs showed traffic moved to `account-e`.

So the statement “we were still talking on account-a” was true from the UI perspective but not from the request-routing evidence.

### Correction 3: `account-e` may have been poisoned later even if existing routes still succeeded

A later verifier pointed out an important mechanism:

- `failoverCodexLease()` marks the current account capped before replacement selection succeeds.
- If selection fails and the caller swallows the error, the account can remain locally capped.
- Existing leases may still route through stale account IDs even after local pool health says the account is capped.
- A fresh selection later sees no healthy accounts and fails.

This explains how `account-e` could continue serving existing-routed requests and still leave the pool in a poisoned state for the next fresh account selection.

This exact moment for `account-e` being marked capped was not directly logged as `Account account-e capped`; it is inferred from code behavior and the later `All Codex accounts are capped or unavailable` failure. The inference is plausible and consistent with the code, but it is not backed by a direct `markPoolAccountCapped(account-e)` log line.

## Code path analysis

### `src/services/api/withRetry.ts`: connection-error failover is too broad

The connection-error failover branch is gated by:

```ts
if (
  error instanceof APIConnectionError &&
  isPoolActive() &&
  attempt >= 2
) {
  const currentLease =
    getCurrentCodexLease() ??
    (options.ownerId ? getCodexLeaseForOwner(options.ownerId) : undefined)
  const accountId = currentLease?.accountId ?? getActiveAccount()?.accountId
  if (accountId) {
    if (currentLease) {
      try {
        const nextLease = failoverCodexLease(
          currentLease.ownerId,
          accountId,
          error.message,
        )
        logForDebugging(
          `[codex-pool] Reassigned lease ${currentLease.ownerId} from ${accountId} to ${nextLease.accountId} on connection error`,
        )
        options.onCodexAccountSwitch?.()
        client = null
        continue
      } catch {
        // Fall through — pool exhausted, let normal retry exhaust too
      }
    } else {
      markPoolAccountCapped(accountId, error.message)
      const next = switchToAccount(null)
      if (next) {
        logForDebugging(
          `[codex-pool] Main session rotated from ${accountId} to ${next.accountId} on connection error`,
        )
        options.onCodexAccountSwitch?.()
        client = null
        continue
      }
    }
  }
}
```

The condition checks:

- the error is an `APIConnectionError`
- the Codex pool is active
- the retry attempt is at least 2

It does **not** verify that the failing request actually used:

- a Codex token
- `createCodexFetch`
- an OpenAI/Codex provider route
- the current Codex lease

So a generic connection error from a Claude-side call can affect Codex account health if the Codex pool is active.

### `src/services/api/codexAccountLeaseManager.ts`: failover mutates before replacement is guaranteed

`failoverCodexLease()` marks the current account as failed/capped before selecting the replacement:

```ts
markPoolAccountLastError(existingLease.accountId)
markPoolAccountCapped(existingLease.accountId, reason)

try {
  const selection = selectAccountForLease(existingLease.strategy)
  const replacementLease: CodexLease = {
    ...existingLease,
    accountId: selection.account.accountId,
    state: 'active',
    failoverCount: existingLease.failoverCount + 1,
    selectionReason: `failover from ${failedAccountId}: ${reason}`,
    lastFailureReason: reason,
    updatedAt: Date.now(),
  }

  codexLeasesByOwnerId.set(ownerId, replacementLease)
  setActiveAccount(selection.account.accountId)
  touchPoolAccountUsage(selection.account.accountId)
  return replacementLease
} catch (error) {
  const failedLease: CodexLease = {
    ...existingLease,
    state: 'failed',
    failoverCount: existingLease.failoverCount + 1,
    lastFailureReason: reason,
    updatedAt: Date.now(),
  }

  codexLeasesByOwnerId.set(ownerId, failedLease)
  throw error
}
```

If replacement selection throws, the account has already been marked capped. The caller can catch and swallow the selection failure, leaving the account status mutated.

### `src/services/api/codexAccountPool.ts`: generic connection error becomes cap state

`markPoolAccountCapped()` sets a cap-like state:

```ts
export function markPoolAccountCapped(accountId: string, reason: string): void {
  markPoolAccountStatus(accountId, 'capped', reason)

  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  acct.usagePrimary = 100
}
```

A generic connection error can therefore produce the same local status as a real quota cap:

```text
status = capped
usagePrimary = 100
lastError = Connection error.
```

That local state is materially different from provider truth.

### `src/services/api/claude.ts`: retry owner can be attached by global provider/pool state

`getRetryOwnerId()` returns `main-thread` when the global provider is OpenAI and the pool is active:

```ts
export function getRetryOwnerId(options: Pick<Options, 'agentId'>): string | undefined {
  if (options.agentId) {
    return options.agentId
  }

  if (getAPIProvider() === 'openai' && isPoolActive()) {
    return 'main-thread'
  }

  return undefined
}
```

This appears to be part of how Codex retry ownership can be present even when the immediate failure is a generic `APIConnectionError` from a Claude-side OAuth path. The key risk is coupling retry ownership to global provider/pool state instead of to the actual client/fetch path used by the failing request.

### `src/screens/REPL.tsx`: error is logged and rethrown

The REPL catch logs the error and rethrows it:

```ts
try {
  await onQueryImpl(latestMessages, newMessages, abortController, shouldQuery, additionalAllowedTools, mainLoopModelParam, effort)
} catch (error) {
  logForDebugging(`[REPL:onQuery] onQueryImpl error: ${errorMessage(error)}`)
  logError(error)
  throw error
}
```

In this incident, no visible assistant/system message was appended before the failure unwound.

### `src/utils/handlePromptSubmit.ts`: no visible error append at the await site

`handlePromptSubmit` awaits `onQuery(...)`:

```ts
await onQuery(
  newMessages,
  abortController,
  shouldQuery,
  allowedTools ?? [],
  model
    ? resolveSkillModelOverride(model, mainLoopModel)
    : mainLoopModel,
  shouldCallBeforeQuery ? onBeforeQuery : undefined,
  primaryInput,
  effort,
)
```

The investigated failure path did not append a transcript-visible error response. The user prompt remained recorded, query cleanup happened, and the user saw no assistant reply.

### `src/components/StatusLine.tsx`: profile display depends on snapshots but not necessarily failover refresh

The status line derives active profile from the Codex lease snapshot or active pool account:

```ts
const leaseSnapshot = getCodexLeaseSnapshot()
const pool = getPoolStatus()
const mainLease = leaseSnapshot.mainLease
if (mainLease) {
  const acct = pool.accounts.find((a) => a.accountId === mainLease.accountId)
  return {
    active_profile: acct?.alias ?? mainLease.accountId.slice(0, 12),
  }
}
```

The observed footer stayed on `account-a` after actual routing had moved to `account-e`. The likely issue is not the snapshot calculation itself, but that lease failover did not force a status-line re-render at the right time.

## State model that explains the incident

The incident makes more sense if these states are kept separate:

1. **Provider reality**: whether OpenAI/Codex actually capped an account.
2. **Vault metadata**: saved profile files on disk.
3. **In-memory pool health**: Cat Code process-local account status, such as `healthy`, `capped`, or `dead`.
4. **Lease routing**: account IDs currently held by main-thread or subagent leases.
5. **Footer display**: rendered profile label in the UI.

The bug happened because these states diverged:

- Provider reality did not show a confirmed Codex cap.
- Vault metadata for `account-a` did not show a durable cap marker in the non-secret fields inspected.
- In-memory pool health was mutated to cap accounts due to connection errors.
- Lease routing moved from `account-a` to `account-e` and existing routes kept working.
- Footer display continued to show `account-a` after actual routing had moved to `account-e`.

## Why the session could still talk after `account-a` was marked capped

The apparent contradiction was:

```text
If account-a was marked capped, why could the user still talk?
```

The answer from the logs is:

1. The session initially used `account-a` successfully.
2. During the failure, the main-thread lease failed over away from `account-a`.
3. After that, actual routing used `account-e` / `acct-e-005`.
4. The footer still showed `account-a`, so it looked like the user was still talking through `account-a`.
5. Existing leases can keep routing through account IDs even if later pool health state changes.
6. The fatal failure appears when a later fresh selection sees no healthy accounts.

So the user-visible account label and the actual routed account were not the same after failover.

## Confirmed bugs

### Bug 1: False Codex account capping from generic connection errors

Generic `APIConnectionError` from Claude OAuth/small-model paths can trigger Codex account failover and capping when the Codex pool is active.

### Bug 2: Account capping happens before replacement selection succeeds

`failoverCodexLease()` mutates pool health before confirming a replacement. If replacement selection fails, the mutation remains.

### Bug 3: Generic connection errors use usage-cap semantics

`markPoolAccountCapped()` records `status = capped` and `usagePrimary = 100` even when the reason is only `Connection error.`. This conflates transient transport/client/auth failures with real quota caps.

### Bug 4: Existing leases can mask poisoned pool health

Existing leases can continue routing through account IDs while fresh account selection later fails. This can delay the visible failure and make the timeline confusing.

### Bug 5: Account-resolution failures are not surfaced to the chat transcript

`All Codex accounts are capped or unavailable` is logged, but the user does not get a visible assistant/system error message. The prompt appears to receive no response.

### Bug 6: Footer/profile display can be stale after automatic lease failover

The footer can show `account-a` after actual request routing has moved to another profile such as `account-e`.

## Rejected or unproven hypotheses

### Hypothesis: all real accounts were exhausted

Not proven. The log did not contain direct provider cap evidence such as `CodexAccountCapError`, `429`, or an upstream Codex usage-limit response.

### Hypothesis: `account-a` was unusable from the beginning

Rejected. The log shows `account-a` serving successful GPT/Codex requests earlier in the session.

### Hypothesis: the UI was stuck in a permanent running state

Not supported. The debug log shows `QueryGuard` returning to idle after the failed prompts.

### Hypothesis: the user was still actually routed through `account-a` after failover

Rejected by routing logs. The footer showed `account-a`, but `codex-cache` and `codex_send_path` records show actual routing moved to `account-e`.

## Remaining uncertainties

The investigation did not prove these points:

1. Whether the Claude OAuth 400 was caused by an expired/invalid Claude token, a profile mismatch, a transient service issue, or another auth-state bug.
2. Whether the SDK/request layer always wraps that OAuth failure into `APIConnectionError("Connection error.")`, or whether that wrapping was specific to this code path.
3. The exact point at which `account-e` was locally marked capped, because no direct `Account account-e capped` log line was found.
4. Whether `/accounts` at the time would have displayed the poisoned pool state clearly.
5. Whether all accounts were poisoned exclusively by this mechanism or whether some had pre-existing in-memory state before the observed cascade.

These uncertainties do not change the core bug: Codex account health was mutated in response to errors that were not confirmed Codex quota failures.

## Suggested fix direction

Do not implement without tests. Likely fixes:

1. **Gate Codex connection-error failover on confirmed Codex routing.** Use an explicit flag such as `isCodexRequest`, or attach provider/route information to the retry context. Do not infer Codex ownership only from `isPoolActive()`.

2. **Separate transient failures from usage caps.** Generic connection/OAuth/client errors should not call `markPoolAccountCapped()` or set `usagePrimary = 100`.

3. **Avoid mutating account health until replacement selection succeeds.** In `failoverCodexLease()`, select a replacement first, then mark the previous account failed/capped only if the failover can actually be committed. If no replacement exists, preserve prior pool health or use a distinct non-cap failure state.

4. **Make failed account selection visible to the user.** If `onQueryImpl` throws `All Codex accounts are capped or unavailable`, append a visible assistant/system error message before cleanup completes.

5. **Refresh status line on lease/account switches.** Wire `onCodexAccountSwitch` to bump a status-line refresh key or subscribe the status line to lease/pool changes.

6. **Improve diagnostics.** Log whether the failing retry attempt was Codex-routed, which account was considered current, whether `markPoolAccountCapped()` ran, and whether replacement selection succeeded. That would make future investigations much shorter.

## Failing tests to add first

### Test 1: Non-Codex `APIConnectionError` must not cap Codex accounts

Setup:

- Claude/Anthropic model path is active, such as a small fast model path.
- Codex pool is initialized and active.
- A Codex main-thread lease exists.
- `withRetry` sees `APIConnectionError` on attempt >= 2.

Expected:

- `failoverCodexLease()` is not called.
- `markPoolAccountCapped()` is not called.
- No Codex account changes to `capped`.
- Pool health remains unchanged.

### Test 2: Failed failover must not poison the last account

Setup:

- Codex pool has one remaining healthy account.
- A failover attempt is triggered.
- No replacement account exists.

Expected:

- The last account is not left as `capped` due only to failed replacement selection.
- The thrown error is clear.
- Pool state remains internally consistent.

### Test 3: Real Codex cap still failovers correctly

Setup:

- Request is confirmed Codex-routed.
- Adapter throws `CodexAccountCapError` or a confirmed provider quota/cap response.
- Another healthy account exists.

Expected:

- Current account is marked capped.
- Lease is reassigned to the healthy replacement.
- Status/pool state updates consistently.

### Test 4: Account-resolution failure renders a visible message

Setup:

- `onQueryImpl` throws `All Codex accounts are capped or unavailable`.

Expected:

- User prompt remains recorded.
- A visible assistant/system error message is appended to the transcript.
- Query guard/loading state still cleans up.

### Test 5: Status line updates on Codex lease failover

Setup:

- Status line initially shows `account-a`.
- Main-thread lease fails over to `account-e`.

Expected:

- Status line refreshes and shows `account-e`, or otherwise shows the active routing account accurately.

### Test 6: Existing stale leases do not hide poisoned pool state indefinitely

Setup:

- A lease points to an account that later becomes non-healthy in the pool.
- A subsequent request attempts to use that lease.

Expected:

- Either the lease is revalidated before use, or diagnostics clearly show that stale lease routing is intentional.
- Fresh account selection and existing lease routing do not silently diverge in a way that makes UI/debugging misleading.

## Suggested diagnostic improvements

Future logs should make these boundaries explicit:

```text
[retry] provider_route=openai|anthropic is_codex_request=true|false model=...
[codex-pool] mark-capped account=... reason=... source=cap|connection|auth|unknown
[codex-pool] failover-start owner=... from=... reason=...
[codex-pool] failover-commit owner=... from=... to=...
[codex-pool] failover-abort owner=... from=... reason=no_healthy_replacement state_mutated=false
[statusline] active_profile=... source=main_lease|active_pool
```

The key diagnostic need is to distinguish:

- real provider cap
- connection error
- Claude OAuth failure
- Codex token failure
- local account-selection failure
- stale lease routing

## Final diagnosis

The old session did not prove `account-a` or all Codex accounts were truly exhausted.

The best-supported diagnosis is:

```text
Cat Code falsely converted Anthropic OAuth / Claude small-model connection failures into Codex account-cap state. This poisoned the local in-memory Codex pool, caused later prompts to fail account selection, hid the failure from the chat UI, and displayed stale account/profile information in the footer.
```

The user-facing result was a silent apparent stall, but the underlying failure was a local account-pool state corruption and error-surfacing bug.
