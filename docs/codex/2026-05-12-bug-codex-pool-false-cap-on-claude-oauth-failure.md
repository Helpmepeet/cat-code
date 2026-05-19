# Bug: Codex pool falsely caps accounts after Claude OAuth connection errors

## Executive summary

A Cat Code session appeared to stop responding after `2026-05-11T17:19:20`. The visible symptom looked like a stalled chat: user prompts were accepted and recorded, but no assistant reply appeared.

The first obvious error in the debug log was:

```text
All Codex accounts are capped or unavailable
```

That wording is misleading if read as provider truth. The investigation did **not** find evidence that the user's real Codex/OpenAI accounts were all exhausted. Instead, the strongest supported diagnosis is:

```text
Cat Code converted Anthropic Claude OAuth / small-model connection failures into Codex account-cap state. That poisoned the local in-memory Codex account pool. Later prompts failed account selection, and the REPL logged the error without rendering a visible chat message.
```

The session started on Codex profile `main`, successfully routed GPT/Codex requests through `main`, then failed over away from `main` after a Claude OAuth refresh error against `https://platform.claude.com/v1/oauth/token`. Actual routed requests later used `arm`, while the footer continued showing `main` for several minutes. Eventually local pool state reached a point where fresh account selection reported no healthy accounts.

This document intentionally records only what was observed in the transcript, debug log, and source code during the investigation. Items that remain uncertain are listed separately.

## Primary artifacts

Debug log:

```text
/Users/pt/.cat-code/debug/92ef8bad-fa56-486b-95b9-0ea200c48a07.txt
```

Transcript:

```text
/Users/pt/.cat-code/projects/-Users-pt-cat-code/92ef8bad-fa56-486b-95b9-0ea200c48a07.jsonl
```

Documentation file created from the investigation:

```text
docs/codex/2026-05-12-bug-codex-pool-false-cap-on-claude-oauth-failure.md
```

## Glossary for future readers

- **Codex pool**: Cat Code's in-process pool of saved Codex/OpenAI accounts.
- **Vault profile / account alias**: Human-readable labels such as `main`, `dad`, `hiby`, `oscin`, and `arm` mapped to account UUIDs in the Codex vault.
- **Main-thread lease**: The Codex lease used by the main chat thread. It can be reassigned across accounts on failover.
- **Capped**: Cat Code local status for an account believed to have hit a cap. In this bug, generic connection errors appear to have produced this status without a confirmed provider cap.
- **Existing lease routing**: Existing leases may still point at account IDs and route requests even if later pool health state changes.
- **Fresh selection**: Code path that picks a healthy account from the pool. This can fail if all pool accounts are marked `capped` or unavailable.

## Account mapping observed from non-secret vault metadata

The investigation printed only non-secret metadata from the Codex vault. Tokens were not printed.

```text
main  -> ca889574-256c-4f04-8d5f-f80004f1a8e1
dad   -> 2766fbb9-9a6f-460d-860d-73a3d0bddd9c
hiby  -> 9ed41939-674d-49f7-89cb-1075a396c828
oscin -> 16513b88-e36e-4b37-a128-c6414cee30db
arm   -> 0c9b1d6d-f4e4-4673-9aca-79da8dd91165
```

The old session began with:

```text
Switched to main
```

So the user was initially on the `main` Codex profile.

## User-visible symptom

After the last visible assistant response, the user submitted more prompts:

```text
2026-05-11T17:19:50 do we need to research more...
2026-05-11T17:20:17 hi
2026-05-11T17:20:54 hi
```

The transcript recorded these user messages, but no assistant response followed. From the user's point of view, the session looked stalled or unresponsive.

The debug log shows the prompts did enter the normal query path and failed quickly. This was not proven to be an infinite loop or a blocked query guard.

## High-level timeline

| Time | What happened | Evidence |
| --- | --- | --- |
| `16:31:32` | Local command switched session to `main`. | Transcript local command: `Switched to main` |
| `16:32:12` onward | GPT/Codex requests successfully routed through `main` / `ca889...`. | `[codex-cache] request account=ca889574-256 model=gpt-5.5` |
| `17:14:42` | Last confirmed successful main-thread request through `main`. | `[codex-cache] owner=main-thread account=ca889574-256 model=gpt-5.5` |
| `17:14:56` | Claude small-model path appears in log. | `model 'claude-haiku-4-5-20251001'` |
| `17:14:57` | Claude OAuth refresh fails with HTTP 400. | `platform.claude.com/v1/oauth/token,status=400` |
| `17:14:57` | The failure surfaces as generic `Connection error.`. | `API error (attempt 1/6): undefined Connection error.` |
| `17:14:57-17:14:59` | Codex main-thread lease is reassigned across accounts on connection error. | `main -> dad -> hiby -> oscin -> arm` |
| `17:14:59-17:19:20` | Actual GPT/Codex routing uses `arm` / `0c9b...`. | `owner=main-thread account=0c9b1d6d-f4e model=gpt-5.5` |
| Until at least `17:18:25` | Footer still displays `main`. | Screen sample: `GPT 5.5 · high · main` |
| `17:19:50` | Next user prompt fails account selection. | `All Codex accounts are capped or unavailable` |
| `17:20:17`, `17:20:54` | Later `hi` prompts fail the same way. | Repeated account-resolution errors |

## Detailed timeline and evidence

### 1. `main` was used successfully

The session successfully routed GPT/Codex traffic through `main` / `ca889...` earlier in the run:

```text
2026-05-11T16:32:12.211Z [codex-cache] request account=ca889574-256 model=gpt-5.5
2026-05-11T16:32:35.335Z [codex-cache] owner=main-thread account=ca889574-256 model=gpt-5.5
```

Later successful `main` usage continued:

```text
2026-05-11T17:14:00.946Z [codex-cache] owner=main-thread account=ca889574-256 model=gpt-5.5
2026-05-11T17:14:42.550Z [codex-cache] owner=main-thread account=ca889574-256 model=gpt-5.5
```

A per-account timeline found many `ca889...` routing entries before the failover and no routed `main` requests after the failover line at `17:14:57.838`.

This means `main` was not dead from session start. It served real GPT/Codex traffic successfully.

### 2. A Claude small-model / OAuth path failed

Immediately before the failover cascade, the debug log shows a Claude small-model path:

```text
2026-05-11T17:14:56.874Z Tool search disabled for model 'claude-haiku-4-5-20251001': model does not support tool_reference blocks.
2026-05-11T17:14:56.875Z Cached MC gate: enabled=false modelSupported=false model=claude-haiku-4-5-20251001
```

Then Claude OAuth refresh failed:

```text
2026-05-11T17:14:57.310Z [ERROR] AxiosError: [url=https://platform.claude.com/v1/oauth/token,status=400] AxiosError: Request failed with status code 400
```

The retry layer then logged a generic connection error:

```text
2026-05-11T17:14:57.311Z [ERROR] API error (attempt 1/6): undefined Connection error.
```

This is important because the immediate failing endpoint in the log is Anthropic Claude OAuth, not an OpenAI/Codex endpoint.

### 3. Codex failover ran on that generic connection error

On retry attempts, Cat Code reassigned the main-thread Codex lease across multiple accounts:

```text
2026-05-11T17:14:57.838Z [codex-pool] Reassigned lease main-thread from ca889574-256c-4f04-8d5f-f80004f1a8e1 to 2766fbb9-9a6f-460d-860d-73a3d0bddd9c on connection error
2026-05-11T17:14:58.222Z [codex-pool] Reassigned lease main-thread from 2766fbb9-9a6f-460d-860d-73a3d0bddd9c to 9ed41939-674d-49f7-89cb-1075a396c828 on connection error
2026-05-11T17:14:58.588Z [codex-pool] Reassigned lease main-thread from 9ed41939-674d-49f7-89cb-1075a396c828 to 16513b88-e36e-4b37-a128-c6414cee30db on connection error
2026-05-11T17:14:59.102Z [codex-pool] Reassigned lease main-thread from 16513b88-e36e-4b37-a128-c6414cee30db to 0c9b1d6d-f4e4-4673-9aca-79da8dd91165 on connection error
```

Expanded with aliases:

```text
17:14:57.838 main  -> dad   on connection error
17:14:58.222 dad   -> hiby  on connection error
17:14:58.588 hiby  -> oscin on connection error
17:14:59.102 oscin -> arm   on connection error
```

The observed behavior is suspicious because the trigger was a generic connection error immediately following a Claude OAuth refresh failure.

### 4. Actual routing moved from `main` to `arm`

After the failover cascade, actual routed GPT/Codex traffic moved to `arm` / `0c9b...`:

```text
2026-05-11T17:18:34.404Z account_id_prefix=0c9b1d6d model=gpt-5.5 completed=true
2026-05-11T17:19:01.605Z account_id_prefix=0c9b1d6d model=gpt-5.5 completed=true
2026-05-11T17:19:20.964Z account_id_prefix=0c9b1d6d model=gpt-5.5 completed=true
```

The debug log also shows main-thread ownership on `arm` near the end of successful operation:

```text
2026-05-11T17:19:01.605Z [codex-cache] owner=main-thread account=0c9b1d6d-f4e model=gpt-5.5
2026-05-11T17:19:05.905Z [codex-cache] owner=main-thread account=0c9b1d6d-f4e model=gpt-5.5
2026-05-11T17:19:20.963Z [codex-cache] owner=main-thread account=0c9b1d6d-f4e model=gpt-5.5
```

This resolves one of the main contradictions in the investigation: if `main` had been marked capped, the same process should stop using it. The logs show exactly that. The process stopped routing through `main` after failover and used `arm` instead.

### 5. The footer/status line was stale or misleading

Even after routing had moved to `arm`, debug screen samples continued to show:

```text
GPT 5.5 · high · main
```

This was visible until at least `17:18:25`, more than three minutes after failover away from `main` at `17:14:57`.

Later the footer dropped the profile label entirely:

```text
GPT 5.5 · high | ctx: 34%
```

The footer made it look like the user was still talking through `main`, while actual request-routing logs showed `arm`. For this incident, request-routing logs are more authoritative than footer text.

### 6. Later prompts failed without visible assistant output

At `17:19:50`, a user prompt entered normal query handling:

```text
2026-05-11T17:19:50.831Z [PromptInput:onSubmit] start length=149 slash=false mode=prompt
2026-05-11T17:19:50.839Z [REPL:onQuery] start messages=1 shouldQuery=true
2026-05-11T17:19:50.842Z [REPL:query-setup] query start systemPromptSectionCount=14
```

Then failed immediately:

```text
2026-05-11T17:19:50.842Z [REPL:onQuery] onQueryImpl error: All Codex accounts are capped or unavailable
```

The query guard cleaned up:

```text
2026-05-11T17:19:50.842Z [QueryGuard] end -> idle generation=21
2026-05-11T17:19:50.843Z [REPL:onQuery] cleanup for generation=21
2026-05-11T17:19:50.843Z [REPL:onQuery] finally complete generation=21
```

The API retry path also logged:

```text
No valid Codex (OpenAI) account found. All accounts may have hit their usage limit. Use /switch-account to switch to another account, or /accounts to check status.
```

The same failure pattern repeated for prompts at `17:20:17` and `17:20:54`.

The session did not appear to be stuck in an infinite running state. It accepted prompts, failed, cleaned up, and returned idle, but did not show the user a useful visible error message.

## What was not found

A full debug-log scan did not find direct provider-side cap evidence for `main` or all accounts.

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

The initial interpretation was too strong. The evidence does not prove that `main`, or all accounts, were truly exhausted at the provider level.

The precise statement is:

```text
Cat Code's local in-memory Codex pool believed all accounts were capped or unavailable.
```

That local state appears to have been produced by retry/failover logic.

### Correction 2: The user was not necessarily still talking through `main`

The footer showed `main`, but actual routing logs showed traffic moved to `arm`.

So the statement “we were still talking on main” was true from the UI perspective but not from the request-routing evidence.

### Correction 3: `arm` may have been poisoned later even if existing routes still succeeded

A later verifier pointed out an important mechanism:

- `failoverCodexLease()` marks the current account capped before replacement selection succeeds.
- If selection fails and the caller swallows the error, the account can remain locally capped.
- Existing leases may still route through stale account IDs even after local pool health says the account is capped.
- A fresh selection later sees no healthy accounts and fails.

This explains how `arm` could continue serving existing-routed requests and still leave the pool in a poisoned state for the next fresh account selection.

This exact moment for `arm` being marked capped was not directly logged as `Account arm capped`; it is inferred from code behavior and the later `All Codex accounts are capped or unavailable` failure. The inference is plausible and consistent with the code, but it is not backed by a direct `markPoolAccountCapped(arm)` log line.

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

The observed footer stayed on `main` after actual routing had moved to `arm`. The likely issue is not the snapshot calculation itself, but that lease failover did not force a status-line re-render at the right time.

## State model that explains the incident

The incident makes more sense if these states are kept separate:

1. **Provider reality**: whether OpenAI/Codex actually capped an account.
2. **Vault metadata**: saved profile files on disk.
3. **In-memory pool health**: Cat Code process-local account status, such as `healthy`, `capped`, or `dead`.
4. **Lease routing**: account IDs currently held by main-thread or subagent leases.
5. **Footer display**: rendered profile label in the UI.

The bug happened because these states diverged:

- Provider reality did not show a confirmed Codex cap.
- Vault metadata for `main` did not show a durable cap marker in the non-secret fields inspected.
- In-memory pool health was mutated to cap accounts due to connection errors.
- Lease routing moved from `main` to `arm` and existing routes kept working.
- Footer display continued to show `main` after actual routing had moved to `arm`.

## Why the session could still talk after `main` was marked capped

The apparent contradiction was:

```text
If main was marked capped, why could the user still talk?
```

The answer from the logs is:

1. The session initially used `main` successfully.
2. At `17:14:57`, the main-thread lease failed over away from `main`.
3. After that, actual routing used `arm` / `0c9b...`.
4. The footer still showed `main`, so it looked like the user was still talking through `main`.
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

The footer can show `main` after actual request routing has moved to another profile such as `arm`.

## Rejected or unproven hypotheses

### Hypothesis: all real accounts were exhausted

Not proven. The log did not contain direct provider cap evidence such as `CodexAccountCapError`, `429`, or an upstream Codex usage-limit response.

### Hypothesis: `main` was unusable from the beginning

Rejected. The log shows `main` serving successful GPT/Codex requests earlier in the session.

### Hypothesis: the UI was stuck in a permanent running state

Not supported. The debug log shows `QueryGuard` returning to idle after the failed prompts.

### Hypothesis: the user was still actually routed through `main` after failover

Rejected by routing logs. The footer showed `main`, but `codex-cache` and `codex_send_path` records show actual routing moved to `arm`.

## Remaining uncertainties

The investigation did not prove these points:

1. Whether the Claude OAuth 400 was caused by an expired/invalid Claude token, a profile mismatch, a transient service issue, or another auth-state bug.
2. Whether the SDK/request layer always wraps that OAuth failure into `APIConnectionError("Connection error.")`, or whether that wrapping was specific to this code path.
3. The exact timestamp at which `arm` was locally marked capped, because no direct `Account arm capped` log line was found.
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

- Status line initially shows `main`.
- Main-thread lease fails over to `arm`.

Expected:

- Status line refreshes and shows `arm`, or otherwise shows the active routing account accurately.

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

The old session did not prove `main` or all Codex accounts were truly exhausted.

The best-supported diagnosis is:

```text
Cat Code falsely converted Anthropic OAuth / Claude small-model connection failures into Codex account-cap state. This poisoned the local in-memory Codex pool, caused later prompts to fail account selection, hid the failure from the chat UI, and displayed stale account/profile information in the footer.
```

The user-facing result was a silent apparent stall, but the underlying failure was a local account-pool state corruption and error-surfacing bug.
