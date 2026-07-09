# Codex Account System — Implementation Plan

Date: 2026-07-06
Status: NOT started. Companion to
[`2026-07-06-account-system-design-review.md`](2026-07-06-account-system-design-review.md)
(the canonical review — findings F1–F12, file:line refs, target model,
pressure-test record). This plan sequences the work and fixes the decisions;
the review holds the evidence. When plan and review disagree on detail, verify
against source (repo rule: source wins over docs).

Audience: the implementing session. The plan states goals, constraints, and
acceptance criteria; the *how* is yours to derive from source.

## Mission

Make "usable Codex account" mean "a request will actually succeed," by fixing
the root cause (the `isPoolActive()` count>1 conflation), and collapsing
duplicated dangerous machinery — 3 refresh stacks, 2 token authorities,
4 label vocabularies — without redesigning the sound skeleton
(vault → pool → lease → retry) and without changing quota-reconciliation
semantics.

## Migration branch interaction

Checked 2026-07-06 against `docs/migration/STATUS.md`,
`docs/migration/decisions/`, and `app/` source. Findings:

- **Shared runtime surface, no shared blocking dependency.** No file under
  `app/` imports `codexAccountPool.ts` / `client.ts` / `withRetry.ts` /
  `codex-fetch-adapter.ts` / `codexAccountLeaseManager.ts` by name, but the
  Electron sidecar (`app/sidecar/sessionController.ts`,
  `resumeSeedProbe.fixture.ts`) constructs the **real**
  `QueryEngine`/`createQueryEngineSessionController` — the same engine the
  CLI/TUI uses, which transitively calls `query.ts` → `services/api/claude.ts`
  → `client.ts` → the whole account plane. Every slice below therefore
  changes behavior for both the TUI and the in-progress Electron app
  simultaneously (this is good — one engine, no divergent behavior — but it
  changes what "done" requires; see verification below). Nothing in the
  migration's open backlog (P3-6, P3-7, Phase-4 D2 rows) depends on this
  plan, and this plan does not block that work — the two tracks are
  parallel-safe.
- **F4 correction (folded into the review doc):** the "raw-with-ledger"
  refresh stack is not accidental duplication — it is migration commit
  `641f8eb`'s deliberate, pressure-tested fix (DR-2) for a cross-process
  refresh race the N-process architecture decision exposed, proven by
  `src/codex-core/accountRefreshContention.probe.test.ts`. Slice 3 must
  extract shared logic, not collapse the two safe stacks into one, and must
  keep that probe green.
- **F1 corroboration:** the migration's own DR-2 note already flags
  `GenerateImageTool.ts:496` as an explicitly unfixed same-class defect.
  Independent confirmation, not new risk.
- **Security-boundary constraint (P0-5):** `auth.ts` and
  `codex-core/accounts.ts` are the two files the migration's threat model
  names as the secret boundary ("secret owner = engine only; renderer sees
  redacted status"). No slice here moves token/refresh logic across that
  boundary or touches the IPC/renderer surface — keep it that way.
- **Regression surface to add to every slice touching `codex-core/` or the
  client/adapter/retry layer:** run `bun test app/` and typecheck both
  `app/tsconfig.json` and `app/sidecar/tsconfig.json` in addition to the root
  suite. Reuse `accountRefreshContention.probe.test.ts` /
  `.probe.child.ts` as the direct template for any new cross-process
  regression test (closer precedent than the settings-write probe, since
  it's the same file/stack); extend it rather than writing a new probe from
  scratch if slice 2's expiry-refresh hook adds a genuinely new contention
  path.
- Minor/low: `app/renderer/src/sdkMessageFixtures.ts` cites
  `codex-fetch-adapter.ts` line-number anchors for fixture provenance. This
  plan doesn't change response/error shapes, only token-resolution control
  flow, so anchors should survive — but if line numbers near those anchors
  shift, a later migration anchor-verification pass may flag false drift.

## Ground rules

- Work slice by slice; each slice independently landable and verified before
  moving on. Report results per slice; ask the user before committing.
- Build with `bun run build:dev:full`. Also run `bun x tsc --noEmit` — the
  repo currently has no typecheck step and one live type error (slice 0
  fixes it).
- For slices 2–4 (anything touching `codex-core/`, `client.ts`,
  `withRetry.ts`, or the adapter): also run `bun test app/`,
  `bunx tsc --noEmit -p app/tsconfig.json`, and
  `-p app/sidecar/tsconfig.json`. See "Migration branch interaction" above —
  the Electron sidecar runs the same engine and account plane.
- Existing focused tests per file: see `docs/maps/codex-core.md` §Tests.
  Follow the repo's `*.probe.test.ts` pattern for cross-process/runtime
  probes — `accountRefreshContention.probe.test.ts` is the closest existing
  template.
- Don't touch: transport/cache continuation logic
  (`codex-websocket-transport` internals), lease manager algorithms, request
  translation. Review §2 (sound) and §9 (checked clean) list what to leave
  alone.
- No speculative features, no new abstractions beyond what is named here.

## Verification spine

Before slice 1, build a sandboxed-vault runtime reproduction of F1 (image
path burns the vault's rotate-once token) and F2 (single-account session
serves a stale config token) as probe tests. They are the regression fixtures
for slices 1–2 and the proof the two headline bugs are actually fixed, not
just plausibly fixed.

After each slice: focused tests + `tsc` + build. After slice 2 additionally
run the full pool/lease/refresh/adapter test set listed in the codex-core
map. At the end: update `docs/maps/codex-core.md` and
`docs/maps/auth-accounts-oauth.md` — several routing entries (predicates,
refresh paths) will be stale after this work.

## Slice 0 — Mechanical fixes (no design questions; land first)

- Fix TS2741 in `codexUsage.ts` (`statusOrder` missing `quarantined`) and add
  a typecheck step to the build/test flow so this class cannot ship again.
- Map `quarantined` in every display fallback (`/accounts` command,
  AccountsPanel).
- Fix the usage-hint writer drift in `switch-account.ts`
  (`liveUsageIsBlocked` must follow `codexUsage`'s primary-window `resetAt`
  rule and pass `fetchedAt`).
- Delete F11 vestiges: unreachable second openai block in `client.ts`,
  `rotateOnFailure`, one of the twin predicates
  (`isCodexAccountSwitchable` / `isCodexAccountLeaseSelectable`), unused
  `formatTokenAge`, logout.tsx's stale embedded sourcemap.
- Make `getAccountInformation` pool-aware for OpenAI.

## Slice 1 — F1: stop GenerateImageTool killing accounts (urgent, standalone)

Route `getImageAuth`'s refresh through `maybeRefreshAccount`
(codex-core/accounts.ts) instead of raw `refreshCodexToken` + config-only
save. The safe dual-path machinery (vault state machine / raw-with-ledger)
already exists — this is a re-route, not new code.

Acceptance: an expired sole vault account refreshed via the image path leaves
the vault holding the live rotation. Independent regression test following
the `accountRefreshContention.probe.test.ts` two-real-process pattern
(this is the fix's closest in-repo precedent — same file/stack, not the
settings-write probe).

Decide-or-defer explicitly: reporting image-endpoint 429/401 into pool state
(F9) — deferring is fine, but say so in the slice report.

## Slice 2 — The core: predicate split + single token authority

- Split `isPoolActive()` into:
  - `poolManagesCredentials` (≥ 1 account): gates token resolution, error
    classification in the adapter, refresh recovery in withRetry;
  - `canFailover` (≥ 2 selectable): gates rotation.
- Make `resolveCodexOAuthTokensForLeaseOwner` the only source of request
  tokens: the sole-account branch returns **pool** tokens (never raw config);
  add an expiry-refresh hook via `maybeRefreshAccount` (the resolver goes
  async — enumerate and check all callers); and make the **adapter's
  per-request re-derivation call the same resolver** (F3) instead of its own
  ALS-lease→pool lookup.

Constraints (from the pressure-test, review §7): preserve
dead/capped/quarantined blocking; config-only accounts keep working via
`loadConfigAccount()`; expiry refresh complements, not replaces, post-401
forced refresh. **Additional constraint (migration N-process):** the
expiry-refresh hook must call `maybeRefreshAccount` — never a fresh ad hoc
refresh — so it inherits the DR-2 cross-process lock/ledger. If this hook
introduces a genuinely new contention path (e.g. two engine processes both
discovering near-expiry via the resolver at the same moment, a scenario the
existing probe may not cover), extend
`accountRefreshContention.probe.test.ts` to cover it rather than treating
the existing probe's pass as sufficient by assumption — reopening P0-4's
"N-process sufficiency assumed, not proven" caveat for this file is the one
outcome to actively avoid here.

Acceptance: single-account 401 and 429 classify and recover/cap like pooled
ones; a sole vault account with no config entry routes successfully;
multi-account behavior equivalent where possible (existing pool/lease/retry
tests stay green); `accountRefreshContention.probe.test.ts` stays green (or
is extended and still green).

## Slice 3 — One refresh entry point + config mirror decision

All refresh callers go through `maybeRefreshAccount`. **Not** a collapse of
the two safe stacks into one — the vault state machine and the raw-with-
ledger path (DR-2, migration commit `641f8eb`) both stay, dispatched as
today; `maybeRefreshAccount` already does this correctly. The consolidation
here is: extract the shared identity-mismatch-reconciliation logic
(codexTokenRefresh.ts:554-630 and codex-core/accounts.ts:312-364) into one
function both paths call, and deduplicate the OAuth constants. Keep
`accountRefreshContention.probe.test.ts` green throughout — treat any red
result as a stop-and-report, not a probe to fix. Apply decided defaults 1
and 3 below (touchAll gating, config mirror demotion).

## Slice 4 — Quota-belief reconciler (F5) — test-first, semantics-preserving

Write the directional test cases *before* touching code:

- 429 then stale uncap-poll (must stay capped);
- redeem then stale block-poll (must stay healed);
- post-failover forceRefresh poll;
- missing/zero `resetAt`;
- poll-block TTL (`USAGE_HINT_STALE_MS` behavior).

Then replace the four grace windows with one reconciler: per-source authority
+ propagation lag — an observation may override a belief only if it is newer
AND (higher authority OR the belief has outlived its source's lag) — plus a
TTL on poll-sourced blocks and `resetAt` carried on 429 beliefs.

If any current behavior cannot be reproduced by the model, **stop and
report** rather than changing semantics.

## Slice 5 — One vocabulary (F6) (any time after slice 0)

One shared `describeCodexAccountAvailability()` formatter consumed by
`/accounts`, AccountsPanel, the Usage tab, and switch-account. User-facing
words: Ready / Limit reached (resets in X) / Needs re-login / Connection
issue (retrying). Lease-first "active account" everywhere (AccountsPanel's
dot currently uses `activeIndex`; StatusLine is already lease-first).

## Decided defaults for the review's §5 policy items

Apply unless the user overrides:

1. **`touchAll`**: gate per-account on `expires_at` proximity (reuse
   `isWithinRefreshSkew`) and skip the startup fire-and-forget in
   short-lived/print runs — slice 3.
2. **Cross-process cap state**: keep per-process discovery; document it as
   intended in `docs/maps/codex-core.md`. No persistence now.
3. **Config `codexOAuth` mirror**: after slice 2, demote to write-only legacy
   (login still writes it; nothing reads it when a pool account exists).
4. **UI panels updating routing hints**: keep, but state it in a comment at
   both call sites (AccountsPanel, Usage tab) as deliberate.

## Risk notes for the implementer

- Slices 0, 1, and 5 are low-judgment and safe to land quickly.
- Slice 2 is where the judgment lives: the async-resolver ripple (every
  `resolveCodexOAuthTokensForLeaseOwner` and `getAnthropicClient` call site
  must be enumerated — the review did not do this) and the adapter
  unification. Review it hardest.
- Slice 4 has an explicit stop-and-report guard; the four grace windows
  encode directional semantics that a naive precedence model breaks (review
  §F5 / §7).
