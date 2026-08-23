# Incident Report: Codex accounts `onbi` and `bluesky` revoked server-side

**Date of report:** 23 August 2026
**Date of incident:** 22 August 2026, 14:52:38Z and 15:10:33Z (21:52 and 22:10 local, UTC+7)
**Accounts affected:** `onbi` (`14f2f119`), `bluesky` (`93ce612e`)
**Accounts unaffected:** `main` (`ca889574`)

## Executive summary

Two Codex pool accounts stopped working within 18 minutes of each other. Both were
terminated by OpenAI server-side while in active use, with valid access tokens and
ample remaining quota. Cat Code's token machinery did not cause the failure and did
not misclassify it; it correctly transcribed a definitive server verdict.

The `reauth_required` state on both accounts is accurate. Re-login is genuinely
required. There is no code defect to fix.

The revocations were almost certainly not random. Timing, quota state, and the
two-month history of this pool all indicate action taken against the secondary
accounts specifically. That conclusion is inference from observable correlation,
not something OpenAI confirmed.

## 1. Timeline

All times UTC. Source: `~/.cat-code/debug/8bdf9d62-d99d-493b-b80f-5c1e6cc64903.txt`.

| Time | Event |
|---|---|
| `14:51:58` | `onbi` WebSocket connect fails, falls back to HTTP |
| `14:52:21.533` | `onbi` response healthy: `plan=plus`, `active-limit=premium`, `primary-used-percent=20`, `secondary-used-percent=0` |
| `14:52:37.401` | `onbi` request completes normally (`cached=49664 input=55626`) |
| `14:52:38.132` | Next `onbi` request sent (conv `85980e5b`, hash `d635eab6`, messages=73) |
| `14:52:38.317` | **401** `x-openai-ide-root-error-code=token_revoked` |
| `14:52:38.321` | Reactive refresh starts (`core-refresh-start`, `source=vault`) |
| `14:52:38.770` | Token endpoint returns `refresh_token_invalidated`; account marked dead |
| `14:52:39.160` | Failover: identical turn reissued on `bluesky` (conv `f40d89cf`, same hash `d635eab6`, same messages=73) |
| `14:52:41.639` | `bluesky` response healthy: `primary-used-percent=32`, `secondary-used-percent=0` |
| `14:53:09.026` | `bluesky` request completes normally |
| `15:10:32.504` | Next `bluesky` request sent on same conv (messages=77) |
| `15:10:33.267` | **401** `x-openai-ide-root-error-code=token_revoked` |
| `15:10:33.611` | Token endpoint returns `refresh_token_invalidated`; account marked dead |

Key structural detail: the two deaths are causally linked. `bluesky` died on the
conversation it inherited from `onbi` one second after `onbi` was revoked.

## 2. Failure mechanism

Both accounts failed identically:

1. An in-flight API request returned HTTP 401 carrying
   `x-openai-authorization-error=401`, `x-openai-ide-error-code=token_revoked`,
   `x-openai-ide-root-error-code=token_revoked`, and a `cf-ray` header. The
   response reached OpenAI's edge and came back with a verdict; this was not a
   transport failure.
2. The access token was still valid at the time (`onbi` until 08-28, `bluesky`
   until 08-30). The server invalidated a live token, not an expired one.
3. Cat Code reacted with a token refresh (`accounts.ts:519`). OpenAI's token
   endpoint responded with the OAuth error code `refresh_token_invalidated`.
4. `codexTokenRefresh.ts:475` recorded that code verbatim into the vault's
   `refresh` block as `state: reauth_required`, and `markAccountDead` removed the
   account from rotation.

The whole token family (access + refresh) was revoked in one action.

## 3. What was ruled out, and how

### 3.1 Token expiry

Ruled out. `onbi` had 6 days of validity remaining, `bluesky` 8 days.

### 3.2 A rotation race in our own refresh machinery

Ruled out on four independent checks:

- Last local rotation was 2026-08-18 (`onbi`) and 2026-08-20 (`bluesky`). Nothing
  rotated in the failure window.
- The only `core-refresh-start` entries for either account on 08-21/08-22 are the
  two that *react* to the 401.
- The durable attempt ledger is clean: no `in_flight`, no `unknown`, no
  `raw-refresh-probe`, no `raw-refresh-lock-compromised`.
- Each vault's live refresh-token SHA-256 still equals the hash recorded at death
  (`onbi` `5aad821d…`, `bluesky` `1f6da81d…`). Nothing rotated underneath either
  account.

### 3.3 Quota exhaustion

Ruled out. OpenAI's own rate headers 17 seconds before the `onbi` revocation
reported `x-codex-primary-used-percent=20` on a 10080-minute (7 day) window, with
`secondary-used-percent=0`. `bluesky` reported 32% / 0%. No 429, no `capped`
transition, no usage-limit line precedes either death.

### 3.4 Network failure misread as an auth failure

Ruled out both by design and by live evidence.

By design, a connection failure cannot produce `reauth_required`. The refresh path
classifies three ways:

| Condition | Result | State |
|---|---|---|
| `definitely_not_sent` (ENOTFOUND, ECONNREFUSED, ENETUNREACH) | reset to `idle`, class `offline` | untouched |
| `ambiguous` / `fatal` transport, or non-credential HTTP (400/429/5xx) | `unknown` + quarantined, re-probed | recoverable |
| Real HTTP 401/403, or `invalid_grant`/`invalid_token`/`expired_token` in body | `markAccountDead` | terminal |

`codexTokenRefresh.ts:432-433` states the intent directly: mark unknown "so a future
probe can retry without converting a network drop into a server-side auth verdict."

The classifier cannot be fooled by a thrown fetch: `codex-client.ts:206` returns
`{type:'failed', networkError}` with no status and no body, so
`isCredentialGrantFailure(undefined, undefined)` is false and control routes to the
transport branch.

Live confirmation: at `2026-08-23T04:43:09Z` DNS failed
(`getaddrinfo ENOTFOUND chatgpt.com`) against **all five** accounts including
`main`. No account changed state. The usage poller only logs
(`codexUsage.ts:246`) and never touches account state.

### 3.5 A duplicate credential copy for `bluesky`

Investigated and ruled out as the cause, but recorded below as a hygiene finding.

`~/.cat-code/.cat-code.json` `codexOAuth` holds a **second, superseded copy of
`bluesky`'s same OAuth session** (`authsess_qE0gxlBqkj7crPt0nw9NzoZZ`), carrying
the pre-08-20 token pair: refresh hash `ea440d3f…` against the vault's live
`1f6da81d…`. A spent refresh token from a live chain sitting in a second store is
exactly what trips OAuth reuse detection, so this was the leading local hypothesis.

It is never redeemed. `mergePoolAccounts` (`codexAccountPool.ts:1078`) adopts the
config account only when the vault is empty (`byId.size === 0`), and the vault holds
five accounts. The only other readers (`auth.ts:1709`, `auth.ts:2032`) are
presence/identity checks gated behind `hasAnyPoolAccount()`. The copy is inert.

### 3.6 A second login for `onbi`

Ruled out. The official Codex CLI (`~/.codex/auth.json`) is logged into `onbi`, but
as an **independent session** (`authsess_yuLu3ASe1ZqEcvxxPHaZM48O` vs the vault's
`authsess_2h1Pe30tcxZOG8zXUKX2O2LE`), therefore a separate refresh chain. That file
has not been written since 2026-08-16 and rotated nothing on 08-22.

## 4. Assessment: why this reads as targeted rather than random

Four observations, in descending order of strength.

**4.1 Timing.** The `onbi` revocation landed 916 ms after a completed request and
roughly 17 s after its last proven-live response, on an account in continuous use.
Scheduled resets, session rotations, and expiry boundaries do not land inside a
sub-second gap in active traffic. Twice, 18 minutes apart, is not coincidence.

**4.2 Account-type split.** Every account this pool has ever lost is an email-OTP
secondary. The Google-SSO primary has never been revoked.

| account | email | auth method | outcome |
|---|---|---|---|
| hiby | hibystuff@gmail.com | `otp`, `otp_email` | died 2026-06-21 |
| yoxrent2 | arifiantibobbyandi@gmail.com | (otp) | died 2026-07-02 |
| onbi | onbibear@gmail.com | `otp` | died 2026-08-22 |
| bluesky | blueskyqm@gmail.com | `otp`, `otp_email` | died 2026-08-22 |
| **main** | pubmtaki@gmail.com | `urn:openai:amr:google` | **never revoked** |

Four for four against zero for one. Volume is not the discriminator: `main` served
359 requests on 08-22, the same day the other two died, and ran concurrently with
both.

**4.3 Correlatable signals from one host.** Five distinct Auth0 identities, five
emails, five org ids, all originating from one IP (`cf-ray` suffix `BKK`); six
same-second overlaps between `onbi` and `bluesky` plus extended overlapping windows
on 08-21 and 08-22; and the failover itself, in which one workload (identical
57,320-byte instructions, hash `d635eab6`, messages=73) crossed from one account
identity to another inside one second.

**4.4 Client identity is declared inconsistently.** At login,
`codex-client.ts:160` sends `originator=cat-code` to OpenAI's authorize endpoint.
At request time, `codex-fetch-adapter.ts:3389` sends `originator: codex_cli_rs`.
Every session in the vault was minted with `cat-code` on record; every subsequent
API call presents as the official Rust Codex CLI.

**Weaker signal, recorded for completeness.** Across 1,271 sampled requests there
are exactly 6 explicit `WebSocket connect error` events. All 6 fall on 08-22, all on
`onbi` and `bluesky`, none on `main`, and they bracket the deaths (`14:51:58`,
`14:52:39`, `15:10:33`). HTTP succeeded on the same account in the same second, so
this was not general network trouble; it is consistent with auth being torn down at
the WS layer ahead of the HTTP path. However, earlier plain `initial_ws_unavailable`
fallbacks on 08-21 and on `main` led to nothing, so WS trouble alone is not
predictive. Sample size 3. Suggestive, not conclusive.

## 5. Secondary findings (hygiene, not causal)

1. **Stale credential copy.** `~/.cat-code/.cat-code.json` `codexOAuth` holds a
   superseded refresh token from `bluesky`'s live chain (§3.5). It is inert only
   while the vault is non-empty. Recommend clearing it. Not actioned: credential
   state, requires operator approval.
2. **Config mirror is out of sync.** `activeCodexAccountId` is `main`
   (`ca889574`) while the mirrored `codexOAuth` block holds `bluesky`'s tokens from
   08-15. The mirror written at `codexAccountPool.ts:876` has drifted from the
   active account.
3. **Dead accounts are re-marked every probe cycle.** `hiby` and `yoxrent2` have
   been terminal since June and July, but the 4-hourly quarantine probe emits a
   fresh `marked dead` line for each on every cycle (28 pairs logged between 08-15
   and 08-21). This makes long-dead accounts look like new failures when reading
   logs, and was the reason this incident initially appeared to affect four
   accounts rather than two.

## 6. Recommendations

1. **Re-login `onbi` and `bluesky` via `/login`.** Vault files are otherwise
   intact; only the `refresh` block is terminal.
2. **Treat re-login as a test, not a fix.** If §4's assessment is right, restored
   sessions will be revoked again under the same usage. A session surviving weeks
   falsifies the assessment; one dying within days confirms it.
3. **No code change is indicated.** The token machinery behaved correctly at every
   step. No retry policy, refresh change, or classification change would have
   altered the outcome.
4. Consider clearing the stale `codexOAuth` block (§5.1) and reconciling the
   mirror (§5.2).
5. Consider suppressing repeat `marked dead` log lines for already-terminal
   accounts (§5.3) so genuine new failures stand out.

## 7. Open questions and limits of this analysis

- **OpenAI's actual reason is unknown.** The 401 carried an error code and no
  explanation. Section 4 is inference from timing and correlation. It is strong
  inference, but it was not confirmed by OpenAI and should not be cited as if it
  were.
- **A manual session termination cannot be fully excluded.** A password reset or
  "log out of all devices" on those two Gmail accounts produces a byte-identical
  signature. It would have had to land inside `onbi`'s active-use window and again
  on `bluesky` 18 minutes later.
- **`x-openai-internal-caller=unknown_through_ide` appears only on the two error
  responses.** Successful responses in these logs carry no such header, so it may
  be an annotation emitted by the auth-error path rather than a standing
  classification. It is not treated as evidence above.
- **The WebSocket signal (§4.4, weaker signal) rests on three events.** Worth
  watching on the next revocation, not worth concluding from now.

## Appendix: verification commands

```
# vault state and refresh-token hash integrity
python3 -c "…"  # compared live tokens[].refresh_token SHA-256 against refresh.refresh_token_hash

# incident window
grep -h "14f2f119\|85980e5b" ~/.cat-code/debug/8bdf9d62-*.txt \
  | awk '$1 >= "2026-08-22T14:52:19" && $1 <= "2026-08-22T14:52:40"'

# revocation sweep across recent logs
grep -h "token_revoked\|refresh_token_invalidated\|marked dead" $(ls -t | head -300)

# network-failure control
grep -h "ENOTFOUND\|ECONNREFUSED\|ENETUNREACH" $(ls -t | head -80)
```
