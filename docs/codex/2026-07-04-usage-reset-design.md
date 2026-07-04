# Codex usage-limit reset redemption — technical design

- Date: 2026-07-04
- Status: proposed, rev 3 — Settings Reset tab rework; design only, implementation in working tree
- Goal: let a Cat Code user redeem an available Codex usage-limit reset, at parity with upstream Codex CLI `/usage` → option 2 ("Redeem usage limit reset"), adapted to Cat Code's account pool.

## 1. Inputs and ground truth

- Upstream behavior (verified against `openai/codex` @ `98d28aab`): [2026-07-04-usage-reset-upstream-facts.md](2026-07-04-usage-reset-upstream-facts.md)
- Cat Code internals: [2026-07-04-usage-reset-catcode-recon.md](2026-07-04-usage-reset-catcode-recon.md)
- Prior (partially corrected) report: `~/.gemini/antigravity/brain/f7e0d1bf-e852-4c63-b869-664a2eb33f74/reset_redemption_report.md`

Session-verified facts this design leans on:

- `parseUsageResponse` (`src/services/api/codexUsage.ts:503`) parses `data.rate_limit` and `data.credits` only; `rate_limit_reset_credits` is silently dropped today. Exposing it is purely additive.
- `meetsAvailabilityRequirement` (`src/commands.ts:437`): the `'claude-ai'` arm breaks early when `provider === 'openai'`, so today's `/usage` is deliberately hidden in Codex sessions. `'openai'` already exists in the `CommandAvailability` union.
- `updateAccountUsageHints` (`src/services/api/codexAccountPool.ts:1185`) can **uncap** only when the hint reports healthy AND `cappedAt` is older than `USAGE_UNCAP_GRACE_MS` (2 min). Hints never **re-cap** `status`; only `rotateOnFailure`/`markPoolAccountCapped` do. But a fresh bad hint blocks the account via `getCodexAccountAvailability` (`codexAccountPool.ts:1311`) for up to 5 min (`USAGE_HINT_STALE_MS`) unless `usageResetAt` has already elapsed.
- `rotateOnFailure` (`codexAccountPool.ts:287`) caps the 429'd account and promotes the next healthy account to active — so right after a cap, **the active account is the one that does *not* need a reset**.
- `refreshAccountTokens(accountId, refreshToken, vaultFilePath)` (`codexTokenRefresh.ts:259`) is vault-only; `loadConfigAccount()` (`codexAccountPool.ts:1015`) builds config accounts with **no `vaultFilePath`**. The dual-path refresh pattern (stateful vault refresh vs raw refresh under cross-process lock) already exists in `src/codex-core/accounts.ts:185-214` (`maybeRefreshAccount`/`refreshAccountNow`).
- `isPoolActive()` (`codexAccountPool.ts:222`) requires **more than one** account; `hasAnyPoolAccount()` (`codexAccountPool.ts:231`) is the any-token predicate. `Settings/Usage.tsx:263` currently gates the Codex section on `isPoolActive()`, so a single-account Codex user sees no Codex usage there today.
- `fetchAccountUsageOnce` (`codexUsage.ts:105`) treats HTTP 401 as observational — no refresh, locked in by tests — so an expired token silently yields "no usage data".
- No interactive per-account command precedent exists (`/accounts` and `/switch-account` are `type: 'local'` text commands). Interactive precedents are the Settings Usage tab and the Login dialog; `src/components/design-system/` has `Dialog`, `ListItem`, `LoadingState`, `StatusIcon`, `KeyboardShortcutHint`.

Upstream API contract (all verified in the fact sheet):

| Aspect | Value |
|---|---|
| Availability read | `GET https://chatgpt.com/backend-api/wham/usage` — same endpoint Cat Code already calls; top-level optional `rate_limit_reset_credits: { available_count }`, no other siblings |
| Consume | `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume` |
| Consume headers | `Authorization: Bearer <token>`, `ChatGPT-Account-Id`, `Content-Type: application/json`, Codex User-Agent. **No `originator` header** (it lives inside upstream's UA string) |
| Consume body | `{ "redeem_request_id": "<uuid v4>" }` |
| Response | HTTP 2xx + `{ code: "reset"\|"nothing_to_reset"\|"no_credit"\|"already_redeemed", windows_reset }` (+ ignored `credit`); non-2xx = error with no code. `windows_reset` is a non-null integer, missing-defaults-to-0 |
| Success codes | `reset` and `already_redeemed` (idempotent success) |
| Idempotency key | Minted when the confirmation view is built; reused only by "Try again" on the error popup for that same attempt; new confirmation = new UUID |
| Post-success | Clear cached credit count, refresh rate limits, show "Usage reset. You have {N} usage limit reset(s) left." (refresh failure → just "Usage reset.") |
| Failure handling | Layered timeouts upstream (10 s app-server consume timeout + separate TUI-side JSON-RPC timeouts); single attempt; generic error UI; no 401-specific retry on this path; token proactively refreshed (≈5-min near-expiry window) before the client is built |

## 2. Decisions at a glance

| Decision | Choice |
|---|---|
| Entry point | `/usage reset` argument on the existing `/usage` command; plain `/usage` keeps opening Settings |
| Command availability | `/usage` → `['claude-ai', 'openai']`; within visible sessions, the reset flow gates at runtime on *codex accounts existing* |
| Settings Usage fix (in scope) | Codex section renders when **any** codex account exists (`hasAnyPoolAccount()`), not only multi-account pools — otherwise plain `/usage` is an empty page for single-account Codex users |
| API surface | Two changes in `src/services/api/codexUsage.ts`: parse `rate_limit_reset_credits` into `AccountUsage`, add `consumeUsageLimitReset()` |
| Consume headers | Upstream-aligned: no `originator` on the POST; default fetch UA kept as a documented divergence |
| Account targeting | Default = first `capped/usage_cap` account with credits available-or-unknown (NOT the active account); picker with per-account eligibility; confirm step always names the target |
| Token refresh | Dual-path (vault-stateful vs raw-under-lock, per `codex-core/accounts.ts`), run **before** the availability read and re-checked before consume; repo/upstream near-expiry threshold, not an invented one |
| Idempotency | `randomUUID()` minted per confirmation view, held in dialog state, reused on Try again — upstream lifetime exactly |
| Post-success | New `applyRedeemedUsageReset(accountId)` pool primitive + `redeemedAt` lag-guard mirroring the existing uncap grace, then forced usage refresh; `no_credit` invalidates the usage cache |
| Out of scope | Startup hint cell, auto-redemption by routing, `/reset-limits` stub revival, multi-base-URL support |

## 3. Placement — options and recommendation

**A. Embed in Settings Usage tab** (`src/components/Settings/Usage.tsx`). Right data context (per-account cards already exist), but the tab has no selection model, and a 4-state modal flow (confirm → progress → result → error/retry) inside a shared full-screen Settings component is the largest and riskiest diff for a one-shot action.

**B. New standalone command** (e.g. `/reset-usage`). Clean isolation, but invents a new top-level name for something upstream users find under `/usage`, and the dead `/reset-limits` stub shows how confusable "reset" command names get.

**C. `/usage reset` argument dispatch — recommended.** `local-jsx` commands receive an args string; `usage.tsx` branches: no args → `<Settings defaultTab="Usage">` as today; `reset` → a small self-contained redeem dialog co-located in `src/commands/usage/`. Zero new command names, upstream-adjacent ("it's under /usage"), `argumentHint: '[reset]'` advertises it, and the dialog reuses the Login-dialog pattern. Discoverability is supplemented by Slice 4 (Settings shows "N resets available — run /usage reset").

**D. Text-only `/accounts reset <alias>`.** Fewest UI states, but no availability display, no confirmation step, and a typed-alias interface for an action that spends a limited credit is error-prone. Upstream deliberately defaults the confirmation to Cancel; we should not remove the confirm gate. Rejected.

**Recommendation: C.** Smallest blast radius consistent with a confirm-gated, pool-aware flow.

## 4. Availability and gating

- `src/commands/usage/index.ts`: `availability: ['claude-ai', 'openai']`, add `argumentHint: '[reset]'`.
- **Required companion fix:** `Settings/Usage.tsx` renders the Codex usage section when `hasAnyPoolAccount()` (any initialized codex account), not `isPoolActive()` (>1). Without this, plain `/usage` in a single-account Codex session opens a Claude-centric page with no Codex content (`fetchUtilization()` returns `{}` for non-Claude subscribers). One card renders fine in the existing list layout.
- The `reset` flow gates at **runtime on codex accounts existing** — scoped claim: *within sessions where `/usage` is visible at all* (claude-ai or openai provider). Rationale for not gating on `provider === 'openai'`: Cat Code sessions can be Claude-primary while holding a Codex pool for subagents; those accounts cap and need resets too. This is a deliberate divergence from upstream (which has no pool). With no codex accounts: `/usage reset` shows an info message and exits.
- Entry gate = accounts exist; **per-account redemption eligibility** is a separate predicate applied in the picker (§7): eligible iff the account has a token AND `status` is `'healthy'` or `'capped'` with `statusReason === 'usage_cap'`. `dead` → disabled ("re-login required"); `quarantined` → disabled ("connection problems; retry later"); known-zero credits → disabled. If *no* account is eligible, show the most specific blocking reason instead of a generic message.
- Known edge (accepted, unchanged): a console-API-key session with a codex pool cannot see `/usage` (no `'console'` in availability). Adding `'console'` would surface the Claude-centric usage page to all first-party API-key users — a separate product decision; revisit if it bites.

## 5. API client changes (`src/services/api/codexUsage.ts`)

### 5.1 Read: reset-credit availability

- `AccountUsage` gains `resetCreditsAvailable?: number` — `undefined` when the field is absent or malformed (free plans / older backends may omit it; upstream models it as optional).
- `parseUsageResponse`: read `data.rate_limit_reset_credits` as an object and extract a finite `available_count` number; anything else → `undefined`. Additive; no existing consumer changes; the 60 s snapshot cache carries the field automatically.

### 5.2 Consume

```ts
const WHAM_RESET_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'

export type ConsumeResetOutcome =
  | { kind: 'reset' | 'already_redeemed'; windowsReset: number } // missing → 0
  | { kind: 'nothing_to_reset' | 'no_credit' }
  | { kind: 'http_error'; status: number; bodySnippet: string }
  | { kind: 'invalid_response'; bodySnippet: string }
  | { kind: 'network_error'; error: string }

export async function consumeUsageLimitReset(
  account: Pick<PoolAccount, 'accountId' | 'accessToken'>,
  redeemRequestId: string,
): Promise<ConsumeResetOutcome>
```

- `POST` with body `{ redeem_request_id: redeemRequestId }`; 10 s `AbortController` timeout via the existing `FETCH_TIMEOUT_MS` idiom. This is Cat Code's simplified single-layer timeout — upstream layers an app-server 10 s timeout under separate TUI-side RPC timeouts; we have one fetch, so one timeout. Single attempt, no internal retry (the dialog drives retry with the same UUID, matching upstream).
- Headers: `Authorization: Bearer`, `chatgpt-account-id`, `Content-Type: application/json`, `Accept: application/json`. **No `originator` header** — upstream's consume sends none (its originator lives inside the Codex User-Agent). We keep the runtime's default UA rather than forging upstream's versioned UA string; that UA divergence is deliberate and documented. If the server ever rejects the POST on fingerprint grounds, mirror upstream's UA exactly as the fallback. Tests assert `originator` is absent.
- Strict parsing on 2xx: `code` must be one of the four known values, else `invalid_response` (never assume success when spending a credit). `windows_reset`: finite integer; missing → `0` (upstream serde default); `null`/string/object → `invalid_response`. Strictness on a success response is safe here: a false negative sends the user to "Try again", which reuses the same UUID and resolves as `already_redeemed`. Non-2xx → `http_error` with status + truncated body. All failure paths log via `logForDebugging` with the account-id prefix idiom.
- **Endpoint scope (deliberate):** Cat Code targets only the first-party ChatGPT WHAM base, hardcoded exactly like the existing `WHAM_USAGE_URL`. Upstream's `/api/codex/...` path style, staging hosts, and base-URL normalization are out of scope — no URL builder until a second base is actually needed.
- No auto-refresh-on-401 inside the client (matches this file's observational stance). Token freshness is handled by the dialog pre-flight (§7).

## 6. Idempotency

- Mint `randomUUID()` (node `crypto`, existing precedent in `codexTokenRefresh.ts:11`) **when the confirmation view is built**, hold it in dialog state.
- "Try again" after a failed consume reuses the same UUID — same logical attempt.
- Cancelling back out and re-entering the confirmation builds a new view → new UUID. This is exactly upstream's lifetime; `already_redeemed` → success absorbs the duplicate-send race for a reused UUID.
- No persistence across dialog dismissal or process restart (upstream has none either). Residual double-spend edge: process dies after the request is sent but before the response lands, then the user redeems again with a fresh UUID. The second consume most likely returns `nothing_to_reset` because the limits were just reset; accepted (see §13).

## 7. Account targeting and tokens

Flow on `/usage reset`:

1. Runtime gate (§4). Then **token pre-flight for candidate accounts** (pools are small): for each codex account whose `expiresAt` is inside the near-expiry window, refresh via the dual-path pattern from `codex-core/accounts.ts` — `refreshAccountTokens` when `vaultFilePath` exists, raw refresh under the cross-process lock for config accounts. This must run *before* the availability read because `fetchAccountUsageOnce` treats 401 as observational and would silently return no data for expired tokens. Refresh failure on an account degrades it to "reset availability unknown" or, on a credentials error, "re-login required" (disabled).
2. `fetchPoolUsage({ forceRefresh: true })` — **without** `updateRoutingHints` — to get per-account `resetCreditsAvailable` fresh (upstream also re-checks availability on entry).
3. **Target selection.** Single codex account: skip the picker. Pool: list accounts (alias/email, status, usage %, "N reset(s)" / "reset availability unknown") with the eligibility predicate from §4. **Default selection = the first `capped/usage_cap` account with known-nonzero or unknown credits** — after a 429, `rotateOnFailure` has made the *healthy* account active, so defaulting to the active account would aim the reset at the account that doesn't need it. Fall back to the active account only when no capped account qualifies. The confirmation step always names the target account (alias/email), so a mixed-pool redemption is explicit.
4. Near-expiry threshold: reuse the repo's existing margin from the codex-core refresh path (upstream's is ≈5 min before JWT expiry; verify the exact constant during implementation — do not invent a new one). Re-resolve the account's token from the pool after any refresh, immediately before consume.
5. Consume, then post-success handling (§8). A 401 from consume itself surfaces as the generic error UI; Try again re-runs pre-flight + consume with the same UUID; a refresh credentials-failure surfaces the existing reauthentication message.

Subagent leases: healing updates the shared in-memory pool record, so future lease selection sees the account as available. Per the recon gotcha, *active* leases don't re-evaluate mid-turn; that behavior is unchanged and out of scope.

Type note: `codex-core`'s `CodexCoreAccount` and the pool's `PoolAccount` are sibling shapes. If reusing `maybeRefreshAccount` needs a non-trivial adapter, replicate its two-branch logic against `PoolAccount` instead — the branch (vault path exists → stateful, else raw-under-lock) is the load-bearing part, not the type.

## 8. Post-success refresh and pool healing

Two staleness hazards are the Cat-Code-specific core of this design:

**Hazard 1 — the heal is blocked by the uncap grace.** The only existing uncap path (`updateAccountUsageHints`) refuses to clear a cap younger than 2 min (`USAGE_UNCAP_GRACE_MS`), and "hit 429 → rotated → immediately redeem" is precisely the hot path. A post-redeem usage refresh alone therefore leaves the account capped. Fix: an explicit heal — a **confirmed server `reset`/`already_redeemed` is authoritative in a way polls are not**; the grace exists to distrust polls, not redemptions.

New pool primitive:

```ts
// codexAccountPool.ts
export function applyRedeemedUsageReset(accountId: string): void
```

- If `status === 'capped' && statusReason === 'usage_cap'` → set healthy, clear `statusReason`/`lastError`/`cappedAt` (same field set as the existing uncap branch, emitting the same `account.usage.uncap`-style diagnostic with reason "usage reset redeemed").
- Clear the hint block: `usageAllowed = true`, `usageLimitReached = false`, `usageFetchedAt = undefined`, `usageResetAt = undefined` (no fresh hint → `getCodexAccountAvailability` passes; scoring falls back to defaults until the next poll).
- Set `redeemedAt = Date.now()` (new optional `PoolAccount` field).
- Deliberately does **not** touch `dead`/`quarantined` — auth and network problems are orthogonal to usage caps.

**Hazard 2 — stale re-block after the heal.** `wham/usage` lags reality by minutes (the codebase's own words at `codexAccountPool.ts:1244`). A post-redeem poll can return `limit_reached: true` with the old still-in-the-future `reset_at`, which would re-block the account via the fresh-hint check for up to 5 min — right after the user spent a credit. There is currently no guard in this direction. Fix: mirror the existing idiom — in `updateAccountUsageHints`, skip applying a hint that reports `allowed === false || limitReached === true` when `now - account.redeemedAt < REDEEM_HINT_LAG_GRACE_MS` (new constant, 2 min, same value and a comment mirroring `USAGE_UNCAP_GRACE_MS`'s). Guarding at this chokepoint also covers hint application from the cached snapshot by later callers. After the grace, hints flow normally and reality wins.

Then the dialog refreshes for display: `invalidateUsageCache()` + `fetchPoolUsage({ forceRefresh: true })` (again without routing hints) to show "You have {N} usage limit reset(s) left."; if that refresh fails, show just "Usage reset." (upstream behavior — never show a stale count).

**`no_credit` cache handling:** the 60 s `cachedSnapshot` may still carry a stale nonzero `resetCreditsAvailable`. On `no_credit`: set the dialog's state for that account to zero AND call `invalidateUsageCache()` so no other surface re-offers a phantom credit. (The dialog itself always re-enters via `forceRefresh`, so this protects display consumers like Slice 4.)

## 9. UX flow and copy

States (dialog, co-located `src/commands/usage/`): gate → token pre-flight → [picker] → fresh availability check → confirm → consuming → result | error.

| State | Copy (upstream string where one exists) |
|---|---|
| No codex accounts | `No Codex accounts configured.` (+ pointer to the codex login flow — exact affordance verified at implementation time) |
| No eligible account | Most specific reason, e.g. `All Codex accounts need re-login.` |
| Checking | `Checking your available resets...` |
| Check failed | `Couldn't load usage limit resets. Please try again.` |
| Zero credits | `You don't have any usage limit resets available.` |
| Confirm title/subtitle | `Usage limit resets` / `You have {N} usage limit reset(s) available.` |
| Confirm description | `Reset your current monthly usage limit.` when `planType` is `free`/`go` or the primary window is ~monthly (`limitWindowSeconds ≥ 28 d`); else `Reset your current 5-hour and weekly usage limits.` Always names the target account (alias/email). |
| Confirm items | `Use a reset` / `Cancel` — **default `Cancel`** |
| Consuming | `Resetting your usage...` — not dismissible (Ctrl-C still quits per global handler) |
| Success | `Usage reset. You have {N} usage limit reset(s) left.` → falls back to `Usage reset.` |
| `nothing_to_reset` | `Your usage does not need a reset right now.` |
| `no_credit` | `No usage limit resets are available.` (+ dialog state zero + `invalidateUsageCache()`) |
| Consume error | `Couldn't reset usage. Please try again.` + `Try again` (same UUID) / `Close` |

`onDone` transcript text on success: `Redeemed usage limit reset on <alias/email> ({N} left)`; cancel exits silently. Every error path logs status/body-snippet/account prefix via `logForDebugging`.

## 10. Test plan (`bun test`)

- **`codexUsage.test.ts`**
  - `parseUsageResponse`: extracts `available_count`; absent/null/malformed → `undefined`; existing fields regression.
  - `consumeUsageLimitReset` (mocked `globalThis.fetch`): asserts exact URL/method/body incl. `redeem_request_id` passthrough; asserts headers **including the absence of `originator`**; each of the four codes maps to its outcome; unknown code on 2xx → `invalid_response`; `windows_reset` missing → 0, null/string → `invalid_response`; non-2xx → `http_error` with status; network throw → `network_error`; timeout abort path (and keep timeout coverage on the availability-read path).
- **`codexAccountPool.test.ts`**
  - `applyRedeemedUsageReset`: heals a `capped/usage_cap` account **even when `cappedAt` is seconds old** (the grace must not block it); clears hint fields so `getCodexAccountAvailability` → available; leaves `dead`/`quarantined` untouched; sets `redeemedAt`.
  - Lag guard: within the grace, a hint with `limitReached: true` is skipped; after the grace, the same hint applies; existing uncap-branch tests still pass.
  - **Integration-style:** cap an account (fresh `cappedAt`) → `applyRedeemedUsageReset` → apply a stale capped usage hint within the grace → account remains available for routing/picker; after grace, hints govern again.
  - Redemption eligibility predicate: healthy and `capped/usage_cap` eligible; `dead`/`quarantined`/known-zero disabled with reasons.
- **Target-selection**: mixed pool with one *inactive* `capped/usage_cap` account and one *active* healthy account → default target is the capped account.
- **Token pre-flight**: vault account routes through `refreshAccountTokens`; config account (no `vaultFilePath`) routes through the raw-under-lock path; refresh failure → account degraded, flow continues for others; near-expiry boundary at the chosen threshold.
- **`fastMode.test.ts`** (existing `meetsAvailabilityRequirement` assertions): `['claude-ai','openai']` visible when `provider === 'openai'`.
- **Dialog state machine** — extract into a plain module (not optional; this is a credit-spending UI): known-zero option disabled / unknown enabled; default selection is `Cancel`; consuming state non-dismissible; per-code result mapping (`nothing_to_reset`, `no_credit`, success); `Try again` preserves the UUID, re-entering confirm regenerates it; post-success refresh failure falls back to `Usage reset.`.
- **Manual**: `bun run build:dev:full`; walk the dialog with fetch mocked at the seam; verify plain `/usage` renders Codex usage for a single-account setup. A live end-to-end run **consumes a real credit** — do it once, deliberately, when an account is genuinely capped, as the final acceptance step.

## 11. Files to change

| File | Change |
|---|---|
| `src/services/api/codexUsage.ts` | `resetCreditsAvailable` parse + `consumeUsageLimitReset` + URL const |
| `src/services/api/codexUsage.test.ts` | §10 |
| `src/services/api/codexAccountPool.ts` | `redeemedAt` field, `applyRedeemedUsageReset`, lag guard in `updateAccountUsageHints`, redemption-eligibility predicate |
| `src/services/api/codexAccountPool.test.ts` | §10 |
| `src/codex-core/accounts.ts` | reuse point for dual-path refresh (adapter or replicated branch — §7 type note; may end up read-only) |
| `src/commands/usage/index.ts` | availability + `argumentHint` |
| `src/commands/usage/usage.tsx` | args dispatch to the redeem dialog |
| `src/commands/usage/RedeemReset.tsx` (new) | dialog flow; state machine extracted to a plain module for tests |
| `src/components/Settings/Usage.tsx` | Codex section condition `isPoolActive()` → `hasAnyPoolAccount()` (Slice 3); Slice 4 adds "N resets" + pointer copy |
| `src/utils/fastMode.test.ts` | availability assertion |
| `docs/maps/` | touch the command/API map entries if the relevant map lists `/usage` (check during implementation per repo rule) |

Implementation must end with a stale-reference sweep (imports, messages, docs, stubs) per repo convention — including confirming the `/reset-limits` stub situation stays coherent: the stub is *live-imported* by `src/commands.ts:153/250` and referenced in ant-only copy at `src/services/rateLimitMessages.ts:340`; it is unrelated Anthropic-internal legacy, stays disabled, and must not be removed casually.

## 12. Implementation slices

1. **API layer** — codexUsage parse + consume + tests. No behavior change for existing flows; ship independently.
2. **Pool heal + eligibility** — `applyRedeemedUsageReset`, `redeemedAt` guard, eligibility predicate + tests. Independent (nothing calls them yet).
3. **Command + dialog + Settings render fix** — availability, args dispatch, `RedeemReset.tsx` with extracted state machine, token pre-flight wiring, `Usage.tsx` `hasAnyPoolAccount()` condition, availability test, manual walk.
4. *(Optional)* **Settings surfacing** — show reset counts in the Usage tab + "run /usage reset" pointer.

## 13. Open questions and risks

- **wham lag magnitude is unknown**; both graces (existing and new) assume ~2 min. If real lag is longer, a post-redeem poll after the grace can still re-block hints for up to 5 min. Tunable constant; not worth more machinery until observed.
- **UA divergence on consume**: we send no `originator` (upstream-aligned) but keep the default fetch UA instead of upstream's versioned Codex UA. If the POST is rejected on fingerprint grounds, mirror upstream's UA exactly.
- **`CodexCoreAccount` ↔ `PoolAccount` adapter** (§7): if reuse is awkward, replicate the two-branch refresh; decide in Slice 3 review.
- **`nothing_to_reset` server threshold** (how capped is "capped enough") is server-side and unknown; the neutral copy handles it.
- **Console-key sessions with codex pools** can't see `/usage` (availability excludes `'console'`). Accepted for now (§4); separate product decision.
- **No-accounts pointer copy**: no `src/commands` flow appends codex accounts today (only `/logout` touches codex OAuth) — confirm the actual onboarding affordance during Slice 3.
- **Double-spend residual** (§6): crash between send and response, then a fresh-UUID retry. Server-side `nothing_to_reset` likely absorbs it; accepted.
- **Free-plan accounts**: whether `rate_limit_reset_credits` appears for them is unknown; `undefined` renders as "reset availability unknown" and stays enabled, matching upstream's unknown-count behavior.
- **Auto-redemption by pool routing** (redeem when all accounts cap) is explicitly rejected: it spends a limited resource without user intent. Revisit only on explicit request.

## 14. Pressure-test adjudication (rev 2)

External adversarial review returned 15 findings (verdict: needs rework). Disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | Active-account default targets the wrong (healthy) account in mixed pools | **Accepted** — default is now the capped/usage_cap account (§7.3) |
| 2 | `refreshAccountTokens` is vault-only; config accounts had no refresh path | **Accepted** — dual-path refresh per `codex-core/accounts.ts` (§7.1, §7 type note) |
| 3 | Expired tokens break the availability read before pre-flight ran | **Accepted** — pre-flight moved ahead of the availability read (§7.1) |
| 4 | Consume headers diverged from upstream | **Accepted, modified** — `originator` dropped; default UA kept as documented divergence with fallback (§5.2) |
| 5 | Plain `/usage` empty for single Codex accounts (`isPoolActive()` needs >1) | **Accepted** — `hasAnyPoolAccount()` render fix pulled into required Slice 3 (§4) |
| 6 | Console+pool exclusion contradicts the runtime-gating claim | **Wording only** — claim rescoped to visible sessions; availability unchanged; adding `'console'` would surface a Claude-centric page to all API-key users (§4) |
| 7 | `hasAnyPoolAccount()` conflates exists with redeemable | **Accepted** — entry gate stays existence; picker-level eligibility predicate added (§4, §7.3) |
| 8 | `no_credit` cache update unspecified | **Accepted** — `invalidateUsageCache()` + dialog zero (§8) |
| 9 | Heal→stale-hint integration test missing | **Accepted** (§10) |
| 10 | 60 s pre-flight threshold falsely called upstream-equivalent | **Accepted** — reuse repo/upstream threshold, verify constant at implementation (§7.4) |
| 11 | Timeout parity overstated | **Accepted** — described as simplified single-layer choice; read-path timeout test added (§5.2, §10) |
| 12 | `windows_reset: number \| null` too permissive | **Accepted** — integer, missing→0, malformed→`invalid_response`; safe because Try-again is idempotent (§5.2) |
| 13 | Endpoint hardcoding framed as upstream contract | **Accepted** — explicit Cat-Code-scope statement, no URL builder (§5.2) |
| 14 | Dialog test plan too thin for a credit-spending UI | **Accepted** — state machine extraction now required; states enumerated (§10) |
| 15 | `/reset-limits` stub references unaccounted | **Accepted** — documented as live-imported ant-only legacy; stale-reference sweep item added (§11) |

## 15. Rev 3 — Settings Reset tab (2026-07-04)

1. User rejected the `/usage reset` typed entry; placement is now a dedicated Settings tab. This re-adjudicates §3: option A was rejected for lacking a selection model *inside the Usage tab* — a dedicated tab is a page with its own selection model, so the old objection does not apply. `/usage reset` dispatch is removed.
2. Exposure expands: Settings also opens via `/config` and `/status`, so console API-key sessions holding a Codex pool can now reach redemption. This deliberately reverses the §4/§13 accepted edge because those pools cap too.
3. Transcript: the §9 `onDone` line is now emitted through Settings' close (`onClose(result)`), accumulated across redemptions in one Settings session.
4. Accepted cost: selecting the Reset tab fires token pre-flight plus a forced usage read.
5. Discoverability: with zero Codex accounts the tab is hidden and nothing points at redemption. The old no-accounts message is gone; accepted.
6. Slice 4 is realized: Usage cards show per-account reset counts.
