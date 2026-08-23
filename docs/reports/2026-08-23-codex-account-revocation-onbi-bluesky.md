# Incident Report: Codex accounts `onbi` and `bluesky` rejected server-side

**Date of report:** 23 August 2026 (revised same day after review)
**Date of incident:** 22 August 2026, 14:52:38Z and 15:10:33Z (21:52 and 22:10 local, UTC+7)
**Accounts affected:** `onbi` (`14f2f119…`), `bluesky` (`93ce612e…`)
**Accounts unaffected:** `main` (`ca889574…`)

> **Identifiers.** Accounts are named by local alias and 8-hex prefix only. Emails,
> full account UUIDs, and OAuth session identifiers are deliberately omitted, per the
> redaction targets in `src/services/api/accountDiagnostics.ts:53-56`. Refresh-token
> SHA-256 prefixes are retained because they are one-way and needed to reproduce the
> integrity check in §3.2. The one full UUID retained is a local Cat Code debug-log
> filename, not an OpenAI-issued identity; it is required to locate the evidence.

## Executive summary

OpenAI rejected locally unexpired access tokens for `onbi` and `bluesky` while both
were in active use, then rejected both corresponding refresh tokens. Cat Code
classified those responses correctly, failed over as designed, and recorded
`reauth_required` accurately. Re-login is genuinely required and there is no code
defect in the token path.

**The reason OpenAI invalidated the sessions is unknown.** The timing, quota state,
and account history are consistent with correlated enforcement or an account-security
action, but they do not establish it, and this report does not attribute a cause.
Section 4 states that hypothesis and the alternatives it cannot separate.

One latent defect and two hygiene issues were found while investigating; see §5.

## 1. Timeline

All times UTC. Source: `~/.cat-code/debug/8bdf9d62-d99d-493b-b80f-5c1e6cc64903.txt`.

| Time | Event |
|---|---|
| `14:52:21.533` | `onbi` response healthy: `plan=plus`, `active-limit=premium`, `primary-used-percent=20`, `secondary-used-percent=0` |
| `14:52:37.401` | `onbi` request completes normally (`cached=49664 input=55626`) |
| `14:52:38.132` | Next `onbi` request sent (conv `85980e5b`, instructions hash `d635eab6`, messages=73) |
| `14:52:38.317` | **401** `x-openai-ide-root-error-code=token_revoked` |
| `14:52:38.321` | Forced refresh begins (`core-refresh-start`, `source=vault`) |
| `14:52:38.770` | Token endpoint returns `refresh_token_invalidated`; account marked dead |
| `14:52:39.160` | Failover: equivalent turn reissued on `bluesky` (conv `f40d89cf`, same instructions hash `d635eab6`, same messages=73) |
| `14:52:41.639` | `bluesky` response healthy: `primary-used-percent=32`, `secondary-used-percent=0` |
| `14:53:09.026` | `bluesky` request completes normally |
| `15:10:32.504` | Next `bluesky` request sent on same conv (messages=77) |
| `15:10:33.267` | **401** `x-openai-ide-root-error-code=token_revoked` |
| `15:10:33.611` | Token endpoint returns `refresh_token_invalidated`; account marked dead |

The two accounts carried the same logical workload in sequence: after `onbi` was
rejected, the pool reissued the turn on `bluesky`, which served it successfully and
was rejected 18 minutes later on the same conversation. This is an observed ordering.
**It does not establish that the first rejection caused the second.**

## 2. Failure mechanism

Both accounts failed the same way:

1. An in-flight API request returned HTTP 401 carrying
   `x-openai-authorization-error=401`, `x-openai-ide-error-code=token_revoked`,
   `x-openai-ide-root-error-code=token_revoked`, and a `cf-ray` header. The request
   reached OpenAI's edge and returned a verdict; this was not a transport failure.
2. The access token was **locally unexpired** at the time (`onbi` stored expiry
   08-28, `bluesky` 08-30). The stored expiry timestamp is a local claim about
   validity, not proof of server-side validity; the server evidently did not honour
   it.
3. `CodexAccountAuthError` triggered a forced refresh in `withRetry.ts:713` and
   `withRetry.ts:739`, entering `maybeRefreshAccount` at `accounts.ts:230`. OpenAI's
   token endpoint responded with the OAuth error code `refresh_token_invalidated`.
4. `codexTokenRefresh.ts:452-475` wrote that code verbatim into the vault's `refresh`
   block as `state: reauth_required`, and `markAccountDead` removed the account from
   rotation.

Both the access credential and the refresh credential were rejected. **Whether they
were revoked by a single atomic upstream action was not observed** and is not claimed.

## 3. What was ruled out, and how

### 3.1 Token expiry

Ruled out. Stored expiry was 6 days out (`onbi`) and 8 days out (`bluesky`).

### 3.2 A rotation race in our own refresh machinery

Ruled out on four independent checks (reproduce with §Appendix A):

- Last local rotation was 2026-08-18 (`onbi`) and 2026-08-20 (`bluesky`). Nothing
  rotated in the failure window.
- The only `core-refresh-start` entries for either account on 08-21/08-22 are the two
  that follow the 401.
- The durable attempt ledger shows no `in_flight`, no `unknown`, no
  `raw-refresh-probe`, no `raw-refresh-lock-compromised`.
- Each vault's live refresh-token SHA-256 still equals the hash recorded at death
  (`onbi` `5aad821d…`, `bluesky` `1f6da81d…`), so nothing rotated underneath either
  account.

### 3.3 Quota exhaustion

Ruled out. OpenAI's own rate headers 17 seconds before the `onbi` rejection reported
`x-codex-primary-used-percent=20` on a 10080-minute window with
`secondary-used-percent=0`. `bluesky` reported 32% / 0%. No 429, no `capped`
transition, and no usage-limit line precedes either rejection.

### 3.4 Network failure misread as an auth failure

Ruled out by design and by a live control.

A connection failure cannot produce `reauth_required`. The refresh path classifies
three ways:

| Condition | Result | State |
|---|---|---|
| `definitely_not_sent` (ENOTFOUND, ECONNREFUSED, ENETUNREACH) | reset to `idle`, class `offline` | untouched |
| `ambiguous` / `fatal` transport, or non-credential HTTP (400/429/5xx) | `unknown` + quarantined, re-probed | recoverable |
| Real HTTP 401/403, or `invalid_grant`/`invalid_token`/`expired_token` in body | `markAccountDead` | terminal |

`codexTokenRefresh.ts:432-433` states the intent: mark unknown "so a future probe can
retry without converting a network drop into a server-side auth verdict." The
classifier cannot be fooled by a thrown fetch: `codex-client.ts:204-206` returns
`{type:'failed', networkError}` with no status and no body, so
`isCredentialGrantFailure(undefined, undefined)` is false and control routes to the
transport branch.

**Live control:** at `2026-08-23T04:43:09Z` DNS failed
(`getaddrinfo ENOTFOUND chatgpt.com`) against all five accounts including `main`. No
account changed state. The usage poller only logs (`codexUsage.ts:243-246`) and never
mutates account state.

### 3.5 The stale duplicate credential for `bluesky`

Excluded **for this incident**, but it is a latent defect, not inert hygiene. See
§5.1.

`~/.cat-code/.cat-code.json` `codexOAuth` holds a second, superseded copy of
`bluesky`'s OAuth session carrying the pre-08-20 token pair: refresh hash `ea440d3f…`
against the vault's live `1f6da81d…`. A spent refresh token from a live chain in a
second store is what trips OAuth reuse detection, so this was the leading local
hypothesis.

It was not used in the observed incident: both `core-refresh-start` lines record
`source=vault`, and five vault accounts were loaded throughout. **It is not
unreachable in general** — see §5.1 for the conditions under which it becomes live.

### 3.6 A second login for `onbi`

Ruled out for this incident. The official Codex CLI (`~/.codex/auth.json`) is logged
into `onbi`, but under a different OAuth session and therefore a separate refresh
chain. That file has not been written since 2026-08-16 and rotated nothing on 08-22.

## 4. Hypothesis: correlated action against the secondary accounts

**This section is a hypothesis, not a finding.** It is offered because the pattern is
worth recording, not because the evidence settles it.

### 4.1 What the observations are

**Timing.** The `onbi` rejection landed 916 ms after a completed request and roughly
17 s after its last proven-live response, on an account in continuous use. The
`bluesky` rejection followed 18 minutes later, after an idle gap.

**Account-type split.** Every account this pool has lost was created by email OTP;
the account created by Google SSO has not been rejected.

| alias | auth method (`amr`) | outcome |
|---|---|---|
| `hiby` | `otp`, `otp_email` | dead 2026-06-21 |
| `yoxrent2` | (otp) | dead 2026-07-02 |
| `onbi` | `otp` | dead 2026-08-22 |
| `bluesky` | `otp`, `otp_email` | dead 2026-08-22 |
| **`main`** | `urn:openai:amr:google` | **never rejected** |

Request volume does not separate them: `main` served 359 requests on 08-22, the same
day the other two were rejected, and ran concurrently with both.

**Correlatable signals from one host.** Five distinct identities and org ids from one
IP (`cf-ray` suffix `BKK`); six same-second overlaps between `onbi` and `bluesky` plus
extended overlapping windows on 08-21 and 08-22; and a failover in which one workload
shape (57,320-byte instructions, hash `d635eab6`, messages=73) crossed between account
identities inside one second.

**Inconsistent client identity.** At authorization, `codex-client.ts:149-160` sends
`originator=cat-code`. At request time, `codex-fetch-adapter.ts:3385-3389` sends
`originator: codex_cli_rs`.

### 4.2 What these observations cannot separate

The evidence establishes sequential server-side rejection of two accounts carrying
the same workload. It does **not** distinguish between:

- policy enforcement against pooled or secondary accounts,
- a manual session invalidation (password reset, "log out of all devices"),
- an automated account-security action unrelated to pooling,
- an upstream defect or partial outage affecting a subset of sessions,
- some other cause correlated with account age or creation method.

Sample size for the account-type split is five accounts and four events over two
months, from one host. That is a suggestive pattern, not a demonstrated mechanism.

### 4.3 A signal investigated and rejected

An earlier draft of this report cited `WebSocket connect error` events clustering
around the two rejections as weak corroboration. **That claim was withdrawn.** It was
an artifact of sampling only the 80 most recent debug logs. Across the full debug
corpus there are 22 distinct such events from 2026-07-09 to 2026-08-22, on multiple
accounts and dates, including four lines at `2026-08-20T14:32:03Z` that coincide with
a *successful* `bluesky` token refresh. WebSocket connect failures are background
noise in this environment and carry no predictive value here. Recorded so the same
mistake is not repeated.

## 5. Defect and hygiene findings

### 5.1 Latent defect: the stale credential is reachable when the vault is empty

The superseded `bluesky` refresh token in `.cat-code.json` is ignored **only while at
least one vault account loads**. Two paths reactivate it when the vault inventory is
empty:

- `mergePoolAccounts` adopts the config account when `byId.size === 0`
  (`codexAccountPool.ts:1078`).
- `resolveCodexCoreAccount` falls back to `getCodexOAuthTokens()` when
  `poolStatus.accounts.length === 0` (`accounts.ts:90-95`).

An unavailable, unreadable, or emptied vault directory would therefore let a spent
refresh token be redeemed, which is precisely the reuse-detection trigger. This should
be treated as a defect to clear, not as harmless stale data. Not actioned here:
credential state requires operator approval.

### 5.2 Config mirror is out of sync

`activeCodexAccountId` is `main` while the mirrored `codexOAuth` block holds
`bluesky`'s 08-15 tokens. The mirror written at `codexAccountPool.ts:876` has drifted
from the active account.

### 5.3 Terminal accounts are re-marked dead on every periodic cycle

`hiby` and `yoxrent2` have been terminal since June and July, yet `marked dead` lines
are re-emitted for them repeatedly: **28 lines across 15 distinct cycles between
08-15 and 08-21.**

The mechanism is not the quarantine probe. That probe runs every second
(`QUARANTINE_PROBE_INTERVAL_MS = 1_000`, `codexTokenRefresh.ts:782`) and selects only
`quarantined` accounts. The four-hour path is the periodic refresh timer calling
`touchAll()` (`codexTokenRefresh.ts:734`, interval from
`codexTokenRefreshIntervalHours`, default 4); the terminal-state short-circuit at
`codexTokenRefresh.ts:340-345` then calls `markAccountDead` again for an
already-dead account.

Operational cost: long-dead accounts look like fresh failures in the logs. This is why
the incident initially appeared to affect four accounts rather than two.

## 6. Recommendations

1. **Re-login `onbi` and `bluesky` via `/login`.** Vault files are otherwise intact;
   only the `refresh` block is terminal.
2. **Treat re-login as an observation, not a test that settles §4.** A second
   rejection under similar usage would be *consistent with* the hypothesis; it would
   not confirm it, since the alternatives in §4.2 can also recur. A long survival
   would weaken the hypothesis without refuting it.
3. **No change to the token path is indicated.** Classification, failover, and
   terminal recording all behaved correctly.
4. **Clear the stale `codexOAuth` credential and reconcile the mirror** (§5.1, §5.2).
   §5.1 is a defect, not cosmetic.
5. Consider suppressing repeat `marked dead` emission for already-terminal accounts
   (§5.3).

## 7. Open questions and limits of this analysis

- **OpenAI's reason is unknown.** The 401 carried an error code and no explanation.
  Nothing in §4 was confirmed by OpenAI.
- **Atomicity of the two credential rejections was not observed** (§2).
- **Manual session termination cannot be excluded.** The claim that it would produce
  an identical response signature is untested and should not be relied on.
- **`x-openai-internal-caller=unknown_through_ide` appears only on the two error
  responses.** Successful responses carry no such header, so it may be an annotation
  emitted by the auth-error path rather than a standing classification. It is not
  used as evidence.
- **Single-host, small-sample.** All conclusions derive from one machine's logs over
  roughly two months and four events.

## Appendix A: reproduction commands

Run from the repository root. These are the actual commands behind the numbers above.

Vault integrity check (§3.2) — compares each live refresh token against the hash
recorded at death. Prints booleans only; no token or identifier material.
`main` reports `hash_match=False` because it is `idle` and has no recorded hash; that
is expected, not a finding:

```bash
python3 -c '
import json,glob,os,hashlib
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f))
    live=hashlib.sha256(v["tokens"]["refresh_token"].encode()).hexdigest()
    rec=v.get("refresh",{}).get("refresh_token_hash")
    print(v.get("alias"), v.get("refresh",{}).get("state"), "hash_match=", live==rec)
'
```

Auth-method table (§4.1) — decodes the `amr` claim, prints no email or account id:

```bash
python3 -c '
import json,glob,os,base64
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f)); p=v["tokens"]["access_token"].split(".")[1]; p+="="*(-len(p)%4)
    j=json.loads(base64.urlsafe_b64decode(p))
    print(v.get("alias"), j["https://api.openai.com/auth"].get("amr"))
'
```

Incident window (§1):

```bash
grep -h "14f2f119\|85980e5b" ~/.cat-code/debug/8bdf9d62-*.txt | awk '$1 >= "2026-08-22T14:52:19" && $1 <= "2026-08-22T14:52:40"'
```

Repeat-dead count (§5.3) — 28 lines, 15 distinct cycles:

```bash
cd ~/.cat-code/debug
grep -rh "marked dead" . | grep "9ed41939\|66608311" | awk '$1>="2026-08-15" && $1<="2026-08-22"' | wc -l          # 28 lines
grep -rh "marked dead" . | grep "9ed41939\|66608311" | awk '$1>="2026-08-15" && $1<="2026-08-22"' | cut -c1-19 | sort -u | wc -l   # 15 cycles
```

WebSocket-error corpus (§4.3) — full corpus, not a recent-file sample:

```bash
cd ~/.cat-code/debug && grep -rh "WebSocket connect error" . | cut -c1-20 | sort -u | wc -l
```

Network-failure control (§3.4):

```bash
cd ~/.cat-code/debug && grep -rh "ENOTFOUND\|ECONNREFUSED\|ENETUNREACH" .
```

## Appendix B: revision history

**Rev 2 (23 Aug 2026)** — revised after review. Changes: causal language removed from
the summary, §1, and §4; §4 reframed from attribution to hypothesis with an explicit
list of causes it cannot separate; the WebSocket corroboration withdrawn as a sampling
artifact (§4.3); §3.5 corrected from "never redeemed" to a conditional exclusion, with
the reachable path recorded as a latent defect (§5.1); §5.3 mechanism corrected from
the quarantine probe to periodic `touchAll()` plus terminal short-circuit, and the
count corrected from "28 pairs" to 28 lines across 15 cycles; `accounts.ts:519`
anchor corrected to the real refresh entry point; "valid" narrowed to "locally
unexpired" and the atomic-revocation claim withdrawn; emails and OAuth session
identifiers removed; the placeholder appendix replaced with runnable commands.
