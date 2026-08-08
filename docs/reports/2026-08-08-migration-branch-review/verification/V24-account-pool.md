# S04 adversarial validation: account pool, token rotation, retry

> **Verification provenance:** `claude-opus-5`, high effort, single subagent session.
> Source review plus **four standalone scratch repro scripts** that import the real
> repo modules and exercise the real vault writers against temp directories
> (`/private/tmp/.../scratchpad/{f1,med,high23,low1}-repro.ts`). No repo file was
> edited except this report. **No test file was run** — every runtime claim below is
> backed by a repro I executed, not by a suite. No GUI, no `bun run --cwd app dev`,
> no full suite. The operator's real `~/codex-vault` and `~/claude-vault` were read
> for **directory metadata only** (`ls -l`); no credential file contents were read
> and nothing under either vault was written. Branch `migration` at `a17e5e9`.

## Overall verdict

The original report is **substantially right on the small findings and wrong on its
headline**. Seven of eleven findings are confirmed, three survive with a materially
narrower consequence, and the one finding it named as "the single most important
thing to fix" is **INVALID**: `persistNextQuarantineProbe` spreads `...refreshState`
at `codexTokenRefresh.ts:913`, so `attempt_id` is **preserved**, not destroyed. I
built the exact interleaving the report describes — refresh parked in `fetch` under
the lock, 1 Hz probe tick fires — and the account came out **healthy with the
rotated token committed to the vault**. Every step downstream of the attempt-id
clobber therefore never executes.

The second thing that changes the picture: **all eleven findings are pre-existing on
`main`.** `codexIdentityReconciliation.ts` is the only branch-new file cited, and
`git show main:src/services/api/codexTokenRefresh.ts` proves the branch merely
*extracted* that logic unchanged from an inline block. **Nothing in this scope
blocks the `migration` branch.** These are engine-wide credential-handling issues
that predate the migration program.

What most deserves action is not what the report ranked first. In priority order:
the **0644 credential-file modes** (F6 — confirmed live on this machine, real OAuth
refresh tokens are world-readable right now, one-line fix), the **inert
`expectedPreviousAccountId`** (F4 — a lying compare-and-swap on the highest-consequence
write in the repo, proven inert), and a **finding the report missed**:
`updateActiveClaudeAccountTokens` writes refreshed credentials to whatever account is
active *at write time*, which I demonstrated writing account U's rotated tokens into
account V's vault file.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Quarantine probe clobbers in-flight `attempt_id` | **INVALID** | `...refreshState` spread preserves `attempt_id`; repro ends healthy with R1 committed |
| F2 | HIGH | Claude vault written non-atomically, failure invisible | **PARTIALLY CONFIRMED** | Non-atomicity real; the corrupted account is re-added from keychain and the file repaired |
| F3 | HIGH | Claude pool lock re-check reads memory, not disk | **PARTIALLY CONFIRMED** | Staleness fully confirmed; the harm needs Anthropic refresh-token rotation, which is unproven |
| F4 | MED | `expectedPreviousAccountId` accepted, never read | **CONFIRMED** | Write proceeded with `expected=A` while the file held `B` |
| F5 | MED | Identity reconciliation destroys alias, resurrects dead account | **CONFIRMED** | Repro: alias `backup` gone, `dead` → `healthy`; also silently clears a terminal verdict |
| F6 | MED | Vault credential files land at 0644 | **CONFIRMED** | Live `ls -l` mixed 644/600; repro reproduces 644 from both writers |
| F7 | MED | Two pools copy-pasted, diverge where safety lives | **CONFIRMED** | Accurate, except "byte-identical" is false (two comment lines differ) |
| F8 | MED | Cap state process-local, nothing durable | **CONFIRMED** | `saveCodexTokenToVault` writes only `tokens`/`last_refresh`/`refresh`/`alias` |
| F9 | LOW | Throw inside the probe's catch escapes a `void` timer | **CONFIRMED** | Repro produced a real `unhandledRejection` from `void runQuarantineProbeOnce()` |
| F10 | LOW | 1 Hz synchronous vault read per quarantined account | **CONFIRMED** | `readVault` at `:828` precedes the `next_probe_at` gate at `:833` |
| F11 | LOW | `fetchPoolUsage` floating inside a `.catch()` that cannot see it | **PARTIALLY CONFIRMED** | Shape is exactly as described; no reachable rejection source found |

## Per finding

### F1 — [HIGH] Quarantine probe clobbers an in-flight refresh's attempt ownership, losing the rotation and killing the account

- **Verdict**: **INVALID**
- **Cited location holds?**: Partly. `persistNextQuarantineProbe` is at
  `src/services/api/codexTokenRefresh.ts:881-924`, called from `:838` and `:863`, and it
  *is* an unlocked whole-vault read-modify-write whose only early return is
  `if (refreshState.state === 'reauth_required') return` (`:892`). All of that is
  accurate. **The load-bearing assertion is not.** The report's step 2 says the probe
  "writes `refresh = {state:'unknown', next_probe_at: …}` — `attempt_id X` is gone."
  The actual write is:

  ```ts
  vault.refresh = {
    ...refreshState,          // ← line 913: attempt_id, refresh_token_hash,
    state: 'unknown',         //   started_at and pid all survive
    failed_at: …, reason, consecutive_failures, next_probe_at,
  }
  ```

  `attempt_id` survives verbatim, so the ownership check at `:526`
  (`latest.refresh?.attempt_id !== attemptId`) is **true-owner**, not lost-owner.
- **Reachable in production?**: The *setup* is reachable and I confirmed each
  precondition the parent asked about, so the refutation does not rest on
  unreachability:
  - `touchAll` genuinely does **not** skip quarantined accounts —
    `codexTokenRefresh.ts:657-695` skips only on missing token fields, refresh skew
    (`:679`) and file lock (`:689`). **The report is right here.**
  - The 1 Hz probe genuinely **does** run concurrently with pool init —
    `codexAccountPool.ts:221-228` calls `startQuarantineProbe()` at `:224` and
    `void touchAll()` at `:226` in the same block. One caveat the report omitted:
    `touchAll` is gated by `shouldRunStartupCodexTouchAll()` (`:162-164` =
    `!getIsNonInteractiveSession()`), so a `-p` one-shot never fires it. Interactive
    REPL does.
  - An account genuinely **can** load as `quarantined`: `getVaultRefreshPoolStatus`
    (`codexAccountPool.ts:1177-1187`) maps `refresh.state === 'unknown'` to
    `quarantined`.
  - The in-process single-flight genuinely **is** bypassed: `:838` calls
    `persistNextQuarantineProbe` *before* `:839` joins the pending promise.
  Every precondition holds. The chain still fails, at the clobber itself.
- **Trigger**: I constructed the report's exact trigger. Vault with
  `refresh: {state:'unknown'}` and a token inside refresh skew; pool seeded with that
  account as `quarantined` with `vaultFilePath` + `refreshToken`;
  `refreshAccountTokens` parked inside a mocked `fetch`; `runQuarantineProbeOnce()`
  fired at that instant; then the server rotates R0 → R1. **Outcome: no failure.**
- **Counter-arguments considered**: I looked specifically for a way to *rescue* the
  claim rather than only to break it. (a) Could `attempt_id` be dropped on some other
  path? `writeUnknownRefreshState` (`:242-250`) sets `attempt_id` explicitly rather
  than spreading, but it is called only from inside the lock by the owner itself, and
  it passes the owner's own id. (b) Could the probe's read and write straddle the
  refresh's write *within one process*? No — `persistNextQuarantineProbe` is fully
  synchronous end to end (`readFileSync` → compute → `atomicWriteJson`), so nothing
  can interleave. (c) Could `git log -L 881,924` show the report read an older
  revision? The spread has been present through both `d364f6e` and `3e38f80`; the
  version `3e38f80` *removed* even had a comment asserting the spread's preservation
  behaviour. (d) Cross-process, could a probe in process B revert process A's token
  write? **Yes — this is the one real residual**, but it is a different mechanism
  (last-writer-wins on `vault.tokens`, not `attempt_id`), it needs A's whole
  `atomicWriteJson` to land inside B's sub-millisecond read→rename window, and it
  produces a lost rotation rather than the described terminal verdict.
- **True consequence**: In the described single-process startup collision, **nothing
  bad happens**: the refresh completes, the vault holds the rotated token, the account
  is healthy, and exactly one network round-trip is spent. The only observable effect
  of the probe write is a spurious `consecutive_failures` bump (1 → 2) and a
  `next_probe_at` reservation, both of which the succeeding refresh immediately erases
  by writing `refresh = {state:'idle'}`. There is a genuine but far narrower
  cross-process last-writer-wins window on the unlocked write.
- **Evidence**: `scratchpad/f1-repro.ts`, run as
  `NODE_ENV=test bun run …/f1-repro.ts` (the `NODE_ENV` is only to satisfy config's
  `Config accessed before allowed` guard for a standalone script):

  ```
  AFTER intent write (in_flight): {"state":"in_flight","attempt_id":"1e84a2c6-…","refresh_token_hash":"4439e448…","started_at":"…","pid":70529,"consecutive_failures":1}
  AFTER probe tick        : {"state":"unknown","attempt_id":"1e84a2c6-…","refresh_token_hash":"4439e448…","started_at":"…","pid":70529,"consecutive_failures":2,"failed_at":"…","reason":"quarantine probe in progress","next_probe_at":"…"}
  attempt_id preserved?   : true
  refresh outcome         : RESOLVED status=refreshed refreshToken=R1
  probe outcome           : [{"accountId":"78c15115-…","status":"refreshed"}]
  FINAL vault.refresh     : {"state":"idle"}
  FINAL vault refresh_tok : R1
  FINAL pool status       : healthy | lastError: undefined
  fetch calls             : 1
  ```

  Provenance: `git show main:src/services/api/codexTokenRefresh.ts` contains
  `persistNextQuarantineProbe` at `:876` — **pre-existing on `main`**, not branch-new.
- **Disposition**: **Do not ship the report's fix as a fix for this bug — there is no
  bug to fix.** The proposed one-liner (`|| refreshState.state === 'in_flight'`) is
  *harmless and mildly useful*: it avoids spuriously bumping `consecutive_failures`
  against another process's in-flight attempt, and the function's own comment already
  documents that a missing backoff reservation costs only one extra probe. But
  shipping it with the report's rationale attached would enshrine a false causal story
  in the comment block of the most safety-critical file in this scope, and that is
  worse than the fix is good. If anything is done here, do the **actually** correct
  thing the report itself parenthesised: take `lock(vaultFilePath)` around the backoff
  write with short retries and skip on `ELOCKED`, closing the cross-process
  last-writer-wins window on `vault.tokens`. That is a LOW-severity hardening item,
  not the top of this scope's queue. The report's proposed regression probe
  (`contend-quarantine-probe` in `accountRefreshContention.probe.child.ts`) is still
  worth building — it would pin the *cross-process* property, which is the only part
  that was ever at risk.

### F2 — [HIGH] Claude vault credential file is written non-atomically, and a failed write is invisible

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `saveClaudeTokenToVault`
  (`src/services/api/claudeAccountPool.ts:624-663`) does
  `writeFileSync(filePath, …, 'utf-8')` at `:655` — truncate-in-place, no temp file,
  no rename, no fsync, no mode, no lock — returns `void`, and swallows the error into
  `logForDebugging` at `:657-662`. The contrast is exactly as described:
  `saveCodexTokenToVault` (`codexAccountPool.ts:761-763`) does temp+rename,
  `atomicWriteJson` (`codexTokenRefresh.ts:926-965`) does temp+0600+fsync+rename+dir-fsync,
  and `setClaudeAccountAlias` (`:598-601`) does temp+rename.
- **Reachable in production?**: Yes. `updateActiveClaudeAccountTokens` (`:517-537`)
  calls it at `:535`, and `auth.ts:1651` calls *that* unconditionally in the
  lock-held success arm of `checkAndRefreshOAuthTokenIfNeededImpl`. Not a rare branch:
  it is the only write-back after every successful Claude OAuth refresh. It is *not*
  gated on the pool being multi-account — the only guard is
  `if (!pool.initialized || pool.activeIndex < 0) return` (`:524`), and
  `initClaudeAccountPool()` runs unconditionally at `src/entrypoints/init.ts:96`.
  There are three call sites total (`:164` migration, `:453` switch, `:535` refresh).
- **Trigger**: `writeFileSync` opens with `O_TRUNC` before writing. A crash, an
  ENOSPC, or an EACCES between truncate and write completion leaves the file empty or
  partial, and the throw is swallowed. I simulated the resulting on-disk state
  (`'{"tokens": {"access_to'`) and confirmed `loadVaultAccounts` throws in
  `JSON.parse`, is caught at `:719`, and the entry is dropped.
- **Counter-arguments considered**: This is where the finding narrows, and the report
  missed it. **The keychain/config fallback rescues exactly the account this writer
  writes.** All three call sites write the account that is (or is becoming) *active*,
  and `auth.ts:1647` `saveOAuthTokensIfNeeded(refreshedTokens)` has already written
  that same account to the keychain *before* the vault write. On the next start,
  `loadClaudePoolForObservation` (`:101-133`) merges `loadConfigAccount()` — a
  keychain read — into the pool when the uuid is missing from the vault (`:110-113`),
  and `initClaudeAccountPool` (`:162-166`) then finds the entry with no
  `vaultFilePath` and **rewrites the corrupted vault file**. I verified this end to
  end. I also checked whether a *non-active* account could be corrupted by this writer:
  it cannot, because none of the three call sites target one.
- **True consequence**: Not "the account silently disappears from the pool on next
  start." The account is re-added from the keychain and its vault file is repaired
  automatically. What is genuinely and permanently lost is **vault-only metadata —
  the alias** (`alias` is not in the keychain, so the repaired file comes back with
  `alias: undefined`, and the user must re-run `/rename`) — plus one degraded start.
  If a two-account user's file is lost and not recovered, `pool.accounts.length`
  drops to 1, `shouldUseClaudePoolTokenSource()` goes false, and the process quietly
  degrades to the single-account keychain path. The `void`-return / unconditional
  `vaultFilePath` stamp at `:162-166` is real but low-consequence:
  `setClaudeAccountAlias` fails closed on the missing file and `removeClaudeAccount`
  guards with `existsSync`.
- **Evidence**: `scratchpad/med-repro.ts` and `scratchpad/high23-repro.ts`:

  ```
  claude saveClaudeTokenToVault mode: 644
  claude pool after truncated file  : 0 accounts          ← with no keychain account
  (a) after corruption, observation load: 2 accounts -> dddd:at-v:vaultFile=yes cccc:at-keychain:vaultFile=NO
  (a) after initClaudeAccountPool     : 2 accounts
  (a) U vault file repaired?          : at-keychain | alias now: undefined
  ```

  Provenance: `git show main:src/services/api/claudeAccountPool.ts` has the identical
  `writeFileSync(filePath, …)` at `:598` — **pre-existing on `main`**.
- **Disposition**: Apply the report's fix; it is correct and cheap. Write to
  `.<pid>.<ts>.tmp` in the same directory **with `{ mode: 0o600 }`**, `renameSync`
  onto the target, and return `string | null` so `initClaudeAccountPool:162-166` only
  stamps `vaultFilePath` on success. One addition the report did not ask for and that
  I would insist on: **carry the alias through the repair path**, or the atomicity fix
  silently leaves the real user-visible loss (alias) in place. Do **not** escalate
  this to fsync + dir-fsync parity with `atomicWriteJson` in the same change; the
  recovery path exists and the extra syscalls are on the hot refresh path. This is a
  MED, not a HIGH.

### F3 — [HIGH] Claude multi-account refresh has no cross-process rotation safety: the lock's re-check reads memory, not disk

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes, all six citations. `shouldUseClaudePoolTokenSource`
  is `pool.initialized && pool.accounts.length > 1 && some(healthy)`
  (`claudeAccountPool.ts:199-205`). `getClaudeAIOAuthTokens` short-circuits to the
  in-memory pool at `auth.ts:1305-1320`, and `getClaudeAIOAuthTokensAsync` does the
  same at `:1502-1516`. The pre-lock re-read is at `:1580-1590` and the post-lock
  re-read at `:1626-1636`; both clear the memoize and keychain caches and then read
  the same in-memory pool.
- **Reachable in production?**: The staleness mechanism, yes — and I confirmed the
  three escape hatches the report did not check. (a) `initClaudeAccountPool` /
  `loadClaudePoolForObservation` have exactly **one** production caller,
  `src/entrypoints/init.ts:96`; nothing reloads the pool for the life of the process.
  (b) `invalidateOAuthCacheIfDiskChanged` (`auth.ts:1412-1428`) — which *looks* like
  the cross-process staleness guard, and which `checkAndRefreshOAuthTokenIfNeededImpl`
  calls first at `:1561` — only calls `clearOAuthTokenCache()`; it never touches the
  pool, so for pool users it is a no-op on the returned value. (c) There is no mtime
  watcher or reload anywhere in `claudeAccountPool.ts`. So the report is right that
  every "did another process already refresh?" check is blind, and right that the
  `handleOAuth401ErrorImpl` shortcut at `:1477-1480` can never fire for pool users.
  Gate: needs ≥2 vault accounts with ≥1 healthy — a real but uncommon configuration.
- **Trigger**: Two engine processes, ≥2 Claude accounts, token near expiry, **and
  Anthropic rotating the refresh token on refresh**. Without that last condition
  there is no failure at all: `refreshOAuthToken` succeeds with the not-yet-rotated
  refresh token and B simply performs a redundant refresh.
- **Counter-arguments considered**: I looked for a vault re-read, a keychain fallback,
  a repair, and a lock that would make this moot, and found none — the mechanism
  survives. What does *not* survive intact is the consequence. (a) The rotation
  premise: the report itself flagged in its own uncertainties section that
  `refreshOAuthToken` (`services/oauth/client.ts:206`) defaults `refresh_token` to the
  old value when the server omits it, which is exactly the shape you write when the
  server *usually omits it*. Anthropic's rotation behaviour is not observable from
  this repo and I did not test against the live service (that would burn real
  credentials). **Unproven, and it is the whole severity.** (b) The blast radius:
  `failoverClaudeAccount` (`claudeAccountPool.ts:365-387`) sets `status = 'dead'` in
  memory and explicitly does **not** persist — the doc comment at `:360-364` says so,
  and `initClaudeAccountPool` recomputes status from `last_refresh` next start. So
  "marks a perfectly healthy account dead" is process-local and self-healing, not
  durable. (c) The failover arm at `withRetry.ts:541` is additionally gated on
  `isClaudePoolActive()` (>1 **healthy**), so it cannot strand the last account —
  and when it can't find a replacement it throws rather than looping.
- **True consequence**: For a ≥2-account Claude user running two processes: at worst
  one wasted refresh round-trip and one account marked dead **in one process's
  memory**, recovered on that process's next start. If Anthropic does rotate refresh
  tokens, it escalates to a spent-token chain break for that account, requiring
  re-login — but that escalation is unproven.
- **Evidence**: `auth.ts:1412-1428`, `:1561`, `:1580-1590`, `:1626-1636`;
  `claudeAccountPool.ts:199-205`, `:365-387`; `withRetry.ts:535-577`;
  `rg -n "initClaudeAccountPool|loadClaudePoolForObservation" --glob '!*.test.*' src/`
  → one production caller. Provenance: `shouldUseClaudePoolTokenSource` at
  `main:src/services/api/claudeAccountPool.ts:146`, `updateActiveClaudeAccountTokens`
  at `main:…:464` — **pre-existing on `main`**.
- **Disposition**: The report's fix (mtime-triggered re-read of the active account's
  vault file, called from the two post-cache-clear points) is directionally right but
  I would **not** apply it as specified. Re-reading the *vault* still misses the
  authoritative source: `saveOAuthTokensIfNeeded` writes the **keychain** first, and
  the vault is the mirror. The narrower, more honest fix is to have
  `getClaudeAIOAuthTokensAsync` fall through to the keychain read when the pool's
  active-account token is expired — one condition, no new file-watching, and it
  restores the `handleOAuth401ErrorImpl:1477` shortcut for pool users, which is the
  actual recovery mechanism the lock protocol assumes. Given the unproven rotation
  premise, treat this as MED and schedule it behind F6/F4.

### F4 — [MED] `expectedPreviousAccountId` is accepted by the vault writer and never read

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. Declared at `codexAccountPool.ts:700`; passed at
  `codexTokenRefresh.ts:560`, `codex-core/accounts.ts:580`, and
  `codexIdentityReconciliation.ts:84`. `rg -n "expectedPreviousAccountId" src/`
  returns exactly those five lines and no read in the function body — the body
  computes its own `previousAccountId` at `:725-727` and uses it only for
  `accountChanged` (`:728`), the `shouldPreserve` decision (`:729-733`), and the log
  line at `:772`.
- **Reachable in production?**: All three call sites are live production paths (the
  stateful refresh identity-mismatch arm, the raw-refresh arm in `codex-core`, and the
  shared reconciliation module). No gate.
- **Trigger**: Call `saveCodexTokenToVault` with `expectedPreviousAccountId: A`
  against a file whose `tokens.account_id` is `B`. A compare-and-swap would return
  `null` without writing. It writes.
- **Counter-arguments considered**: I checked whether the guard might be implemented
  indirectly through `accountChanged`/`preserveExistingMetadata` — it is not:
  `accountChanged` compares the file against `tokens.accountId` (the account being
  *written*), never against `expectedPreviousAccountId`, and its only effect is on
  metadata preservation, never on whether the write happens. I also checked whether
  any caller inspects the return value in a way that emulates the guard — none does.
- **True consequence**: Exactly as claimed. Reviewers and future callers read a
  compare-and-swap that does not exist, on the single highest-consequence write in the
  repo, and the two identity-mismatch call sites are precisely where a caller would
  lean on it.
- **Evidence**: `scratchpad/med-repro.ts` —
  `MED#1 write happened despite expectedPreviousAccountId=A but file held B: true`.
  Provenance: declared at `main:src/services/api/codexAccountPool.ts:702` —
  **pre-existing on `main`**.
- **Disposition**: **Delete the field and the three call-site arguments.** The report
  offers implement-or-delete; implementing it is the wrong choice here. A CAS that
  returns `null` on mismatch would change the identity-mismatch path from "write the
  new profile" to "silently do nothing," and `reconcileCodexIdentityMismatch:103`
  already degrades `source` to `'config'` when `saved` is null — so implementing the
  guard would produce a live account whose credentials were never persisted, which is
  strictly worse than today. Delete it, and if a CAS is genuinely wanted later, design
  it with an explicit failure disposition first.

### F5 — [MED] Identity-mismatch reconciliation silently destroys an existing profile's alias and resurrects a dead account

- **Verdict**: **CONFIRMED** (and slightly understated)
- **Cited location holds?**: Yes. `reconcileCodexIdentityMismatch`
  (`codexIdentityReconciliation.ts:73-107`) calls `saveCodexTokenToVault` with
  `preserveExistingMetadata: false` and a `filePath` of `<newAccountId>.json`
  (`codexTokenRefresh.ts:559-563`). In the writer, `accountChanged` is **false**
  (the file already holds `newAccountId`), but `shouldPreserve` is still false because
  `options.preserveExistingMetadata !== false` fails (`:729-733`), so `data` starts as
  `{}` and the alias is never carried. `appendAccount`'s `preserveCapped` only guards
  `capped` (`:348-355`), so `dead` and `quarantined` are cleared to `healthy`.
- **Reachable in production?**: Yes, but narrow. It needs a refresh of profile A to
  return an identity for which a vault file already exists — e.g. a workspace/org
  change on the same login where the user had also logged in separately under the new
  identity. Not a gate, just an uncommon state.
- **Trigger**: Profiles `main` (A) and `backup` (B). B's file has `alias: "backup"`
  and a `reauth_required` verdict; B's pool entry is `dead`. A refresh of A returns
  B's identity.
- **Counter-arguments considered**: I checked whether `accountChanged === false` might
  route to the preserving branch — it does not, because `preserveExistingMetadata:
  false` short-circuits `shouldPreserve` independently. I checked whether the
  `delete data.alias` at `:757-759` is the mechanism (it is not — `data` starts empty,
  so the deletion is a no-op and the alias is lost by *omission*, which matters for
  the fix). I checked whether `appendAccount` preserves `dead` — it does not.
- **True consequence**: As claimed, plus one the report missed: because
  `previousRefreshToken !== tokens.refreshToken`, the writer also sets
  `data.refresh = { state: 'idle' }` (`:752-754`), so **B's terminal
  `reauth_required` verdict is silently cleared** by an unrelated account's rotation —
  the account is routed to as healthy on both axes.
- **Evidence**: `scratchpad/med-repro.ts`:

  ```
  B file before  : alias=backup mode=600
  B pool before  : dead
  B file after   : alias=undefined refresh={"state":"idle"} mode=644
  B pool after   : healthy
  ```

  Provenance: `git show main:src/services/api/codexTokenRefresh.ts` contains the
  identical inline block (`saveCodexTokenToVault(..., { expectedPreviousAccountId,
  filePath, preserveExistingMetadata: false })` + `appendAccount(..., {
  preserveCapped: true, activate: wasActiveOrMain })`). The branch only **extracted**
  it into `codexIdentityReconciliation.ts` — the behaviour is **pre-existing on
  `main`**.
- **Disposition**: Apply the report's second option, not its first. Set
  `preserveExistingMetadata: true` **when the target file's `tokens.account_id`
  already equals `newAccountId`** — in that case the existing metadata genuinely
  belongs to that account and preserving it is correct by construction, whereas
  reading and re-supplying just the alias leaves the `refresh`-verdict clearing and
  any other vault-only metadata still being destroyed. Keep
  `preserveExistingMetadata: false` for the file-does-not-exist and
  different-account-id cases, where wiping is the point.

### F6 — [MED] Vault credential files land at 0644, inconsistently, depending on which writer touched them last

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `codexAccountPool.ts:762`
  (`writeFileSync(tmpPath, …, 'utf-8')`) and `claudeAccountPool.ts:655`
  (`writeFileSync(filePath, …, 'utf-8')`) both omit `mode`.
  `atomicWriteJson` uses `openSync(tmpPath, 'w', 0o600)` (`codexTokenRefresh.ts:935`).
  `setClaudeAccountAlias:600` also omits `mode`, which the report did not list but
  which is a third instance of the same defect.
- **Reachable in production?**: Yes, and **currently live on this machine.**
- **Trigger**: Any login or `saveCodexTokenToVault` write under a default macOS umask
  of 022. I confirmed `process.umask() === 0o22` in the repro.
- **Counter-arguments considered**: I checked whether the vault *directory* mode might
  contain the exposure — `~/codex-vault/accounts` and `~/claude-vault/accounts` are
  traversable, and a 0644 file inside a 0700 directory would be safe. It is not:
  both listings show world-readable files and the directories are not restricting
  access, which is why the mixed state is observable at all. I also checked whether
  `renameSync` might normalise the mode — it does not; it preserves the temp file's
  mode, which is why the 0644 sticks.
- **True consequence**: Exactly as claimed. Real OAuth refresh tokens are readable by
  any local user for whichever files a login/`saveCodexTokenToVault` touched last.
- **Evidence**: `ls -l` (metadata only, contents never read):

  ```
  ~/codex-vault/accounts :  -rw-r--r--  ×3   -rw-------  ×2
  ~/claude-vault/accounts:  -rw-r--r--  ×2
  ```

  `scratchpad/med-repro.ts`: a pre-existing 0600 file was rewritten to **644** by the
  reconciliation path; a fresh `saveCodexTokenToVault` file is **644**; a fresh
  `saveClaudeTokenToVault` file is **644**. Provenance: `main:…:751` has the same
  mode-less `writeFileSync` — **pre-existing on `main`**.
- **Disposition**: Apply the report's fix, extended to the third site. Pass
  `{ mode: 0o600 }` to `writeFileSync` at `codexAccountPool.ts:762`,
  `claudeAccountPool.ts:655`, **and `claudeAccountPool.ts:600`**. Add a one-time
  `chmodSync(filePath, 0o600)` on load for files already sitting at 0644, or the fix
  never repairs the five files currently exposed on this machine — a new-writes-only
  fix leaves the live exposure in place. **This is the highest-value item in the
  scope**: smallest change, real present-tense exposure, zero behavioural risk.

### F7 — [MED] The two pools are the same concept copy-pasted, and the copies diverge exactly where safety lives

- **Verdict**: **CONFIRMED** (one precision error)
- **Cited location holds?**: Substantially. `checkAccountHealth` exists at
  `codexAccountPool.ts:1108-1114` and `claudeAccountPool.ts:776-781` with identical
  logic and identical constants. `countPoolStatuses` is duplicated at
  `codexAccountPool.ts:116` and `codexIdentityReconciliation.ts:15` (the former reads
  `pool.accounts`, the latter `getPoolStatus().accounts`). The resolvers are at
  `codexAccountPool.ts:515` and `claudeAccountPool.ts:243`. **The "byte-identical"
  claim is false**: `diff` shows the Codex copy carries two comments the Claude copy
  lacks (`// no timestamp, assume OK` and `// Match codex-nootp's CRITICAL threshold
  of 7 days`).
- **Reachable in production?**: N/A — design finding, both modules are live.
- **Trigger**: N/A.
- **Counter-arguments considered**: I checked whether the divergence is *justified*
  rather than accidental — i.e. whether the Claude path has a different threat model
  that makes locking unnecessary. It does not: `auth.ts:1593-1599` takes a
  `claudeDir` cross-process lockfile precisely because concurrent Claude processes are
  expected, so the Claude vault write is exposed to the same multi-writer world as the
  Codex one, without the same protections.
- **True consequence**: As claimed. The report's framing is the right one — this is
  not a style complaint; F2, F3 and half of F6 are all instances of "the Claude copy
  lacks what the Codex copy has."
- **Evidence**: `diff <(sed -n '1108,1114p' codexAccountPool.ts) <(sed -n '776,781p'
  claudeAccountPool.ts)` → two differing lines. Provenance: both files
  **pre-existing on `main`**.
- **Disposition**: Apply the report's fix, but **only the first half, and only after
  F2 and F6 land.** Extract `writeCredentialFileAtomic(path, data)` (temp + 0600 +
  rename, returning success) and use it from both writers — that is the primitive
  whose absence causes the real findings. **Do not** extract the resolver in the same
  change: `resolveCodexAccountByPrefix` and `resolveClaudeAccountByPrefix` match on
  different key sets (Claude matches `emailAddress`, Codex does not), so a generic
  version needs accessor plumbing that buys nothing safety-wise and touches a
  user-facing selection path for no reason. Fix the safety primitive; leave the
  cosmetic duplication.

### F8 — [MED] Runtime cap state is process-local by design, but nothing durable lets a fresh process avoid a known-capped account

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `markPoolAccountCapped` (`codexAccountPool.ts:469-489`)
  sets `usagePrimary`, `usageAllowed`, `usageLimitReached`, `usageResetAt`, `cappedAt`
  purely on the in-memory `acct`. `initAccountPool:230-235` fires
  `fetchPoolUsage({ updateRoutingHints: true })` fire-and-forget.
- **Reachable in production?**: Yes; no gate.
- **Trigger**: Any fresh `-p` one-shot after a prior process observed a cap. Note the
  interaction with F1's finding: `shouldRunStartupCodexTouchAll()` is false in
  non-interactive sessions, so a `-p` one-shot has even less startup signal than an
  interactive REPL.
- **Counter-arguments considered**: I verified there is genuinely no persistence path
  — `saveCodexTokenToVault` writes only `data.tokens`, `data.last_refresh`,
  `data.refresh` and `data.alias` (`:735-759`); no `usage` key is ever written, and
  `loadVaultAccounts:998-1013` seeds no `usageResetAt`. I also checked the report's
  safety argument for its own fix: `getCodexAccountAvailability:1551-1568` does route
  a `capped` account through `getHard429QuotaBelief` + `isQuotaObservationResetElapsed`,
  so an elapsed `resetAt` self-clears and a stale persisted value cannot strand an
  account. The report's reasoning holds.
- **True consequence**: As claimed. Each fresh one-shot under pool pressure burns one
  429 round re-deriving what the previous process already knew.
- **Evidence**: `rg -n "usageResetAt" src/services/api/codexAccountPool.ts` — all
  hits are in-memory reads/writes; `sed -n '734,760p'` shows the complete set of vault
  keys written. Provenance: `markPoolAccountCapped` at
  `main:src/services/api/codexAccountPool.ts:474` — **pre-existing on `main`**.
- **Disposition**: Apply the report's fix as written — persist only
  `usage: { reset_at }` (the server-reported fact), never `status`/`cappedAt` (local
  belief). The report's own reasoning for the split is correct and its safety argument
  checks out against `:1551-1568`. Low priority: this costs quota, not credentials.

### F9 — [LOW] A throw inside the quarantine probe's own catch block escapes a 1 Hz `void`-called timer

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `persistNextQuarantineProbe` is called from the
  catch arm at `codexTokenRefresh.ts:863`, with no `try` around it; the timer is
  `void runQuarantineProbeOnce()` at `:788-790`. The `finally` at `:876-878` does
  correctly reset `quarantineProbeInFlight`, so the timer keeps firing.
- **Reachable in production?**: Yes — `atomicWriteJson` throws on EACCES/ENOSPC/EROFS
  in the vault directory.
- **Trigger**: I made `~/…/accounts` mode 0500 and fired one probe tick. The write at
  `:838` throws EACCES, is caught at `:851`, and the retry at `:863` throws again and
  escapes.
- **Counter-arguments considered**: I checked whether the process-level
  `unhandledRejection` handler (`gracefulShutdown.ts:327+`) converts this into a
  crash — it does not; it logs and calls `logEvent`, so the report's "noise rather
  than a crash" characterisation is correct. I also checked whether the escape
  aborts the whole probe *permanently* — it does not, because `finally` clears the
  in-flight flag, so the 1 Hz timer keeps re-entering and re-throwing.
- **True consequence**: Exactly as claimed — a 1 Hz unhandled-rejection/telemetry
  stream, no backoff reservation ever written, and any accounts after the failing one
  in the loop are skipped that tick.
- **Evidence**: `scratchpad/low1-repro.ts` →
  `unhandled rejection observed: Error: EACCES: permission denied, open '…/.78c15115-….json.<pid>.<ts>.tmp'`.
  Provenance: `main:src/services/api/codexTokenRefresh.ts:858` has the same
  unguarded call — **pre-existing on `main`**.
- **Disposition**: Apply the report's fix exactly: wrap the `:863` call in
  `try {} catch {}` and attach `.catch(() => {})` to `void runQuarantineProbeOnce()`
  in the interval. Both halves are needed — the `try/catch` stops the escape from the
  known source, the `.catch` is the backstop for anything else in the loop. Note the
  report's own F1 fix would *not* have prevented this.

### F10 — [LOW] The quarantine probe does a synchronous vault read per quarantined account every second, indefinitely

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `QUARANTINE_PROBE_INTERVAL_MS = 1_000` at `:782`;
  `readVault(vaultFilePath)` at `:828` executes **before** the `next_probe_at` gate at
  `:833-835`; the backoff ladder tops out at 300s (`:783`).
- **Reachable in production?**: Yes, whenever at least one account is `quarantined`.
- **Trigger**: One quarantined account for one day = 86,400 synchronous
  `readFileSync` + `JSON.parse` on the main thread.
- **Counter-arguments considered**: I checked whether the timer is a no-op in the
  common case — it largely is: with zero quarantined accounts the filter at `:819-824`
  yields nothing and no disk read happens, so the cost is conditional, not
  unconditional. I also confirmed `unref()` is called (`:792-798`) so it does not hold
  the process open, and `startQuarantineProbe` is gated on the pool having vault
  accounts (`codexAccountPool.ts:221`).
- **True consequence**: As claimed, but only while an account is quarantined. Not
  an always-on idle cost.
- **Evidence**: `codexTokenRefresh.ts:782`, `:812-835`. Provenance:
  `main:…:777`, `:807` — **pre-existing on `main`**.
- **Disposition**: Take the second half of the report's fix only — **raise the tick to
  5s** (the shortest backoff rung, so no responsiveness is lost). Do **not** add the
  in-memory `next_probe_at` cache: it introduces a second source of truth for a value
  that is deliberately on disk so *other processes* can see the reservation, and this
  is a file the project has already been burned by adding memory-vs-disk divergence to
  (see F3). One-line constant change, no new state.

### F11 — [LOW] `fetchPoolUsage` is launched as a floating promise inside a `.catch()` that cannot see it

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `codexAccountPool.ts:232-234` is exactly
  `import('./codexUsage.js').then(({ fetchPoolUsage }) => { void fetchPoolUsage(…) }).catch(() => {})`.
  The `void` discards the inner promise, so the trailing `.catch` covers only the
  dynamic import and synchronous throws in the callback. The report's structural
  description is precisely right. There is a **second, unreported instance** at
  `codexAccountPool.ts:322-323` with the same shape.
- **Reachable in production?**: The *shape* is; the *failure* I could not reach. I
  traced `fetchPoolUsage` (`codexUsage.ts:257-310`): per-account work is individually
  caught (`:277-291`), and the two unguarded calls the report names —
  `updateRoutingHintsFromUsage(results)` (`:299-301`) and
  `emitCachedUsageWarningsForActiveSink()` (`:269`) — are pure in-memory pool
  mutations and diagnostic emissions with no I/O and no obvious throw. `emitUsageWarnings`
  (`:295`) is likewise unguarded.
- **Trigger**: **None constructed.** Per the contract, a defect I cannot trigger does
  not get the benefit of the doubt.
- **Counter-arguments considered**: I looked for a throw inside
  `updateRoutingHintsFromUsage` / `emitUsageWarnings` that a malformed usage response
  could reach, since that is the only externally-influenced input. The per-account
  fetch that produces those inputs is itself wrapped, and the downstream code is
  defensive about field types. I could not find a path.
- **True consequence**: Today, none observable. If any of those three helpers ever
  starts throwing, the rejection is unhandled at startup rather than swallowed.
- **Evidence**: `codexAccountPool.ts:232-234`, `:322-323`; `codexUsage.ts:257-310`.
  Provenance: `main:src/services/api/codexAccountPool.ts:201-202` — identical,
  **pre-existing on `main`**.
- **Disposition**: Apply the report's one-line fix (`return fetchPoolUsage(…)` instead
  of `void fetchPoolUsage(…)`) **and apply it to `:322-323` too**, which the report
  missed. It is free and correct. But file it as hygiene, not as a defect — there is
  no known rejection source, and the report's "becomes an unhandled rejection at
  startup" is conditional on a throw nobody has demonstrated.

## Findings the original report missed

### [HIGH] `updateActiveClaudeAccountTokens` writes refreshed credentials to whichever account is active at write time, not the one whose refresh token was spent

- **Where**: `src/services/api/claudeAccountPool.ts:517-537`, driven from
  `src/utils/auth.ts:1629-1651`
- **What**: `checkAndRefreshOAuthTokenIfNeededImpl` reads the account to refresh via
  `getClaudeAIOAuthTokensAsync()` → `getActiveClaudeAccount()` (`:1629`), awaits the
  network in `refreshOAuthToken` (`:1639`), then writes the result with
  `updateActiveClaudeAccountTokens(refreshedTokens)` (`:1651`). That function does not
  take an account id — it writes to `pool.accounts[pool.activeIndex]` **as of the
  moment it is called** (`:524-535`). Nothing pins the write to the account that was
  read. If `activeIndex` moves during the await, account X's rotated credentials are
  written into account Y's pool entry **and Y's vault file**.
- **Why it is reachable**: two independent mutators move `activeIndex` while a refresh
  is awaiting. (a) `failoverClaudeAccount` (`:365-387`) is called from
  `withRetry.ts:551` on a concurrent request's 401 — and the forced refresh path is
  **not** deduplicated (`checkAndRefreshOAuthTokenIfNeeded(0, true)` skips the
  `pendingRefreshCheck` guard at `auth.ts:1540`, and `pending401Handlers` dedups only
  on identical `failedAccessToken`, which differs between accounts). (b)
  `getActiveClaudeAccount()` itself **rerolls** `pool.activeIndex` whenever the current
  active is not healthy (`:211-216`), so even a read can move the pointer. (c) an
  operator `/accounts` switch during an in-flight refresh does the same.
- **Consequence**: Y's vault file and pool entry hold X's credentials; X's own file
  still holds its now-spent refresh token. This is precisely the rotation-loss +
  credential-cross-contamination class that the Codex path spends `attempt_id`
  correlation (`codexTokenRefresh.ts:526`) and `correlateRefreshVerdict`
  (`codexAccountPool.ts:1139-1157`) eliminating. The Claude path has no equivalent.
- **Evidence**: `scratchpad/high23-repro.ts`, run against real modules:

  ```
  (b) refresh reads active   : cccc  refreshToken= rt-cccc
      … failoverClaudeAccount(U) fires during the await …
  (b) V vault file now holds : U-NEW-ACCESS / U-NEW-REFRESH
  (b) V pool entry now holds : U-NEW-ACCESS
  ```

  Provenance: `updateActiveClaudeAccountTokens` at
  `main:src/services/api/claudeAccountPool.ts:464` — **pre-existing on `main`**,
  so this does not block the branch either.
- **Disposition**: Change the signature to
  `updateClaudeAccountTokens(accountUuid, tokens)` and have `auth.ts` pass the uuid it
  read at `:1629`, resolving by uuid rather than by `activeIndex`. Reject the write
  (log, do not throw) if that uuid is no longer in the pool. This is a small, local,
  strictly-safer change and it is the cheapest correctness win available in the Claude
  pool. It also subsumes part of F3: pinning the write to the read account removes one
  of the two ways a stale pool can corrupt a *different* account.

## Provenance summary (branch-blocking assessment)

| Finding | Cited file | On `main`? | Blocks `migration`? |
|---|---|---|---|
| F1 | `codexTokenRefresh.ts:881` | yes (`main:876`) | no — and INVALID |
| F2, F3, F7(claude), missed | `claudeAccountPool.ts` | yes (`main:567/464/146`) | no |
| F4 | `codexAccountPool.ts:700` | yes (`main:702`) | no |
| F5 | `codexIdentityReconciliation.ts` (branch-new file) | **behaviour** yes — extracted verbatim from `main:codexTokenRefresh.ts` | no |
| F6 | `codexAccountPool.ts:762`, `claudeAccountPool.ts:655` | yes (`main:751`, `main:598`) | no |
| F8, F11 | `codexAccountPool.ts:469/232` | yes (`main:474`, `main:201`) | no |
| F9, F10 | `codexTokenRefresh.ts:863/782` | yes (`main:858`, `main:777`) | no |

**No finding in this scope is introduced by the `migration` branch.** The only
branch-new artefact is the *extraction* of identity-mismatch handling into
`codexIdentityReconciliation.ts`, which is behaviour-preserving.

## Uncertainty

- **Anthropic refresh-token rotation frequency (F3's severity).** Not observable from
  this repo and I did not test against the live service, since that would spend real
  credentials. `services/oauth/client.ts:206` defaulting `refresh_token` to the old
  value when omitted is suggestive that omission is common, but it is not proof. What
  would settle it: one instrumented real refresh recording whether the response
  carries a changed `refresh_token`. Until then F3's consequence stays at "wasted
  refresh + in-memory dead mark," not "credential chain broken."
- **Cross-process window on `persistNextQuarantineProbe` (F1's residual).** The
  single-process claim is disproven with a repro. The cross-process last-writer-wins
  window on `vault.tokens` is real by inspection but I did not build a two-process
  probe for it, and its width (read → compute → `openSync`/`write`/`fsync`/`rename`)
  is sub-millisecond. A `contend-quarantine-probe` mode in
  `accountRefreshContention.probe.child.ts` would settle it.
- **`codexAccountLeaseManager.ts`** was read only where `withRetry` depends on it;
  same limitation the original report declared, and I did not widen it.
- **I ran no test file.** Every runtime claim is from a scratch script exercising the
  real modules. The corresponding suites (`codexTokenRefresh.test.ts`,
  `claudeAccountPool.test.ts`, `codexIdentityReconciliation.test.ts`) were read for
  harness shape but not executed, so I cannot report on whether any proposed fix
  breaks an existing assertion — that check belongs to whoever applies the fixes.
