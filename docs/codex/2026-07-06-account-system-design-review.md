# Codex Account System — Design Review

Date: 2026-07-06
Branch reviewed: `migration` (clean tree as of review end)
Status: review complete; implementation NOT started.

## Scope and method

Full design evaluation of the Codex account lifecycle after login: account
identity, credential/token lifecycle, account selection, health/usability,
usage reporting, limit handling, failover, subagent account handling, and UI
representation. Login UX and vault-backed storage were accepted as product
decisions and not re-litigated.

Method: full source read of the account plane (`codexAccountPool`,
`codexTokenRefresh`, `codexAccountLeaseManager`, `client.ts`, `withRetry`,
`codexUsage`, `codex-core/accounts.ts`, lifecycle commands, UI surfaces,
`accountDiagnostics`), two targeted sweeps of initially-unread areas, and an
adversarial pressure-test by a second session whose corrections were verified
against source and folded in (see §7). All file:line references were checked
against the tree on 2026-07-06.

Related prior work: `docs/codex/2026-04-30-subagent-account-leasing-design.md`,
`docs/codex/2026-05-12-bug-codex-pool-false-cap-on-claude-oauth-failure.md`,
the 2026-06-16 account-state critique and the 2026-07-05 vault-poisoning
postmortem (memory: `project_codex_account_design_review_2026_07_06`).

## 1. Verdict

**Sound skeleton, one wrong predicate, and duplication of the dangerous
parts.** The layering — vault files (durable, cross-process) → in-memory pool
(inventory + health) → lease manager (per-owner pinning) → retry/failover — is
the right architecture. The vault refresh state machine is good engineering
for rotate-once tokens. Subagent handling follows the main-thread model with
no special cases.

What needs fixing is narrower but real:

- one predicate (`isPoolActive()`, count > 1) silently disables the entire
  account machine for single-account users;
- the most dangerous operation (spending a rotate-once refresh token) has
  **three** implementations at three safety levels;
- request-time token resolution has **two** authorities with different
  semantics;
- user-facing account state has **four+** hand-rolled vocabularies;
- quota state is reconciled by four scattered grace windows encoding real but
  undocumented directional semantics.

This warrants a **focused refactor** (§8), not a redesign, plus one urgent
standalone bug fix (F1).

## 2. What is sound (keep it)

- **One availability reducer exists and is used everywhere that matters.**
  `getCodexAccountAvailability()` (codexAccountPool.ts:1338) folds status +
  fresh usage hints + plan metadata into `available | warned | blocked`.
  Routing, lease selection, and switching all consult it.
- **Leases are the right concept.** Per-owner pinning, `spread`/`follow-main`
  strategies, owner-local failover with global cap-marking. Subagents
  (AgentTool → lease per agent id, released on task cleanup; verified in
  `query.ts`, `AgentTool.tsx`, `LocalAgentTask.tsx`) use exactly the
  main-thread machinery. Exhaustion surfaces as
  `Agent <label> failed: All Codex accounts are capped or unavailable` — same
  vocabulary as main.
- **Failure taxonomy at the retry layer.** `CodexAccountCapError` (the only
  path that caps), `CodexAccountAuthError` (refresh-then-dead), connection
  errors (quarantine/failover without capping), network-outage detection when
  two distinct accounts fail. Diagnostic codes distinguish `auth.missing` /
  `account.pool.unavailable` / `quota.exhausted`.
- **The vault refresh state machine** (`codexTokenRefresh.ts`): persists
  intent before network I/O, distinguishes definitely-not-sent from ambiguous
  transport outcomes, recovers rotated-away tokens (postmortem fixes (a), (b)
  landed), quarantine + probe with backoff.
- **Lifecycle commands.** `/switch-account` (pre-commit live-usage check,
  unified refusal copy, lease reassignment, cache resets) and
  `/delete-account` (impact preview, lease repair by rank, release when
  unrepairable) are well designed. `redeemResetMachine.ts` is a clean
  React-free machine. `accountDiagnostics.ts` redaction is thorough.
- **Plan metadata is correctly advisory** — warn, never block; live usage
  decides.

## 3. Root cause: the `isPoolActive()` predicate conflation

`isPoolActive()` (codexAccountPool.ts:224) requires `accounts.length > 1` and
is used to gate two different questions:

1. **"Can we fail over?"** — legitimately needs ≥ 2 selectable accounts.
2. **"Does the pool manage credentials?"** — should be ≥ 1 account.

Because both are gated on count > 1, **single-account mode bypasses the entire
account machine**:

- `resolveCodexOAuthTokensForLeaseOwner` (client.ts:231) uses the sole pool
  account only as a selectability gate, then returns raw config tokens from
  `getCodexOAuthTokens()` (auth.ts:1362) — which nothing on the app path
  refreshes (§F2).
- `classifyCodexHttpAccountError` runs only inside `if (isPoolActive())`
  (codex-fetch-adapter.ts:2949). A sole-account **401** never becomes
  `CodexAccountAuthError` (no refresh recovery) and a sole-account **429**
  never becomes `CodexAccountCapError` (no cap state, no cap message) — both
  degrade to generic `APIConnectionError` retries of the same doomed token.

The fix shape is a predicate split (§8, slice 2): `poolManagesCredentials`
(≥ 1 account) gates token resolution, classification, and refresh recovery;
`canFailover` (≥ 2 selectable) gates rotation.

## 4. Findings by severity

### F1 — URGENT: GenerateImageTool can permanently kill an account's credential chain

`getImageAuth` (GenerateImageTool.ts:480-520): when `!isPoolActive()` and the
config token is near expiry, it calls raw `refreshCodexToken()`
(codex-client.ts:278 — bare fetch, no vault lock, no vault write, no state
machine) and saves the rotated tokens **only to config**
(`saveCodexOAuthTokens`). Since `/login` writes both config and vault
(ConsoleOAuthFlow.persistCodexLogin), the sole account is vault-backed, so:

1. the vault's rotate-once refresh token is consumed;
2. the successor lands only in config;
3. next `touchAll()` refreshes from the vault file → `invalid_grant`;
4. the rotated-token recovery (codexTokenRefresh.ts:467-482) reads only the
   vault file, finds the same dead token, no recovery;
5. `reauth_required` → `markAccountDead` — **permanently**, while a working
   refresh token sits in config where `mergePoolAccounts` lets the dead vault
   record shadow it forever.

This is the exact 2026-07-05 rotation-loss mechanism, still reachable. Ordering
caveat (pressure-test): the poisoning window is before `touchAll` rotates
first; after that the image refresh merely fails. Dormant on multi-account
setups (`isPoolActive()` true) — dormant, not safe.

**Fix:** route through `maybeRefreshAccount` (codex-core/accounts.ts:241),
which already dispatches vault-vs-raw correctly with full crash safety (§F4).
One import away.

### F2 — Single-account mode is broken (stale tokens + no classification)

Mechanism in §3. Consequences, all verified:

- After the vault machine rotates (startup `touchAll`, 4h timer), a
  single-account session serves a **permanently stale config access token**;
  the 401-recovery loop cannot fix it (401 isn't even classified as auth, and
  the client always rebuilds from config). Requests retry to exhaustion.
- A sole *vault* account with no config entry returns `null` from the resolver
  → "No healthy Codex account is available" — while `hasCodexTokens()`
  (auth.ts:1678) reports logged-in and the model picker shows GPT models.
  **This is the literal "logged in / metadata visible / cannot send" symptom.**
- A sole-account 429 produces no cap state and a misleading generic error.
- Pressure-test correction (accepted): the earlier claim that this loop burns
  one vault rotation per retry was WRONG — the auth branch never runs here, so
  no rotations are spent; the failure is pure stale-token retry.

The Claude pool proves the missing discipline in-repo: its legacy mirror
(keychain/config) is synced on every refresh via
`updateActiveClaudeAccountTokens` (claudeAccountPool.ts:~460, called from the
auth.ts refresh path). The Codex config mirror is written only at login and
delete.

### F3 — Dual token authority per request

`client.ts:getAnthropicClient` resolves tokens via
`resolveCodexOAuthTokensForLeaseOwner` (explicit owner params, selectability
check, lease **repair**) and bakes the token into `createCodexFetch`. The
adapter then **re-derives** token + account per request
(codex-fetch-adapter.ts:2805-2812) from the AsyncLocalStorage lease context →
pool account, with **no selectability check, no repair**, and a fallback to
the baked creation-time token when no ALS context exists. Two resolution
functions with different semantics; the adapter's answer wins on the wire.
Any resolver unification that does not include the adapter changes nothing at
request time.

### F4 — Three refresh stacks; the safe raw one is unused where it's needed

1. **Vault state machine** — `codexTokenRefresh.ts:refreshAccountTokens`.
2. **Raw-with-ledger** — `codex-core/accounts.ts:refreshRawUnderCrossProcessLock`
   (accounts.ts:432): cross-process lockfile, durable attempt ledger
   (`codex-raw-refresh.state.json`; intent persisted before network I/O,
   probe-once on crash, identity tombstones), foreign-rotation adoption,
   persist-verification. Full DR-2 guarantees for config-source accounts.
3. **Naked** — `refreshCodexToken` called directly by GenerateImageTool (F1).

**Correction (found while cross-checking the `migration` branch, 2026-07-06):**
stack 2 is not accidental sprawl — it is a deliberate, reviewed migration
deliverable. Commit `641f8eb` ("migration(pre-P3): D1/D6/F3 decisions + DR-2
cross-process refresh fix, pressure-tested") built it specifically to close a
cross-process race that the migration's N-process decision (one engine
process per session, `docs/migration/decisions/TRANSPORT.md` §P0-4) exposed:
multiple engine processes can share one Codex account and race its
rotate-once refresh token. It has its own regression probe —
`src/codex-core/accountRefreshContention.probe.test.ts` +
`.probe.child.ts` — proven 4 scenarios × 3 runs clean, and its landing
explicitly "retires P0-4's 'sufficiency assumed, not proven' caveat for this
file" (`docs/migration/STATUS.md`, DR-2 note). **Do not simplify this into
one code path by discarding the ledger** — the ledger is load-bearing for
cross-process safety in exactly the N-process world the migration exists to
build. The consolidation target for slice 3 is narrower: extract the shared
identity-mismatch-reconciliation logic into one function both refresh paths
call (not "make one call the other" — `codex-core` cannot be inverted to be
called by `services/api`, that would invert the layering), and keep
`accountRefreshContention.probe.test.ts` green through the refactor as a hard
gate. Also independently notable: the same DR-2 note flags
`GenerateImageTool.ts:496 raw refresh` — i.e. F1 — as a known, explicitly
unfixed same-class defect ("Same-class NOT solved (flagged only)"). Two
independent investigations converged on F1; treat that as corroboration, not
new information.

`maybeRefreshAccount` (accounts.ts:241) already dispatches 1-vs-2 correctly
and gates on `expires_at` proximity (`TOKEN_REFRESH_SKEW_MS`). Additional
costs of the triplication:

- near-duplicate ~50-line identity-mismatch reconciliation blocks
  (codexTokenRefresh.ts:554-630 vs accounts.ts:312-364) kept in sync by hand;
- duplicated OAuth constants (`TOKEN_REFRESH_URL`/`TOKEN_REFRESH_CLIENT_ID`
  vs `constants/codex-oauth.ts` — identical values today, different request
  encodings; divergence hazard);
- the ledger is a **fourth persisted credential-state store** (vault
  `refresh`, config, ledger, in-memory pool).

**Target:** `maybeRefreshAccount` becomes the single refresh entry point.

### F5 — Quota state: two truth sources reconciled by four grace windows

Hard 429s (authoritative, instant) and wham/usage polls (lag by minutes) both
write quota state, reconciled by `cappedAt`, `usageFetchedAt`, `usageResetAt`,
`redeemedAt` under `USAGE_UNCAP_GRACE_MS`, `REDEEM_HINT_LAG_GRACE_MS`,
`USAGE_HINT_STALE_MS` (codexAccountPool.ts:1265-1274) plus the
elapsed-`resetAt` escape inside the availability check.

Pressure-test insight (accepted): the windows encode a **directional
asymmetry** — ignore *unblocking* polls briefly after a 429, ignore *blocking*
polls briefly after a redeem — and a naive precedence `429 > redeem > poll`
would break `applyRedeemedUsageReset` (codexAccountPool.ts:1491) healing
outright. The consolidation must be **semantics-preserving**: one reconciler
where each source carries an authority level *and* a propagation lag —
"an observation may override a belief only if it is newer AND (higher
authority OR the belief has outlived its source's lag)" — plus a TTL on
poll-sourced blocks and `resetAt` carried on 429 beliefs. Write the
directional test cases first.

### F6 — Labels: four vocabularies, unmapped states, and a live type error

- Four independent `status → words` mappings: `/accounts`
  (accounts.ts:53-61: `[capped]`/`[needs re-login]`/`[dead]`; quarantined
  falls to `[dead]`), AccountsPanel (AccountsPanel.tsx:228-234:
  `capped`/`unavailable`/`—`; quarantined falls to `—`), Settings Usage tab
  (own mapping), switch-account (`humanizeCodexBlockReason`, the best one).
- **Live TS2741**: `sortPoolUsageDisplayAccounts`'s `statusOrder`
  (codexUsage.ts:383) lacks `quarantined`; `bun x tsc --noEmit` confirms. The
  repo has **no typecheck step**, so it shipped; quarantined accounts compare
  as NaN in the sort.
- Two answers to "which account am I on": StatusLine.tsx:134-146 and
  taskStatusUtils are lease-first (correct); AccountsPanel's ● dot is
  `activeIndex`-based. They can disagree.
- `getAccountInformation` (auth.ts:1995-2007) reads only the config
  `codexOAuth` entry — the login-status surface can name a different account
  than the pool routes to.

**Fix:** one shared `describeCodexAccountAvailability()` formatter derived
from the availability reducer; lease-first active display everywhere; add a
typecheck step to CI/build.

### F7 — Usage-hint writer drift

`codexUsage.updateRoutingHintsFromUsage` (codexUsage.ts:317-335) deliberately
uses `primaryWindow.resetAt` (comment: `max()` across windows would keep a
reset 5h account blocked for days). `switch-account`'s `liveUsageIsBlocked`
(switch-account.ts:406-422) builds the same hint with
`resetAt: Math.max(primary, secondary)` and omits `fetchedAt`. Two writers of
one store with contradictory field semantics; concrete effect: a switch-target
can stay hint-blocked past its 5h reset (until the hint goes stale).

### F8 — WebSocket in-band failures: cap detection but no auth detection

Upgrade-time auth rejection is fine: generic connect error → HTTP fallback
(codex-fetch-adapter.ts:1862-1902) → HTTP 401 → classified (when pool
active). But an in-band `response.failed` event goes through
`createCodexResponseFailedError`, which only checks
`codexResponseFailureIndicatesAccountCap` — no auth analogue, so an in-band
auth failure becomes a generic `CodexResponseFailedError` and never reaches
refresh/failover.

Related fragility: HTTP 401/403 credential classification is body-text
matching (codex-fetch-adapter.ts:319-337); a 401 body without the known
substrings takes the connection-error path instead of the credential path.
The `expiresAt` field tracked on every account is never consulted on the
pooled hot path (self-healing there via 401-recovery, but costs a doomed
request per cold account and depends on the text match).

### F9 — Image traffic is invisible to the account state machine

GenerateImageTool raw-fetches the image endpoints (GenerateImageTool.ts:786,
:830) with no `withRetry`: a 429/401 neither caps, kills, fails over, nor
stamps `lastErrorAt`. Chat traffic informs account state; image traffic
consumes quota silently.

### F10 — Opening a UI panel mutates routing state (product decision needed)

AccountsPanel.tsx:326 and Usage.tsx:389 call
`fetchPoolUsage({ updateRoutingHints: true })` on render — displaying the
startup logo panel or settings can re-block/unblock accounts for the next
request. The flag makes it explicit; whether display should drive routing is a
deliberate decision to make, not an accident to keep.

### F11 — Dead code / vestiges (delete pass)

- client.ts:554-579 — second `resolvedProvider === 'openai'` block is
  unreachable (first block at :373 always returns or throws).
- `rotateOnFailure` (codexAccountPool.ts:288) — no production callers.
- `isCodexAccountSwitchable` ≡ `isCodexAccountLeaseSelectable`
  (codexAccountPool.ts:1379, :1386) — byte-identical; two names imply a
  distinction that does not exist.
- `formatTokenAge` (commands/accounts/accounts.ts:120) — unused.
- logout.tsx ends with an embedded base64 sourcemap whose embedded original
  source predates the visible multi-account/Codex logic — a compiled artifact
  hand-edited post-decompilation. Hygiene: strip the sourcemap.

### F12 — Codex-core explicit path ignores hint-blocks (document or align)

`resolveCodexCoreAccount` throws typed errors for quarantined/capped/dead but
proceeds on healthy-with-fresh-blocked-hint (availability consulted only for
reason strings). Defensible ("explicit selection, let reality decide") but
undocumented and inconsistent with pool routing.

## 5. Open policy decisions (user)

1. **`touchAll` churn** (postmortem items (c)/(d), NOT landed):
   `initAccountPool` fires `void touchAll()` on every process start
   (codexAccountPool.ts:193-198) and `touchAll` refreshes **unconditionally**
   — no `expires_at` gate (the predicate exists: `isWithinRefreshSkew`,
   accounts.ts:237). With rotate-once tokens this is the riskiest remaining
   behavior. Decide: gate on expiry proximity + skip in short-lived print
   runs.
2. **Cross-process cap state**: caps/quarantine/dead-marks are process-local;
   only refresh state is shared via the vault. Two tabs can disagree about the
   same account. Decide: persist quota observations to the vault as advisory
   (timestamped, same precedence rule as F5) or document per-process discovery
   as intended.
3. **Config `codexOAuth` mirror**: demote to write-only legacy (nothing reads
   it when any pool account exists) or keep it refresh-synced like the Claude
   pool does (F2/S2). Demotion requires the F2 resolver change first.
4. **F10**: should display surfaces update routing hints?

## 6. Target model

- **Predicate split**: `poolManagesCredentials` (≥ 1 account) gates token
  resolution, error classification, refresh recovery; `canFailover`
  (≥ 2 selectable) gates rotation. `isPoolActive()` retires.
- **Single token authority**: `resolveCodexOAuthTokensForLeaseOwner` is the
  only place a request token comes from — sole-account branch returns pool
  tokens; expiry-refresh hook (via `maybeRefreshAccount`, never raw) makes it
  async; the **adapter calls it too** (F3) instead of re-deriving.
  Constraints from the pressure-test: preserve dead/capped/quarantined
  blocking; keep config-only accounts working via `loadConfigAccount()`;
  expiry refresh does not replace post-401 forced refresh (server-side
  revocation precedes local expiry).
- **Single refresh entry point**: `maybeRefreshAccount` dispatches vault-vs-
  raw; GenerateImageTool and any future caller go through it; deduplicate the
  identity-mismatch reconciliation and OAuth constants.
- **Per-axis account state** replacing the single status enum + scattered
  timestamps: credential (`ok | refresh-in-doubt | needs-login`, owned by the
  refresh machine, persisted), quota (belief record
  `{blocked, source: 429|poll|redeem, observedAt, resetAt?}` under the
  authority+lag reconciler of F5), reachability (`ok | probing`), entitlement
  (advisory). **Routable** = derived, never stored. The availability reducer
  stays the sole reader.
- **One vocabulary**: `describeCodexAccountAvailability()` formatter; UI
  words are Ready / Limit reached (resets in X) / Needs re-login /
  Connection issue (retrying); lease-first "active" everywhere.

## 7. Pressure-test record

A second session adversarially verified the review. Outcomes:

- **Refuted and corrected**: "sole-account 401-recovery burns one vault
  rotation per retry" — the auth branch is unreachable there
  (adapter classification gated on `isPoolActive()`); the real failure is
  stale-token generic retries. Folded into F2/§3.
- **Added**: `touchAll` widens the config/vault split in practice; the pool
  merge prefers the poisoned vault record over a newer config record (F1);
  the F5 grace windows are directional and naive precedence breaks redemption
  healing; six scope constraints on the resolver refactor (folded into §6).
- **Rejected**: its claim that the worktree was merge-conflicted (tree clean,
  zero conflict markers; its line refs were skewed but every cited mechanism
  verified).
- All other claims (F1 chain, F11 items, TS2741, twin predicates,
  `getAccountInformation`) independently CONFIRMED.

## 8. Implementation plan

Moved to the companion document:
[`2026-07-06-account-system-implementation-plan.md`](2026-07-06-account-system-implementation-plan.md)
— six ordered slices (0 mechanical → 1 F1 urgent → 2 predicate split +
resolver unification → 3 one refresh entry point → 4 quota-belief reconciler,
test-first → 5 vocabulary), decided defaults for the §5 policy items,
verification spine (runtime repro of F1/F2 as regression fixtures), and risk
notes per slice. That document is the single source of truth for sequencing;
this review holds the evidence.

## 9. Checked clean (do not re-review)

Reset.tsx redemption wiring (preflight → consume → heal → forced re-fetch);
login flow internals (codex-client.ts — PKCE, typed refresh errors);
`accountDiagnostics` sanitization; lease lifecycle (per-turn main-lease
register/release in query.ts; AgentTool/LocalAgentTask registration/release);
startup ordering (`pool.initialized` set before `initAccountPool`'s first
`await` — no meaningful init race); delete/switch-account design; quarantine
probe cadence (1s tick is a no-op filter when nothing quarantined); WS
upgrade-time auth failures (recovered via HTTP fallback); OAuth constants
identical across refresh stacks (encoding differs only).

Deliberately not reviewed: login UX, transport/cache internals
(`codex-websocket-transport` continuation, adapter translation — covered by
the 2026-06-05 cache review), Claude-pool internals beyond the symmetry
comparison, test files (implementation-time reading).
