# Incident Report: Codex accounts `onbi` and `bluesky` rejected server-side

**Date of report:** 23 August 2026 (rev 4)
**Date of incident:** 22 August 2026, 14:52:38Z and 15:10:33Z (21:52 and 22:10 local, UTC+7)
**Accounts affected:** `onbi` (`14f2f119…`), `bluesky` (`93ce612e…`)
**Accounts unaffected:** `main` (`ca889574…`)

> **Identifiers.** Accounts are named by local alias and 8-hex prefix. Emails, full
> account UUIDs, and OAuth session identifiers are omitted, per the redaction targets
> in `src/services/api/accountDiagnostics.ts:53-56`. Aliases are themselves local
> identifiers and are retained deliberately for readability. Refresh-token SHA-256
> prefixes are retained because they are one-way and needed for §3.2. The one full
> UUID in this file is a local Cat Code debug-log filename, not an OpenAI-issued
> identity; it is required to locate the evidence.

> **Counting method.** Log timestamps are observations, not event identifiers.
> Second-level truncation both merges concurrent events and splits single events
> across a boundary; two measurements in rev 2 were wrong for exactly that reason
> (§4.3, §5.3). Counts below identify events by **one canonical log message per
> event**, and state the message counted. See Appendix B.

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

**Rev 4 narrows the question.** A check that was available all along and never run
has now been run (A12, §3.6): `onbi` held a second, separate OAuth session in the
official Codex CLI, and it is **also dead**. The revocation was therefore
account-wide, not scoped to the sessions this fork held, which excludes any reading
in which a detector acted on this client's request behaviour and killed only what it
was using. `main` still answers 200 from the same host under the same client
identity, so whatever selected the victims selected by account. The remaining
candidates in §4.2 all act at the account level, and the cheapest way to separate
them is no longer technical: it is whether the operator performed a password reset or
device sign-out around 2026-08-22.

**On prevention.** Only two levers are inside our control. One is a real defect: the
spent refresh token in §5.1 is reachable and redeeming it is the canonical
reuse-detection trigger, so our own code could cause the next revocation unaided. The
other is not a code change at all but a decision about pooling five subscription
accounts from one host under one client identity (§4.1, §6.2). If neither applies —
if this was a password reset or an upstream fault — there was nothing to prevent, and
the remaining work is making the failure cheaper (§6.3).

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
   08-28, `bluesky` 08-30). The stored expiry is a local claim about validity, not
   proof of server-side validity; the server evidently did not honour it.
3. `CodexAccountAuthError` triggered a forced refresh in `withRetry.ts:713` and
   `withRetry.ts:739`, entering `maybeRefreshAccount` at `accounts.ts:230`. OpenAI's
   token endpoint responded with the OAuth error code `refresh_token_invalidated`.
4. `codexTokenRefresh.ts:452-480` extracted that code (`credentialReason`, line 472),
   wrote it into the vault's `refresh` block as `state: reauth_required` with
   `reason` (line 478, persisted line 480), and `markAccountDead` removed the account
   from rotation.

Both the access credential and the refresh credential were rejected. **Whether they
were revoked by a single atomic upstream action was not observed** and is not claimed.

## 3. What was ruled out, and how

### 3.1 Token expiry

Ruled out. Stored expiry was 6 days out (`onbi`) and 8 days out (`bluesky`).

### 3.2 A rotation race in our own refresh machinery

Ruled out on four checks. Every one is reproducible from Appendix A, command noted.

| Check | Result | Appendix |
|---|---|---|
| Last local rotation predates the window | `onbi` 2026-08-18, `bluesky` 2026-08-20 | A1 |
| No refresh attempt precedes the 401 | Exactly 2 `core-refresh-start` lines on 08-21/08-22, both *after* their 401 | A4 |
| No interrupted refresh state recorded | Every vault `refresh.state` is `reauth_required` or `idle`; none `in_flight` or `unknown` | A3 |
| No raw-path distress markers | `raw-refresh-probe` and `raw-refresh-lock-compromised` occur 0 times corpus-wide | A6 |
| Live token still matches the hash recorded at death | `onbi` `5aad821d…`, `bluesky` `1f6da81d…`, both match | A1 |

**Correction to rev 2.** Rev 2 cited a "durable attempt ledger" as the state store.
That was the wrong store for these accounts. The raw-refresh ledger
(`~/.cat-code/codex-raw-refresh.state.json`) governs only the raw/config refresh path;
it currently holds nine entries, all test-fixture account names, and **no entries for
any real account**. Both incident accounts are vault-sourced (`source=vault` in both
`core-refresh-start` lines), so their durable state is the vault file's own `refresh`
block, which is what row 3 above actually checks. `raw-refresh-probe` and
`raw-refresh-lock-compromised` are log markers, not ledger states, and are counted
separately in row 4.

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

Excluded **for this incident**, but it is a latent defect, not inert hygiene (§5.1).

`~/.cat-code/.cat-code.json` `codexOAuth` holds a second, superseded copy of
`bluesky`'s OAuth session carrying the pre-08-20 token pair: refresh hash `ea440d3f…`
against the vault's live `1f6da81d…`. A spent refresh token from a live chain in a
second store is what trips OAuth reuse detection, so this was the leading local
hypothesis.

It was not used in the observed incident: both `core-refresh-start` lines record
`source=vault`, and five vault accounts were loaded throughout. **It is not
unreachable in general** — see §5.1.

### 3.6 A second login for `onbi`

Ruled out for this incident. The official Codex CLI (`~/.codex/auth.json`) is logged
into `onbi` under a **different OAuth session** and therefore a separate refresh
chain (verifiable as a boolean via A5; the session identifiers are not printed). That
file has not been written since 2026-08-16 and rotated nothing on 08-22.

**That session is also an untested discriminator, and it is perishable.** Rev 3 used
it only to exclude a rotation cause and never asked whether it still authenticates.
Its access token was issued 2026-08-16 and carries `exp` 2026-08-26 (A11), so it is
locally unexpired at the time of writing. Local expiry is not server-side validity
(§2 step 2) — which is exactly why probing it is informative:

| Probe result | What it excludes | What it leaves |
|---|---|---|
| Still authenticates | Password reset, "log out of all devices", account-level disable — all of which terminate every session for the account | A revocation scoped to the sessions this client held |
| Also rejected | A revocation scoped to this client's sessions | Account-wide termination, by any of the causes in §4.2 |

This does not identify a cause. It halves §4.2. A11 prints the expiry; A12 is the
probe itself.

**A12 was run on 2026-08-23 with operator approval. The separate session is also
dead.** Both controls behaved, so the result is interpretable:

| Target | Result |
|---|---|
| `~/.codex/auth.json` session for `onbi` (issued 08-16, never used by this fork) | **HTTP 401**, `x-openai-ide-error-code=token_invalidated` |
| vault `onbi` (known dead — control) | HTTP 401, same code |
| vault `main` (known healthy — control) | HTTP 200, `plan_type=plus` |

**The revocation was account-wide, not scoped to this fork's sessions.** Two
independent OAuth sessions for `onbi`, with different session identifiers and
separate refresh chains, are both invalidated. A revocation aimed at the sessions
Cat Code held is therefore excluded, and with it the reading that some detector
acted on this client's request behaviour and killed only what it was using.

Two qualifications, neither of which overturns the result:

- **Shared client identity.** Both sessions were minted under the same public client
  id (§4.1), so a provider that permits one session per (account, client) could have
  ended the CLI session when this fork acted on the account. Checked: the only
  `onbi` event between 08-16 and the incident is a `core-refresh-start` from
  `codex-core.maybeRefreshAccount` at `2026-08-18T03:10:47.750Z`, an in-chain token
  refresh, not a fresh authorization. A refresh rotates its own chain and does not
  mint a session, so this path is unlikely — but it is not formally excluded.
- **Error code differs from the incident.** The probe returned
  `token_invalidated`; the 08-22 rejections carried `token_revoked` as both
  `x-openai-ide-error-code` and `-root-error-code`. Whether these are distinct
  upstream states or the same state reported differently after time is unknown, and
  no weight is placed on the difference.

Note also that `main` answers 200 from the same host, under the same client identity,
inside the same pool. Whatever selected `onbi` and `bluesky` selected by account, not
by host, address, or client.

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
day the other two were rejected, and ran concurrently with both. Neither does plan
tier: all five accounts carry `chatgpt_plan_type=plus` (A11).

**This table is confounded, and rev 3 did not say so.** `amr` is presented as the
variable, but the four OTP accounts are also the four accounts that exist only to be
pooled, and the Google account is also the operator's own everyday account. "Created
by email OTP" and "created to be a pool secondary" select the identical four rows
here. No observation in this corpus separates them, so the table cannot be read as
evidence that the *authentication method* is what matters.

**Correlatable signals from one host.** Five distinct identities and org ids from one
IP (`cf-ray` suffix `BKK`); overlapping concurrent use of `onbi` and `bluesky` on
08-21 and 08-22; and a failover in which one workload shape (57,320-byte instructions,
hash `d635eab6`, messages=73) crossed between account identities inside one second.

**Client identity: the fork authenticates as the official Codex CLI.** Rev 3 recorded
this as an inconsistent `originator` and understated it. Cat Code does not merely send
the official CLI's originator string at request time; it performs the entire OAuth
flow under the official CLI's own public client identity:

| Surface | Value | Source |
|---|---|---|
| OAuth `client_id` | the official Codex CLI's public client id | `src/constants/codex-oauth.ts` |
| `redirect_uri` | `http://localhost:1455/auth/callback` (the CLI's port) | `src/constants/codex-oauth.ts` |
| Authorize-time `originator` | `cat-code` | `src/services/oauth/codex-client.ts:160` |
| Request-time `originator` | `codex_cli_rs` | `src/services/api/codex-fetch-adapter.ts:3389` |
| Refresh / usage / image paths | `codex_cli_rs` | `codexTokenRefresh.ts:406`, `codexUsage.ts:223`, `GenerateImageTool.ts:879` |

`cat-code` therefore appears exactly once per account, as a non-standard query
parameter at authorization; every subsequent request is indistinguishable on its
headers from the official client. Combined with the other signals in this section,
what an upstream correlator sees is five `plus` accounts on one address presenting
one client identity, with a single workload shape crossing between two of them
inside one second.

This is recorded as an observation about what is correlatable. It is not evidence of
any particular upstream response, and §4.2 still applies.

### 4.2 What these observations cannot separate

The evidence establishes sequential server-side rejection of two accounts carrying
the same workload, and — since A12 (§3.6) — that the rejection was **account-wide**
rather than scoped to the sessions this fork held. That excludes one candidate: a
detector acting on this client's request behaviour and terminating only its own
sessions. It does **not** distinguish between:

- policy enforcement applied at the account level,
- a manual session invalidation (password reset, "log out of all devices"),
- an automated account-security action unrelated to pooling,
- an upstream defect or partial outage affecting a subset of accounts,
- some other cause correlated with account age or creation method.

The surviving candidates share a property worth stating: all of them act on the
account. The cheapest remaining discriminator is not technical — it is whether the
operator performed a password reset, a device sign-out, or any account-security
action on `onbi` or `bluesky` around 2026-08-22. That has not been established
either way.

Sample size is five accounts and four events over two months, from one host. That is
a suggestive pattern, not a demonstrated mechanism.

### 4.3 A signal investigated and rejected

An earlier draft cited `WebSocket connect error` events clustering around the two
rejections as weak corroboration. **That claim is withdrawn.** It was an artifact of
sampling only the 80 most recent debug logs.

Counting one canonical `initial_ws_error_classified` line per failure, the full corpus
holds **24 distinct WebSocket connect failures** from 2026-07-09 to 2026-08-22, across
multiple accounts and dates. (The paired `WS unavailable, falling back to HTTP` line
also occurs 24 times, confirming the count.) Two of them — `2026-08-20T14:32:03.737Z`
and `2026-08-20T14:32:03.894Z` — immediately precede a **successful** `bluesky` token
refresh at `14:32:04.938Z`.

Rev 2 reported 22 because it deduplicated second-truncated timestamps, merging that
pair. WebSocket connect failures are background noise here and carry no predictive
value. Recorded so the same mistake is not repeated.

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
refresh token be redeemed, which is precisely the reuse-detection trigger. Treat this
as a defect to clear, not harmless stale data. Not actioned here: credential state
requires operator approval.

### 5.2 Config mirror is not kept in sync

`activeCodexAccountId` is `main` while the mirrored `codexOAuth` block holds
`bluesky`'s 08-15 tokens.

The established defect is that **subsequent refreshes and active-account changes do
not resynchronize the mirror**. The provenance of this particular stale value was not
determined: at least two writers exist — login (`ConsoleOAuthFlow.tsx:217`) and
account removal (`codexAccountPool.ts:876`) — and nothing in the evidence identifies
which one wrote it.

### 5.3 Terminal accounts are re-marked dead on every periodic cycle

`hiby` and `yoxrent2` have been terminal since June and July, yet `marked dead` lines
are re-emitted for them: **28 lines forming 14 two-account pairs** between 08-15 and
08-21.

The mechanism is not the quarantine probe. That probe runs every second
(`QUARANTINE_PROBE_INTERVAL_MS = 1_000`, `codexTokenRefresh.ts:782`) and selects only
`quarantined` accounts. The four-hour path is the periodic refresh timer calling
`touchAll()` (`codexTokenRefresh.ts:739-755`, interval from
`codexTokenRefreshIntervalHours`, default 4); the terminal-state short-circuit at
`codexTokenRefresh.ts:340-345` then calls `markAccountDead` again for an
already-dead account.

Rev 2 reported "15 cycles" by deduplicating second-truncated timestamps. One cycle
straddles a second boundary (`hiby` at `2026-08-18T08:44:37.946Z`, `yoxrent2` at
`…:38.076Z`) and was split in two. Pair the lines by account instead: 14 cycles.

Operational cost: long-dead accounts look like fresh failures in the logs. This is why
the incident initially appeared to affect four accounts rather than two.

## 6. Recommendations

Separated by what they achieve. Only §6.2 bears on whether this recurs; §6.1 and
§6.3 are recovery and cost reduction and are worth doing whatever the cause was.

> **Status, 23 Aug 2026.** Item 4 data cleanup **done**: the stale `codexOAuth`
> block (`93ce612e`, refresh hash `ea440d3f…`) was removed from
> `~/.cat-code/.cat-code.json`; backup at
> `~/.cat-code/.cat-code.json.bak-before-codexoauth-clear`. 41 top-level keys to 40,
> every surviving value byte-identical, mode `0600`. The desktop app rewrote the
> config 2m17s later and did **not** resurrect the block. The *code* half of item 4
> is still open, and matters more: `/login` writes the mirror
> (`ConsoleOAuthFlow.tsx:217`) and §5.2 says nothing resyncs it, so the next login
> repopulates what was just deleted. The fallback paths in §5.1 are what make that
> repopulated value redeemable; closing them is the durable fix.
> Item 7 **done** in `1c7b4763`. Items 1, 2, 5, 8 open.

### 6.1 Time-boxed, do first

1. ~~Decide on the A12 probe before 2026-08-26.~~ **Done 2026-08-23**: run with
   operator approval, result in §3.6. The separate session was also dead, so the
   revocation was account-wide. No deadline remains here.
2. **Re-login `onbi` and `bluesky` via `/login`.** Vault files are otherwise intact;
   only the `refresh` block is terminal. A12 has already run, so there is no longer
   any sequencing constraint. Note the official Codex CLI login for `onbi` is dead
   too and will need redoing separately if it is still wanted.
3. **Treat re-login as an observation, not a test that settles §4.** A second
   rejection under similar usage would be *consistent with* the hypothesis; it would
   not confirm it, since the alternatives in §4.2 can also recur.

### 6.2 Prevention, honestly scoped

4. **Clear the stale `codexOAuth` credential** (§5.1). This is the only identified
   mechanism by which *our own code* could cause a revocation: redeeming a spent
   refresh token from a live chain is the canonical reuse-detection trigger, and
   §5.1 shows two reachable paths to it. Add resync for the mirror (§5.2).
5. **Everything else that bears on recurrence is a policy decision, not a code
   change** — and consolidation is not one of the options. If §4's hypothesis is
   right, the operative input is that subscription accounts are pooled and rotated
   from one host under one client identity (§4.1). The obvious prevention is to stop
   pooling, but the demand measurement (A13) shows that is not available at this
   workload: all three live accounts have each hit `primary-used-percent=100`, and
   on 8 of 30 observed days the pool consumed more than one account's entire
   rolling-window allowance — 3.0 accounts' worth on 2026-08-17, when `main`,
   `bluesky` and `onbi` were pinned at 100% simultaneously. One subscription would
   not carry this.

   What follows is that the only mitigation which both removes the exposure and
   preserves the capacity is **metered billing** — OpenAI platform API keys, or the
   Anthropic path this fork already supports — where sustained volume is the
   intended use rather than something to be spread across accounts. A partial
   measure is to keep the operator's primary account out of the pool so an
   enforcement event cannot take the account they actually depend on; note this
   costs capacity too, since `main` is itself a fully-utilised pool member.

   Reducing the *correlatability* of the pattern (address rotation, staggered
   failover, retaining the official client's identity) is not mitigation. It is
   deliberately not proposed here and should not be built.

   **Correction.** An earlier draft of this section offered "consolidate onto one
   account" as a prevention. A13 shows that recommendation was unfounded; it was
   written before per-account utilisation was measured.
6. **No change to the token path is indicated.** Classification, failover, and
   terminal recording all behaved correctly.

### 6.3 Reduce the cost of the next one

7. Suppress repeat `marked dead` emission for already-terminal accounts (§5.3). The
   noise is why this incident initially read as four accounts rather than two.
8. `markAccountDead` (`codexAccountPool.ts:609-636`) emits only `logForDebugging`;
   no user-facing surface reports an account dying. Add one, independent of what
   caused this incident.

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

Run from the repository root. Python commands use `uv` per repository convention.
All commands below were executed for rev 3 and reproduce the numbers cited.

**Disclosure.** The `uv run python` commands (A1, A2, A3, A5) print only aliases,
states, dates, and booleans: no token, email, OAuth session identifier, or full
account UUID. The `grep` commands (A4, A8, A9, A10) print raw log lines, which **do**
contain full account UUIDs; redact their output before pasting it anywhere.

**A1 — vault integrity and last rotation (§3.2 rows 1 and 5):**

```bash
uv run python -c '
import json,glob,os,hashlib
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f)); r=v.get("refresh",{})
    live=hashlib.sha256(v["tokens"]["refresh_token"].encode()).hexdigest()
    print(v.get("alias"), "state=",r.get("state"), "hash_match=",live==r.get("refresh_token_hash"), "last_refresh=",v.get("last_refresh"))
'
```

`main` reports `hash_match=False` because it is `idle` and has no recorded hash. That
is expected, not a finding.

**A2 — auth-method table (§4.1):**

```bash
uv run python -c '
import json,glob,os,base64
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f)); p=v["tokens"]["access_token"].split(".")[1]; p+="="*(-len(p)%4)
    j=json.loads(base64.urlsafe_b64decode(p))
    print(v.get("alias"), j["https://api.openai.com/auth"].get("amr"))
'
```

**A3 — no interrupted refresh state (§3.2 row 3):**

```bash
uv run python -c '
import json,glob,os
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f)); r=v.get("refresh",{})
    print(v.get("alias"), "state=",r.get("state"), "interrupted=", r.get("state") in ("in_flight","unknown"))
'
```

**A4 — refresh attempts in the window (§3.2 row 2). Expect exactly 2, both after
their 401:**

```bash
cd ~/.cat-code/debug && grep -rh "core-refresh-start" . | grep "14f2f119\|93ce612e" | awk '$1>="2026-08-21" && $1<="2026-08-23"'
```

**A5 — `onbi` session independence (§3.6). Looks the account up by alias and prints a
boolean; neither the session identifiers nor the account UUID appear:**

```bash
uv run python -c '
import json,glob,os,base64
def sid(t):
    p=t.split(".")[1]; p+="="*(-len(p)%4)
    return json.loads(base64.urlsafe_b64decode(p)).get("session_id")
cli=json.load(open(os.path.expanduser("~/.codex/auth.json")))["tokens"]["access_token"]
for f in glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json")):
    v=json.load(open(f))
    if v.get("alias")=="onbi":
        print("onbi vault session == codex-cli session:", sid(cli)==sid(v["tokens"]["access_token"]))
'
```

**A6 — raw-path distress markers (§3.2 row 4). Expect 0:**

```bash
cd ~/.cat-code/debug && grep -rh "raw-refresh-probe\|raw-refresh-lock-compromised" . | wc -l
```

**A7 — WebSocket failure count (§4.3). Expect 24 from each line:**

```bash
cd ~/.cat-code/debug
grep -rh "initial_ws_error_classified" . | grep -c "WebSocket connect error"
grep -rh "WS unavailable, falling back to HTTP: WebSocket connect error" . | wc -l
```

**A8 — repeat-dead count (§5.3). Expect 28 lines forming 14 pairs:**

```bash
cd ~/.cat-code/debug && grep -rh "marked dead" . | grep "9ed41939\|66608311" | awk '$1>="2026-08-15" && $1<="2026-08-22"' | sort
```

Pair the sorted output by account (`9ed41939` then `66608311`). Do **not** group by
truncated timestamp: one pair straddles a second boundary (§5.3).

**A9 — incident window (§1):**

```bash
grep -h "14f2f119\|85980e5b" ~/.cat-code/debug/8bdf9d62-*.txt | awk '$1 >= "2026-08-22T14:52:19" && $1 <= "2026-08-22T14:52:40"'
```

**A10 — network-failure control (§3.4):**

```bash
cd ~/.cat-code/debug && grep -rh "ENOTFOUND\|ECONNREFUSED\|ENETUNREACH" .
```

**A11 — plan tier, auth method, and token dates for all five accounts (§4.1, §3.6).
Prints alias, plan, `amr`, issue and expiry dates only:**

```bash
uv run python -c '
import json,glob,os,base64,datetime
for f in sorted(glob.glob(os.path.expanduser("~/codex-vault/accounts/*.json"))):
    v=json.load(open(f)); t=v["tokens"]["access_token"]
    p=t.split(".")[1]; p+="="*(-len(p)%4)
    c=json.loads(base64.urlsafe_b64decode(p)); a=c["https://api.openai.com/auth"]
    d=lambda k: datetime.datetime.fromtimestamp(c[k],datetime.UTC).strftime("%Y-%m-%d")
    print(v.get("alias"), a.get("chatgpt_plan_type"), a.get("amr"), d("iat"), d("exp"), (v.get("refresh") or {}).get("state"))
'
```

Run the same decode against `~/.codex/auth.json` for the separate `onbi` session
referenced in §3.6; rev 4 measured `iat` 2026-08-16, `exp` 2026-08-26.

**A13 — per-account demand, for §6.2.** Joins `[codex-cache] request` lines (which
carry `account=` and `conv=`) to `[codex-cache] route` lines (which carry `conv=` and
the rate headers), then reports peak `x-codex-primary-used-percent` per account per
day and the daily sum across accounts. 4,068 route samples, all attributed. Because
the rate window is 10080 minutes (§3.3), a sum of 300% reads as "three accounts'
entire weekly allowance consumed", not "300% of one day". The method is stated fully
above and is rebuildable from it; a working copy was left at `tmp/headroom.py`, which
is gitignored scratch and may not survive. It prints aliases and percentages only.
Result cited in §6.2: peak 100% for `main`, `bluesky` and `onbi`; 8 of 30 days above
100% summed; 2026-08-17 at 300%.

**A12 — liveness probe for the §3.6 discriminator. RUN 2026-08-23**, with operator
approval; result and interpretation in §3.6. Read-only GET against the usage endpoint
(`codexUsage.ts:84`, headers per `codexUsage.ts:216-224`); it does not refresh,
rotate, or write. Probe the `~/.codex/auth.json` token for `onbi`, with vault `onbi`
(expected reject) and vault `main` (expected accept) as controls, so the result is
interpretable in both directions. Interpretation table in §3.6.

## Appendix B: revision history

**Rev 4 (23 Aug 2026)** — third pass, prompted by the question the earlier revisions
declined to push on: why, and what prevents it. Three changes of substance. §3.6 now
records that the separate `onbi` CLI session is an **untested discriminator** with a
hard expiry of 2026-08-26; rev 3 held that session in hand and used it only to exclude
a rotation cause. §4.1's `amr` table is marked **confounded** — the four OTP accounts
are also the four pool secondaries, all five accounts are `plus` (A11), and nothing in
this corpus separates auth method from account role. The client-identity note is
upgraded from "inconsistent `originator`" to what the code actually does: the fork
performs OAuth under the official Codex CLI's own public client id and callback port,
so `cat-code` is emitted once per account at authorization and never again;
`codex-client.ts` anchors corrected to `src/services/oauth/codex-client.ts:160` and
`src/constants/codex-oauth.ts`. §6 restructured into recovery / prevention / cost, and
states plainly that the only prevention inside our control is §5.1 plus a policy
decision about pooling; reducing correlatability is named and declined. Appendix gains
A11 and A12; A12 is specified but deliberately not run.

Amended later the same day, after the mitigation question was put directly. A13 was
added and §6.2 rewritten around it: per-account demand had never been measured, and
measuring it withdrew this revision's own "consolidate onto one account"
recommendation. All three live accounts have hit 100% of their rolling-window
allowance, and the pool exceeded one account's allowance on 8 of 30 observed days,
reaching 3.0 accounts' worth on 2026-08-17. Metered billing is now stated as the only
mitigation that removes the exposure while preserving the capacity.

Amended again the same day: **A12 was run** with operator approval. The separate
`onbi` session in the official Codex CLI is also dead, so the revocation was
account-wide and not scoped to this fork's sessions. §3.6 carries the result and two
qualifications; §4.2 drops the session-scoped candidate and names the remaining
non-technical discriminator; the executive summary and §6.1 are updated. Both probe
controls behaved (`main` 200, dead vault session 401), and the 08-18 `onbi` event was
verified to be an in-chain refresh rather than a fresh authorization, which is what
makes the shared-client-id confound unlikely.

**Rev 3 (23 Aug 2026)** — second review pass. WebSocket count corrected 22 → **24**
distinct failures (rev 2 merged two `bluesky` failures 157 ms apart by truncating
timestamps to seconds); repeat-dead count corrected "15 cycles" → **14 pairs** (rev 2
split one cycle that straddles a second boundary); a counting-method note added,
because both errors share one cause: timestamps are observations, not event
identifiers. §3.2 restructured into a per-check table with an appendix reference for
each, and corrected — rev 2 cited the raw-refresh ledger, which governs only the
raw/config path and holds no real-account entries; the applicable store for these
vault-sourced accounts is the vault `refresh` block, and the raw-path markers are
logs, not ledger states. Anchors tightened: `:452-475` → `:452-480`, `:734` →
`:739-755`. §5.2 no longer attributes the stale mirror value to a specific writer.
Appendix expanded from 6 commands to 10, covering every §3.2 check plus §3.6, switched
to `uv run python`, and its disclosure claim corrected (aliases are identifiers).
Added recommendation 6 (no user-facing surface reports account death).

**Rev 2 (23 Aug 2026)** — first review pass. Causal language removed from the summary,
§1, and §4; §4 reframed from attribution to hypothesis with an explicit list of causes
it cannot separate; WebSocket corroboration withdrawn as a sampling artifact (§4.3);
§3.5 corrected from "never redeemed" to a conditional exclusion with the reachable
path recorded as a latent defect (§5.1); §5.3 mechanism corrected from the quarantine
probe to periodic `touchAll()` plus terminal short-circuit; `accounts.ts:519` anchor
corrected to the real refresh entry point; "valid" narrowed to "locally unexpired";
atomic-revocation claim withdrawn; emails and OAuth session identifiers removed;
placeholder appendix replaced with runnable commands.

**Rev 1 (23 Aug 2026)** — initial report. Superseded. Contained account emails and
OAuth session identifiers, since removed.
