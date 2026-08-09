# S04 — account pool, token rotation, retry

## Verdict

The Codex side of this code is genuinely careful: the raw-refresh path (`accounts.ts`)
and the stateful vault path (`codexTokenRefresh.ts`) both implement lock →
persist-intent → network → correlate-ownership → persist, with a durable ledger and a
real multi-process probe test behind them. All three named past regressions (stale
`usageResetAt` vs hard-429, resolver eager-refresh throw, `isPoolActive` count>1) are
fixed and the fixes are load-bearing in source. The single most important thing to fix
is `persistNextQuarantineProbe` (`codexTokenRefresh.ts:881`): it is an **unlocked
whole-vault read-modify-write that destroys the in-flight refresh's `attempt_id`**,
which converts a successful server-side rotation into a lost rotation and then into a
permanent `reauth_required` verdict — the exact 2026-07-05 failure mode, reachable
inside a single process at startup. Second: the Claude pool is a copy of the Codex pool
with none of its safety — non-atomic credential writes, no lock, no cross-process
re-read — so the multi-account Claude path has the rotation-loss bug that the Codex path
spent 600 lines eliminating.

## Findings

### [HIGH] Quarantine probe clobbers an in-flight refresh's attempt ownership, losing the rotation and killing the account

- **Where**: `src/services/api/codexTokenRefresh.ts:881-924` (`persistNextQuarantineProbe`), called from `:838` and `:863`
- **Type**: correctness
- **What**: `persistNextQuarantineProbe` does `readVault()` → mutate `vault.refresh` →
  `atomicWriteJson()` on the account's vault file **without holding the vault lock**, and
  writes back the *whole* vault object it read. Its only guard is
  `if (refreshState.state === 'reauth_required') return`. It does **not** skip
  `state === 'in_flight'`, so it overwrites the `attempt_id` of a refresh that is
  currently awaiting the network under the lock.
- **Trigger / why it matters**: concrete, single-process, reachable at startup.
  `initAccountPool` (`codexAccountPool.ts:222-227`) starts the 1 Hz quarantine probe
  **and** fires `void touchAll()` in the same block. `touchAll` iterates vault *files*
  and only skips on file-lock/refresh-skew — it does not skip quarantined accounts — so
  for an account that loaded as `quarantined` (`getVaultRefreshPoolStatus`) and is within
  refresh skew, both target the same file within the same second:
  1. `touchAll` → `refreshAccountTokensStateful` takes the lock, writes
     `refresh = {state:'in_flight', attempt_id: X}` (`:386-396`), `await fetch` (up to 15s).
  2. Probe tick fires, sees `state:'in_flight'` (not skipped), writes
     `refresh = {state:'unknown', next_probe_at: …}` — `attempt_id X` is gone. (The
     in-process single-flight at `:267` does not help: the clobber happens *before* the
     probe joins the pending promise.)
  3. Server rotates R0 → R1. Step 1 resumes, re-reads, `latest.refresh.attempt_id !== X`
     (`:526`), and the recovery arm requires `latest.tokens.refresh_token !== refreshToken`
     — but tokens were never written, so it is false. Throws
     `'Lost refresh attempt ownership; refusing to write tokens'` (`:537`).
     **R1 is discarded; the vault still holds the server-burned R0.**
  4. The probe then acquires the lock and refreshes with R0 → `invalid_grant` →
     `isCredentialRefreshFailure` → same false recovery check → `markAccountDead` +
     `refresh = {state:'reauth_required'}` (`:472-484`).
  Net: a healthy account is permanently dead until re-login, with a terminal verdict the
  loader will honour. Cross-process (two engine processes) the same collision needs only
  a probe tick anywhere inside the other process's ≤15s in-flight window.
- **Fix**: extend the early return to any non-terminal owned state —
  `if (refreshState.state === 'reauth_required' || refreshState.state === 'in_flight') return`.
  (Strictly correct would be taking the same `lock(vaultFilePath)` for the backoff write,
  but the one-line skip removes the destructive case; the probe already tolerates "no
  backoff reservation" per the function's own comment at `:888-892`.)

### [HIGH] Claude vault credential file is written non-atomically, and a failed write is invisible

- **Where**: `src/services/api/claudeAccountPool.ts:624-663` (`saveClaudeTokenToVault`)
- **Type**: correctness
- **What**: `writeFileSync(filePath, …)` — truncate-then-write, no temp+rename, no fsync,
  no lock, and the function returns `void` with the error swallowed into a debug log.
  Every other credential writer in this scope is atomic: `saveCodexTokenToVault`
  (`codexAccountPool.ts:761-763`) does temp+rename, `atomicWriteJson`
  (`codexTokenRefresh.ts:926-965`) does temp+fsync+rename+dir-fsync, and even
  `setClaudeAccountAlias` two functions above (`:598-601`) does temp+rename.
- **Trigger / why it matters**: `updateActiveClaudeAccountTokens` (`:517`, called from
  `auth.ts:1651` on every OAuth refresh) calls this on the hot path. A crash, a full disk,
  or a second engine process writing the same file mid-write leaves truncated JSON.
  `loadVaultAccounts` then throws in `JSON.parse`, hits the catch at `:719`, and
  `continue`s — **the account silently disappears from the pool on next start**, with only
  a debug line. The `void` return also means `initClaudeAccountPool:162-166` stamps
  `migratable.vaultFilePath` unconditionally, recording a path for a file that may not
  exist. The Codex twin gets this right: `saveCodexTokenToVault` returns `null` on failure
  and `accounts.ts:584` uses that to set `persistFailed` and write a ledger entry.
- **Fix**: mirror `saveCodexTokenToVault` — write to `.<pid>.<ts>.tmp` in the same
  directory with mode `0o600`, `renameSync` onto the target, and return the file path or
  `null` so callers can detect failure.

### [HIGH] Claude multi-account refresh has no cross-process rotation safety: the lock's re-check reads memory, not disk

- **Where**: `src/services/api/claudeAccountPool.ts:199-205` + `:517-537`, consumed by `src/utils/auth.ts:1504-1516`, `:1580-1590`, `:1626-1636`
- **Type**: correctness
- **What**: once `shouldUseClaudePoolTokenSource()` is true (`pool.accounts.length > 1`),
  `getClaudeAIOAuthTokens` (`auth.ts:1308`) and `getClaudeAIOAuthTokensAsync`
  (`auth.ts:1504`) return tokens from the **in-memory pool**. The pool is loaded exactly
  once, at `src/entrypoints/init.ts:96`; nothing re-reads the vault for the life of the
  process. Every "did another process already refresh?" check in
  `checkAndRefreshOAuthTokenIfNeededImpl` is therefore blind: the pre-lock re-read
  (`auth.ts:1582-1590`) and the post-lock re-read (`:1627-1636`) both clear the memoize and
  keychain caches and then read the same stale in-memory value.
- **Trigger / why it matters**: two engine processes, ≥2 Claude accounts, token near
  expiry. A takes the `claudeDir` lock, refreshes R0 → R1, writes keychain + vault,
  releases. B acquires the lock, re-reads (pool memory: still R0, still expired), and
  refreshes with the rotated-away R0. Anthropic rejects it; B's catch re-reads (still
  stale) and returns `false`. In `withRetry.ts:538-576`, `handleOAuth401Error` returning
  `false` sends B into `failoverClaudeAccount(...)`, which marks a **perfectly healthy
  account `dead`** in B's pool. The `handleOAuth401ErrorImpl` shortcut that exists
  precisely for this case — "keychain has a different token, another tab already
  refreshed" (`auth.ts:1477-1480`) — can never fire for pool users, because
  `currentTokens.accessToken` comes from the same stale pool.
  (The read path predates this branch; `claudeAccountPool.ts` is in scope and owns the
  stale in-memory state, so flagging it here.)
- **Fix**: make the pool token source re-read from disk when it is stale — have
  `getActiveClaudeAccount()` (or a small `reloadActiveClaudeAccountFromVault()`) re-read
  the active account's vault file when its `mtime` changed, and call it from the two
  post-cache-clear re-read points in `auth.ts`. That restores the "another process already
  rotated" recovery the lock protocol assumes.

### [MED] `expectedPreviousAccountId` is accepted by the vault writer and never read

- **Where**: `src/services/api/codexAccountPool.ts:700` (declared), passed at `codexTokenRefresh.ts:560`, `codex-core/accounts.ts:580`, `codexIdentityReconciliation.ts:84`
- **Type**: dead-code
- **What**: `saveCodexTokenToVault`'s options type declares `expectedPreviousAccountId?: string`
  and three call sites pass it. The function body never references it — it computes its own
  `previousAccountId`/`accountChanged` from the file and uses those only for logging and
  the `preserveExistingMetadata` decision.
- **Trigger / why it matters**: the name promises a compare-and-swap guard ("only write if
  the file still holds this account") on the single highest-consequence write in the
  repo — and the two identity-mismatch call sites are exactly where a caller would rely on
  it. Reviewers and future callers will read the parameter as a safety check that does not
  exist. This is a lying API on the rotation-loss path.
- **Fix**: either implement it (read the existing file's `tokens.account_id`; if it is
  present and does not equal `expectedPreviousAccountId`, return `null` without writing),
  or delete the field and the three call-site arguments.

### [MED] Identity-mismatch reconciliation silently destroys an existing profile's alias and resurrects a dead account

- **Where**: `src/services/api/codexIdentityReconciliation.ts:73-107`, with `codexTokenRefresh.ts:559-563` and `codexAccountPool.ts:729-759`, `:342-372`
- **Type**: correctness
- **What**: on identity mismatch the stateful path calls
  `saveCodexTokenToVault(..., { filePath: <newAccountId>.json, preserveExistingMetadata: false })`.
  If a vault file for `newAccountId` already exists (a separately logged-in profile),
  `shouldPreserve` is false, `data` starts as `{}`, no alias is supplied, and
  `else if (!shouldPreserve) delete data.alias` (`:757-759`) drops it. The subsequent
  `appendAccount(..., { preserveCapped: true })` then sets `status = 'healthy'` for that
  existing pool entry — `preserveCapped` preserves only `capped`, so `dead` and
  `quarantined` are cleared (`:352-354`).
- **Trigger / why it matters**: user has profiles `main` (A) and `backup` (B), both
  ultimately the same ChatGPT login. A refresh of A returns B's identity. B's vault file is
  rewritten with no alias, so `/accounts` now shows a bare account id instead of `backup`,
  and B — which may have been marked `dead` (needs re-login) or `quarantined` — is
  reported healthy off the back of an unrelated account's rotation, so selection routes to
  it. The alias loss is silent and unrecoverable without re-running `/rename`.
- **Fix**: pass the existing file's alias through — read it before the write and supply it
  as `tokens.alias`, or set `preserveExistingMetadata: true` when the target file's
  `account_id` already equals `newAccountId` (the metadata is genuinely that account's).

### [MED] Vault credential files land at 0644, inconsistently, depending on which writer touched them last

- **Where**: `src/services/api/codexAccountPool.ts:762` and `src/services/api/claudeAccountPool.ts:655`
- **Type**: security
- **What**: both credential writers call `writeFileSync` with no `mode`, so the file gets
  `0o666 & ~umask` (0644 on a default macOS umask). `renameSync` preserves the temp file's
  mode, so the mode sticks. `atomicWriteJson` (`codexTokenRefresh.ts:935`) and the raw
  ledger (`accounts.ts:759-761`) do use `0o600`.
- **Trigger / why it matters**: verified live on this machine (directory listing only, no
  contents read): `~/codex-vault/accounts` currently holds a mix of `-rw-------` and
  `-rw-r--r--` files, and both `~/claude-vault/accounts` files are `-rw-r--r--`. The mode
  flips depending on whether the last write came from a login/`saveCodexTokenToVault`
  (0644) or a refresh/`atomicWriteJson` (0600). OAuth refresh tokens are readable by any
  local user in the 0644 state.
- **Fix**: pass `{ mode: 0o600 }` to both `writeFileSync` calls (and to the temp file
  before rename), matching `atomicWriteJson`.

### [MED] The two pools are the same concept copy-pasted, and the copies diverge exactly where safety lives

- **Where**: `src/services/api/claudeAccountPool.ts` vs `src/services/api/codexAccountPool.ts`
- **Type**: design
- **What**: `checkAccountHealth` is byte-identical in both files
  (`codexAccountPool.ts:1108-1114`, `claudeAccountPool.ts:776-781`). The same 7-day
  `last_refresh` heuristic, the same `{tokens, profile, last_refresh, alias}` vault shape,
  the same `loadVaultAccounts` skeleton, the same exact-then-prefix resolver
  (`resolveCodexAccountByPrefix` ≈ `resolveClaudeAccountByPrefix`, ~55 lines each), the
  same `switchTo*` / `remove*Account` / `set*Alias` / `seed*ForTest` / `reset*ForTest`
  pairs, and two near-identical `emitAccountDiagnostic` count helpers (`countPoolStatuses`
  exists in both `codexAccountPool.ts:116` and `codexIdentityReconciliation.ts:15`).
- **Trigger / why it matters**: this is not a style complaint — the divergence *is* the
  bug list above. The Codex copy got atomic writes, locking, a ledger, and a failure
  return value; the Claude copy got none of them, and nothing structural will make the
  next Codex hardening fix propagate. Two of the three HIGH findings here are "the Claude
  copy lacks what the Codex copy has".
- **Fix**: not a rewrite. Extract the two genuinely shared, safety-critical primitives
  into one module each — an atomic `writeCredentialFileAtomic(path, data)` (temp + 0600 +
  fsync + rename, returning success) used by both `saveCodexTokenToVault` and
  `saveClaudeTokenToVault`, and one `resolveAccountByPrefix` generic over the id/alias
  accessors. Leave the divergent lifecycle logic alone.

### [MED] Runtime cap state is process-local by design, but nothing durable lets a fresh process avoid a known-capped account

- **Where**: `src/services/api/codexAccountPool.ts:469-489` (`markPoolAccountCapped`), `:213-235` (`initAccountPool`)
- **Type**: design
- **What**: `status`, `cappedAt`, `usageResetAt` are in-memory only; `rg` confirms no
  writer persists them (the only other readers, `codexStatus.ts:315-369`, read the live
  pool). A fresh process rebuilds health from vault `refresh` state plus a usage poll
  that `initAccountPool` fires **fire-and-forget** (`:232-234`), so the first request can
  select before any hint lands.
- **Trigger / why it matters**: assessment as asked — keeping local *belief* (`status`,
  `cappedAt`) out of the credential vault is correct; a stale persisted cap would strand a
  healthy account, and that is worse than a wasted request. But `usageResetAt` is not a
  belief, it is a server-reported fact, and not persisting it means every fresh `-p`
  one-shot under pool pressure burns one 429 round before it re-derives what the previous
  process already knew. With N one-shots that is N wasted 429s against a quota that is
  already exhausted.
- **Fix**: persist only the server fact. Write `usage: { reset_at }` into the vault's
  existing JSON alongside `refresh`, and have `loadVaultAccounts` seed `usageResetAt` from
  it. `getCodexAccountAvailability` already handles a future `resetAt` correctly
  (`:1551-1568`), and a stale/elapsed value is self-clearing, so nothing can strand an
  account.

### [LOW] A throw inside the quarantine probe's own catch block escapes a 1 Hz `void`-called timer

- **Where**: `src/services/api/codexTokenRefresh.ts:851-872` (`persistNextQuarantineProbe` at `:863`), timer at `:788-790`
- **Type**: correctness
- **What**: the catch arm calls `persistNextQuarantineProbe`, which can throw from
  `atomicWriteJson` (EACCES, ENOSPC). A throw from a catch block is not caught by anything
  — it propagates out of the loop, past `finally` (which does correctly reset
  `quarantineProbeInFlight`), and rejects the promise from `void runQuarantineProbeOnce()`.
- **Trigger / why it matters**: read-only or full vault directory turns into a 1 Hz
  unhandled-rejection/telemetry storm (`gracefulShutdown.ts:328` logs each one and calls
  `logEvent`, so it is noise rather than a crash). The account also never gets a backoff
  reservation written, so it re-probes every second forever.
- **Fix**: wrap the `persistNextQuarantineProbe(vaultFilePath, detail)` call at `:863` in
  `try {} catch {}`, and attach `.catch(() => {})` to the `void runQuarantineProbeOnce()`
  in the interval.

### [LOW] The quarantine probe does a synchronous vault read per quarantined account every second, indefinitely

- **Where**: `src/services/api/codexTokenRefresh.ts:782` (`QUARANTINE_PROBE_INTERVAL_MS = 1_000`), `:828`
- **Type**: quality
- **What**: the interval runs at 1 Hz for the process lifetime and, for each quarantined
  account, does `readVault()` — a synchronous `readFileSync` + `JSON.parse` — before the
  `next_probe_at` gate rejects it. The backoff ladder tops out at 300s, but the disk read
  happens every tick regardless.
- **Trigger / why it matters**: with a quarantined account the process performs 86,400
  synchronous file reads per day on the main thread purely to re-read a timestamp it just
  wrote. This is the same class of idle cost the repo's energy work targeted.
- **Fix**: cache `next_probe_at` in memory when the probe writes it and check the cached
  value before `readVault`; or raise the tick to 5s (the shortest backoff rung).

### [LOW] `fetchPoolUsage` is launched as a floating promise inside a `.catch()` that cannot see it

- **Where**: `src/services/api/codexAccountPool.ts:232-234`
- **Type**: quality
- **What**: `import('./codexUsage.js').then(({ fetchPoolUsage }) => { void fetchPoolUsage(…) }).catch(() => {})`
  — the `void` discards the promise, so the trailing `.catch` only covers the dynamic
  import and synchronous throws in the callback. A rejection from `fetchPoolUsage` (its
  per-account work is individually caught, but `updateRoutingHintsFromUsage` /
  `emitCachedUsageWarningsForActiveSink` are not) becomes an unhandled rejection at
  startup.
- **Fix**: `.then(({ fetchPoolUsage }) => fetchPoolUsage({ updateRoutingHints: true })).catch(() => {})`.

## What is good here

- **The raw-refresh ledger in `codex-core/accounts.ts:376-779` is the right shape.**
  Intent is persisted *before* the request leaves the machine, a failure to write the
  ledger aborts the rotation rather than spending it (`:499-505`), `assertLockIntact()` is
  re-asserted before every store touch, and `definitely_not_sent` vs ambiguous transport
  errors get different terminal states. The identity-mismatch tombstone with
  `rotatedToAccountId` lets a contending loser fail fast instead of burning a dead token.
- **The multi-process probe genuinely races.** `accountRefreshContention.probe.test.ts`
  spawns two real Bun processes, waits for both `.ready.<pid>` markers before releasing a
  shared go-file barrier, and asserts against a parent-owned mock OAuth server that
  `server.attempts` has length **1** with `outcome: 'rotated'` — i.e. exactly one rotation
  was spent, not "both succeeded". The child fails closed on any non-mock URL
  (`probe.child.ts:74-77`). This is not a vacuous test.
- **All three named past regressions are fixed in source, not just in docs.**
  (a) `getHard429QuotaBelief` (`codexAccountPool.ts:1380-1400`) refuses to carry a
  `usageResetAt` that predates `cappedAt`, with the hot-loop rationale in the comment;
  (b) `refreshCoreAccountBestEffort` (`client.ts:300-312`) swallows the eager-refresh
  throw so it cannot bypass `withRetry`'s classify/failover path; (c) `isPoolActive()` is
  now an alias of `canFailover()` (≥2 switchable) and is cleanly separated from
  `poolManagesCredentials()` (≥1).
- **`--fallback-model` is correctly confined to 529.** `FallbackTriggeredError` is thrown
  only inside the `is529Error(error)` consecutive-529 block (`withRetry.ts:1102-1126`);
  no 429/cap path can reach it, and `CodexAccountCapError` is not an `APIError` so it
  cannot leak in through `isTransientCapacityError`.
- **`correlateRefreshVerdict` (`codexAccountPool.ts:1139-1157`) fails closed on the right
  side.** It narrows both the stored hash *and* the current token before comparing, with
  the comment naming the exact fail-open that coercion would have produced. Terminal
  verdicts are scoped to the token they were recorded for, so a fresh login does not
  inherit a replaced token's death sentence.
- **`assertCodexLeaseFailoverBudget` refuses to over-claim** (`withRetry.ts:448-471`):
  budget exhaustion reports `ambiguous_rate_limit` rather than inferring
  `quota_exhausted` from the error class, because pool-wide exhaustion was never actually
  established. That distinction is what keeps an unattended resume honest.

## Not reviewed / uncertain

- **I ran no tests.** Every finding is source-verified by reading; the only execution was
  read-only `rg` and a `ls -l` of the two vault directories (metadata only — no credential
  file contents were read). The permissions finding is the one claim backed by live
  observation.
- **Timing width of the HIGH #1 cross-process case.** The single-process startup trigger
  (`touchAll` + 1 Hz probe on the same near-expiry quarantined account) is deterministic
  from source. The two-process variant depends on both processes having the account
  quarantined/near-expiry simultaneously; I did not build a probe for it. A
  `contend-quarantine-probe` mode added to `accountRefreshContention.probe.child.ts`
  (probe in child A, `refreshAccountTokens` in child B, assert `server.attempts.length === 1`
  **and** that the vault ends holding the rotated token) would settle it — and would be the
  regression test for the fix.
- **Claude-side refresh-token rotation frequency.** `refreshOAuthToken`
  (`services/oauth/client.ts:206`) defaults `refresh_token` to the old value when the
  server omits it, so HIGH #3's severity depends on how often Anthropic actually rotates.
  If it never rotates, #3 degrades from "burns the chain" to "B wastes a refresh and
  wrongly marks an account dead" — still a real defect via
  `withRetry.ts:551` `failoverClaudeAccount`, but not credential loss. Server behaviour is
  not observable from this repo.
- **`codexAccountLeaseManager.ts`** was read only where `withRetry` depends on it
  (`failoverCodexLease`, cap semantics). It was outside my assigned file list and is not
  audited here.
- **`getRetryDelay`'s uncapped `retry-after`** (`withRetry.ts:1310-1315`) honours an
  arbitrary server header in the non-persistent path with no ceiling; the code comments at
  `:1225-1227` show this is a deliberate decision (capped only in persistent mode), and it
  is unchanged from `main`, so I did not file it as a finding.
