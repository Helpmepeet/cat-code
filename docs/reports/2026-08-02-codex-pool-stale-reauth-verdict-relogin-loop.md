# Codex pool: a stale reauth verdict survives login, forcing repeated re-logins — 2026-08-02

**Status: FIXED (Defect 1) · DEFECT 2 STILL OPEN · OPERATOR ACCEPTANCE NOT RUN.** Fixes 1, 2 and the test seam below are implemented and verified against the real vault read-only: the pool now loads **3 of 5** accounts usable, and the saved active account (`bluesky`) is restored instead of being silently replaced. Fix 3 (the age heuristic, Defect 2) is deliberately not included and remains open. No credential file was modified. Reported symptom: "I have to login to codex account many times, I don't think I did anything that forced me to relogin." The symptom is real and is not user-caused. Two independent defects in the vault status path make accounts that hold valid tokens load as `dead`. The primary defect makes a successful login produce a dead account, so logging in cannot clear the condition it is being prompted for.

Live pool state at time of writing: **1 of 5 accounts usable**. Two of the four dead accounts hold valid, unexpired tokens.

## Executive conclusion

A terminal `reauth_required` verdict is written into a vault profile's `refresh` block when the OAuth token endpoint rejects a refresh token. That verdict is correctly scoped to a specific token by `refresh_token_hash`. Two consumers read it:

- The **refresh path** honors the verdict only when the hash matches the token it is about to use ([codexTokenRefresh.ts:326-330](src/services/api/codexTokenRefresh.ts:326)). This is correct: a verdict about a superseded token says nothing about its replacement.
- The **pool loader** honors the verdict unconditionally, never comparing the hash ([codexAccountPool.ts:1143](src/services/api/codexAccountPool.ts:1143)).

Meanwhile the login write preserves the `refresh` block verbatim ([codexAccountPool.ts:729](src/services/api/codexAccountPool.ts:729)), so a fresh login replaces the tokens but leaves the old verdict in place. The account is therefore declared dead on the strength of a verdict about a refresh token that no longer exists in the file.

The result is a closed loop:

1. Account is marked `reauth_required` (correctly, at the time).
2. Operator logs in. New tokens are written. The `refresh` block is preserved unchanged.
3. In memory the pool marks the account healthy ([codexAccountPool.ts:351](src/services/api/codexAccountPool.ts:351), whose comment states "Login should reset status"), so the current session works and the login appears to have succeeded.
4. Next process start reloads from the vault, sees `reauth_required`, and marks the account `dead`.
5. Account is unusable, operator is prompted to log in, return to step 2.

Nothing in the persisted state ever records step 3's reset. The in-memory half of "login resets status" exists; the on-disk half does not.

## Scope and evidence

| Item | Value |
|---|---|
| Area | Engine (`src/`), Codex account pool |
| Vault | `/Users/pt/codex-vault/accounts` (5 profiles), resolved via `~/.codex-nootp/config.toml` |
| Owner files | `src/services/api/codexAccountPool.ts`, `src/services/api/codexTokenRefresh.ts`, `src/components/ConsoleOAuthFlow.tsx` |
| Branch during investigation | `migration` |
| Verification method | Real production functions executed against synthetic vaults in a sandboxed `HOME`, plus one read-only pass over the real vault with a before/after mtime guard |

No vault file was modified during this investigation. The read-only pass asserts `vault untouched by this check: true`.

## Defect 1 (primary): the loader ignores the verdict's token scope

### Current vault state

Comparing each profile's stored `refresh_token_hash` against the SHA-256 of the `refresh_token` actually present in the same file:

| alias | refresh.state | reason | verdict matches current token | token expires |
|---|---|---|---|---|
| `onbi` | `idle` | — | n/a | 2026-08-11 |
| `bluesky` | `reauth_required` | `refresh_token_invalidated` | **no** | 2026-08-10 |
| `main` | `reauth_required` | `refresh_token_invalidated` | **no** | 2026-08-08 |
| `yoxrent2` | `reauth_required` | `http_401` | yes | 2026-07-13 (expired) |
| `hiby` | `reauth_required` | `http_401` | yes | 2026-07-01 (expired) |

`bluesky` and `main` carry a verdict about a token that has since been replaced, while holding valid tokens. `yoxrent2` and `hiby` are genuinely dead.

### Live-path reproduction

Three synthetic profiles were built and passed to the real loader (`loadVaultAccountsForTest`):

| case | shape | loader verdict |
|---|---|---|
| A | fresh valid token, `reauth_required` whose hash names a different (revoked) token | `dead` / `auth_dead` |
| B | same account, no `refresh` block | `healthy` |
| C | valid token, `reauth_required` whose hash names that same token | `dead` / `auth_dead` |

A and C are indistinguishable to the loader. A is the bug; C is correct behavior. The loader has the information required to tell them apart and does not use it.

### Live-path reproduction of the login write

Calling the real `saveCodexTokenToVault` exactly as `ConsoleOAuthFlow.persistCodexLogin` does ([ConsoleOAuthFlow.tsx:219](src/components/ConsoleOAuthFlow.tsx:219)), against a profile pre-marked `reauth_required`:

```
save metadataAction : preserved
token replaced      : true
last_refresh bumped : 2026-08-01T17:02:54.800Z
refresh block after : {"state":"reauth_required","refresh_token_hash":"5de30b8b…","marked_at":"2026-07-15T16:16:49.815Z","reason":"refresh_token_invalidated"}
verdict names the token now in the file: false

=> pool status after a successful login: dead (auth_dead)
```

A successful login produces a dead account. That is the whole bug in one run.

### Real vault, real loader, read-only

```
bluesky    status=dead       reason=auth_dead    token_valid_for=8.7d
hiby       status=dead       reason=auth_dead    token_valid_for=EXPIRED
main       status=dead       reason=auth_dead    token_valid_for=6.7d
onbi       status=healthy    reason=-            token_valid_for=9.0d
yoxrent2   status=dead       reason=auth_dead    token_valid_for=EXPIRED

usable accounts: 1/5 -> onbi
saved active = bluesky -> pool activates: onbi
vault untouched by this check: true
```

The saved active account is silently replaced at every launch because it is not healthy ([codexAccountPool.ts:187-193](src/services/api/codexAccountPool.ts:187)). There is no fallback to the config-stored copy: `loadConfigAccount()` runs only when the vault is empty ([codexAccountPool.ts:185](src/services/api/codexAccountPool.ts:185)), and the vault has five profiles.

### Log evidence

Every session since the marker was written loads the same line:

```
[codex-pool] Loaded 5 accounts (1 healthy, 4 dead)
```

`profile-load` lines show `alias=main … status=dead` and `alias=bluesky … status=dead` in every session, while `last_refresh` advances across the logins (2026-07-10 → 07-21 → 07-27 → 07-29). Tokens keep being replaced; status never changes.

Vault writes attributable to a login (`writer=ConsoleOAuthFlow.persistCodexLogin`, all `metadata=preserved`) after the 2026-07-15 marker:

- `main` (`ca889574`): 07-19, 07-20, 07-21, 07-27, 07-29 — five re-logins
- `bluesky` (`93ce612e`): 07-30, 07-31 — two re-logins
- `onbi` (`14f2f119`): none since 07-10

`onbi` is the control. It is the one profile with no stale verdict, and the one profile that has needed no re-login.

### The tokens are genuinely good

Immediately after the 07-29 login (write at 09:13:25.793), `main` served real traffic with no 401: outbound `codex-cache request account=ca889574-256` at 09:13:32.347, about 6.5 seconds after the write, and `codex-fetch initial_output_ready … account=ca889574` at 09:13:38.200, about 12.4 seconds after it. `bluesky` likewise served requests throughout 07-31 after its 07-31 login. This rules out the competing explanation that the accounts are actually revoked server-side. They work in the session that logged them in, and are dead in the next one.

### Origin of the markers

The verdicts on `main` and `bluesky` were written 2026-07-15 at 16:16:47 and 16:16:49 with reason `refresh_token_invalidated`. That string is not in source; it is the OAuth error code extracted from the token endpoint's response body at [codexTokenRefresh.ts:457-464](src/services/api/codexTokenRefresh.ts:457).

The event is documented in [docs/reports/2026-07-15-codex-subagent-single-usable-account-failure.md](docs/reports/2026-07-15-codex-subagent-single-usable-account-failure.md), which records `main` and `bluesky` returning `401 token_invalidated` on that date. **The marking was correct.** The defect is not that they were marked; it is that a correct 2026-07-15 verdict has outlived seven subsequent logins with brand-new tokens.

### Why it never self-heals

`touchAll` reads vault files directly and would attempt a real refresh regardless of pool status, and a successful refresh resets the block to `{ state: 'idle' }` ([codexTokenRefresh.ts:581](src/services/api/codexTokenRefresh.ts:581)). But it only acts on tokens inside the refresh skew, which is 60 seconds ([codex-oauth.ts:47](src/constants/codex-oauth.ts:47), gate at [codexTokenRefresh.ts:664](src/services/api/codexTokenRefresh.ts:664)). Access-token lifetime is 10 days. So the self-heal opportunity arrives roughly 10 days after each login, and each re-login resets that clock to zero.

The loop is therefore self-sustaining: re-logging in to escape the dead state is precisely the action that postpones the only mechanism that would clear it.

## Defect 2 (secondary, independent): the age heuristic outlives no token

`checkAccountHealth` declares an account dead more than 7 days after `last_refresh` ([codexAccountPool.ts:1094-1100](src/services/api/codexAccountPool.ts:1094)), and that check runs before the refresh-state check, so it wins outright.

Measured against the real vault, access-token TTL is 10 days for every profile, and `touchAll` only refreshes at expiry minus 60 seconds:

| alias | token TTL | dead-by-age at | refresh fires at | false-dead window |
|---|---|---|---|---|
| `onbi` | 10d | 2026-08-07 17:10 | 2026-08-10 17:09 | 2d 23h |
| `bluesky` | 10d | 2026-08-07 09:11 | 2026-08-10 09:10 | 2d 23h |
| `main` | 10d | 2026-08-05 09:13 | 2026-08-08 09:12 | 2d 23h |
| `yoxrent2` | 10d | 2026-07-09 18:08 | 2026-07-12 18:07 | 2d 23h |
| `hiby` | 10d | 2026-06-28 16:47 | 2026-07-01 16:46 | 2d 23h |

Confirmed against the real loader with synthetic profiles holding valid tokens:

```
D-day6 status=healthy reason=- token_valid_for=4.0d
E-day8 status=dead    reason=auth_dead token_valid_for=2.0d
```

Every account spends the last ~3 days of every token cycle reading as dead while its token is still valid. This is structurally independent of Defect 1 and would keep producing spurious re-login prompts even after Defect 1 is fixed.

The comment at that site says the 7-day threshold matches "codex-nootp's CRITICAL threshold". Whatever that threshold means upstream, here it gates account selection against a 10-day credential.

## Fix verification

Loader against the real vault, read-only, after the fix:

```
bluesky    status=healthy    reason=-            token_valid_for=8.7d
hiby       status=dead       reason=auth_dead    token_valid_for=EXPIRED
main       status=healthy    reason=-            token_valid_for=6.7d
onbi       status=healthy    reason=-            token_valid_for=9.0d
yoxrent2   status=dead       reason=auth_dead    token_valid_for=EXPIRED

usable accounts: 3/5 -> bluesky, main, onbi
saved active = bluesky -> pool activates: bluesky
vault untouched by this check: true
```

`main` and `bluesky` recovered with no re-login and no file edit. `yoxrent2` and `hiby` stay dead, correctly: their verdicts name the tokens they still hold.

Each fix was mutation-checked. Reverting the correlation fails the stale-verdict and uncorrelatable tests; reverting the login reset fails the clears-the-verdict test; reverting the temp-path seam fails the target-directory test. The seam mutation reproduced the pollution first-hand, leaving a stray `.tmp` in the real vault, which was inspected (test fixture data, no real credentials) and removed. All five real profiles were confirmed byte-unchanged by mtime before and after.

Battery: `bun test src/services/api/codexAccountPool.test.ts src/services/api/codexTokenRefresh.test.ts` 95 pass / 0 fail · `src/codex-core/accounts.test.ts` 7 pass · `src/services/api/codexStatus.test.ts` 12 pass · app-side consumers (`accountsDomain`, `accountsPoolWorker`, `accountsPoolRunner`) 67 pass · `bun run build:dev:full` green, 0 errors, `2.1.87-dev.20260801.t173331.shafc52722c`.

## Fixes (1 and 2 implemented; 3 open)

1. **Scope the verdict to its token in the loader, as a tri-state.** In `getVaultRefreshPoolStatus` ([codexAccountPool.ts:1143](src/services/api/codexAccountPool.ts:1143)), correlate `refresh_token_hash` against the SHA-256 of the `refresh_token` in the same file, mirroring [codexTokenRefresh.ts:326-330](src/services/api/codexTokenRefresh.ts:326). Three outcomes, not two:

   | correlation | outcome |
   |---|---|
   | hash matches | `dead` (verdict is about the token we hold) |
   | hash present and definitely differs | ignore the verdict as stale |
   | hash missing or malformed | `quarantined` / probe, never `healthy` |

   The third row matters because the loader parses arbitrary on-disk JSON, where the house rule is fail closed and runtime-narrow unknown shapes. A bare `matches ? dead : healthy` rule would silently resurrect an uncorrelatable legacy or corrupted verdict. Exposure today is limited: every current writer of a vault `reauth_required` emits the hash ([codexTokenRefresh.ts:459-464](src/services/api/codexTokenRefresh.ts:459), [:552-557](src/services/api/codexTokenRefresh.ts:552)), and the codex-core writers ([accounts.ts:513-519](src/codex-core/accounts.ts:513), [:605-612](src/codex-core/accounts.ts:605)) target the separate raw-refresh ledger, not the vault block. So the missing-hash case is legacy or corruption only, which is exactly the case worth failing closed on.

   **Implementation wrinkle for the quarantine row:** `persistNextQuarantineProbe` returns early when the state is `reauth_required` ([codexTokenRefresh.ts:869](src/services/api/codexTokenRefresh.ts:869)), so an account quarantined *because* of an uncorrelatable `reauth_required` gets no backoff reservation and would be re-probed on every probe tick. The probe itself resolves correctly (it filters on `status === 'quarantined'` at [codexTokenRefresh.ts:803-808](src/services/api/codexTokenRefresh.ts:803) and calls `refreshAccountTokens`, whose hash guard does not block a non-matching hash), so the state machine terminates. Only the backoff bookkeeping needs adjusting.

   With that, fix 1 self-heals `main` and `bluesky` on the next launch with no re-login and no file edits, and leaves `yoxrent2` and `hiby` correctly dead. `getVaultRefreshPoolStatus` has one caller ([codexAccountPool.ts:978](src/services/api/codexAccountPool.ts:978)), so the blast radius is contained.

2. **Clear the verdict on login.** In `saveCodexTokenToVault` ([codexAccountPool.ts:729](src/services/api/codexAccountPool.ts:729)), a login mints a new refresh token, so any prior verdict is void: set `data.refresh = { state: 'idle' }` when the incoming refresh token differs from the stored one. This makes the persisted state agree with what `appendAccount` already claims to do in memory.

3. **Make health expiry-aware, or refresh proactively. Do not simply raise the threshold.** An earlier draft of this report offered "raise the `checkAccountHealth` threshold above the 10-day TTL" as one option. That option is withdrawn: the availability predicate never inspects the access-token `expiresAt` ([isCodexAccountSwitchable](src/services/api/codexAccountPool.ts:1575) → `getCodexAccountAvailability`, whose only expiry check is the subscription `planExpiresAt` at [codexAccountPool.ts:1466-1467](src/services/api/codexAccountPool.ts:1466)), so a threshold longer than the credential creates a window in which an expired token is selectable.

   Accuracy note on the severity of that window: it is degraded, not broken. The resolve path refreshes on use, and an expired token is inside the 60-second skew, so `maybeRefreshAccount` ([accounts.ts:243-244](src/codex-core/accounts.ts:243)) refreshes it before the request rather than sending an expired credential. The real cost is a wasted failing round-trip and a late dead-mark when the refresh token is also gone. The recommendation stands regardless, because a heuristic that proxies for a lifetime it never reads is the wrong shape: either drop the age rule in favour of an expiry-aware check, or refresh proactively instead of at expiry minus 60 seconds.

Regression tests should cover: a `reauth_required` verdict with a non-matching hash loads `healthy`; with a matching hash loads `dead`; with a missing or malformed hash loads `quarantined` rather than `healthy`; a login over a marked profile clears the block; an account at day 8 of a 10-day token loads `healthy`.

**Test-seam prerequisite.** The login regression cannot be written hermetically against the current signature. `saveCodexTokenToVault` honors a `filePath` override but still resolves its temp path from the configured vault, `join(accountsDir, …)` where `accountsDir` comes from `readVaultPath()` ([codexAccountPool.ts:747](src/services/api/codexAccountPool.ts:747)), then renames across directories. A test that passes `filePath` into a sandbox therefore writes a transient dotfile into the operator's real vault, and leaves one behind if it fails mid-write. This investigation avoided the hazard by redirecting `HOME` for every write-path check rather than using the override. The fix is to derive the temp path from `dirname(filePath)`, or to take an explicit vault-root parameter, before adding write-path tests.

## Unresolved / not investigated

- **Pre-2026-07-15 re-logins are not explained by Defect 1.** Logins on 07-04, 07-05 (×3), 07-06 and 07-10 predate the markers. Defect 2 is a candidate cause but the spacing of some of those logins (about a day apart) does not fit a 7-day cycle, so at least one further cause may exist. Not chased.
- **No log evidence was found for Defect 2 firing in the wild**, because the age-based `lastError` is stored on the account object and never logged. Defect 2 is confirmed by executing the real loader and by arithmetic, not by log archaeology.
- **The desktop app path was not separately verified.** A `writer=accountsDomain.oauthPersist` save appears on 07-19, so `app/` reaches the same function; whether it has additional behavior was not checked.
- **Test pollution has a second, mechanical source.** Independent of the fixture names below, the temp-path defect described under "Test-seam prerequisite" means any test exercising `saveCodexTokenToVault` with a `filePath` override writes transiently into the operator's real vault directory. A cold review of this report reported five sandbox failures traceable to that seam; those runs were not reproduced here, but the source behavior at [codexAccountPool.ts:747](src/services/api/codexAccountPool.ts:747) is confirmed.
- **Unrelated observation:** `~/.cat-code/codex-raw-refresh.state.json` contains test-fixture account names (`worker-a`, `main-account`, `solo-account`, `vault-only`, `backup-clean`, `account-one`, `account-two`, `lease-account`) written into the real config home on 2026-07-06 and 07-10. These cannot collide with real account UUIDs and are not implicated in this bug, but probe tests writing to the operator's real config home is its own problem.

## Recovery for the current state

**Preferred: fix 1 above.** It recovers both accounts on the next launch with no login and no hand-editing of credential files, and it re-derives the correlation at load time, so it cannot act on a stale reading.

**Manual unblock**, if the code fix is not landing immediately: delete the `refresh` block from the `bluesky` and `main` vault profiles. This was not performed as part of this investigation, and it must not be applied from the evidence in this report alone. The state in these tables is a snapshot; a verdict that is stale now can become current at any moment, because a refresh failure between now and the edit would write a new, correct verdict for the token currently in the file. Deleting that would discard a true terminal verdict and send the pool back to a revoked account.

Required guards, in order:

1. Re-derive the correlation immediately before writing: read the profile, hash its current `refresh_token`, and confirm it still differs from `refresh_token_hash`. Abort if they now match.
2. Re-check that the access token has not expired.
3. Quiesce vault writers. Every Cat Code process, the desktop app, and any running subagent share these files and refresh them under lock.
4. Write through the same atomic, locked path the production writers use (`readVault` → mutate → `atomicWriteJson` under the vault lock), never a plain read-modify-write, and bump `version`. A hand-edit races `touchAll` and the quarantine probe.

Given those four, fix 1 is less work and strictly safer than the manual route.
