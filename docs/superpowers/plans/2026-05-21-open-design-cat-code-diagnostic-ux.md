# Open Design Cat Code Diagnostic UX Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Open Design's user-facing Cat Code diagnostics actionable, accurate, and onboarding-aware, and give users forward-looking notice when provider capacity is running low — all without crossing the profile/account boundary established by [2026-05-12-open-design-cat-code-account-routing.md](./2026-05-12-open-design-cat-code-account-routing.md).

**Architecture:** Cat Code's structured diagnostic schema (`cat_code_account_diagnostic` system events + `CAT_CODE_DIAGNOSTIC` stderr fallback) already carries the data Open Design needs for reactive diagnostics. This plan adds four changes:

1. Per-code unrecoverable copy (including a first-run `auth.missing` variant and a model-picker-routed `model.provider_mismatch` variant). Open Design only.
2. A fresh pre-flight probe before run submission. Open Design only.
3. Aggregate Cat Code backend-readiness counts surfaced in the connection-test result. Adds an optional `counts` field to the public connection-diagnostic surface.
4. A new forward-looking diagnostic code, `account.usage.warning`, emitted by Cat Code when any account crosses a near-cap usage threshold. Surfaces as an inline FYI note at run start in Open Design. Carves out a narrow exception to the May 12 "recoverable routing is log-only" rule, because this code is a capacity forecast, not a routing event.

**Tech Stack:** TypeScript, pnpm/Corepack/Vitest in Open Design, React Testing Library for web tests, Open Design contracts package, Open Design daemon SSE, Cat Code SDK stream-json messages (read-only).

---

## Relationship To The May 12 Plan

The May 12 plan established the boundary (no profile picker, no account selector, no per-project binding, no `/accounts` calls) and shipped the structured diagnostic contract end-to-end. That work is locked-in and verified.

This plan is the follow-up phase. It does not re-litigate the boundary. It assumes the boundary holds and uses the existing schema to deliver three user-visible improvements that the May 12 plan deferred or did not anticipate. Specifically, the May 12 plan's Open Question — "Should recoverable diagnostics remain completely log-only?" — is answered here as **yes**, and we explicitly reject in-run failover UI and post-run account attribution.

If a change in this plan would require relaxing the May 12 boundary, treat that as a planning bug and bring it back for a separate decision.

## Hard Product Boundary (Unchanged)

All boundary rules from the May 12 plan still apply. Restated for the workers implementing this plan:

- Open Design must not add a Cat Code profile picker, account alias selector, or per-project binding.
- Open Design must not call `/accounts`, `/switch-account`, or mutate Cat Code account state.
- Open Design must not persist Cat Code profile/account settings.
- Open Design must not pass profile/account env vars or CLI args to Cat Code.
- Open Design must not expose full account identifiers, full emails, full aliases, refresh tokens, access tokens, or provider secret material.
- Recoverable Cat Code account routing is a backend detail — log it, do not surface it as normal run-stream UX.

This plan adds two narrow nuances on top of the May 12 boundary:

1. **Aggregate counts** (`{total, healthy, capped, dead, locked}`) are permitted on Open Design surfaces when framed as backend readiness, because they do not name accounts and do not invite selection. They are still sanitized aggregates per the May 12 schema. They must never be paired with picker UI, account selection language, or remediation prose that suggests Open Design users choose which account to use.

2. **Forward-looking capacity warnings** via a new `account.usage.warning` diagnostic code are permitted as a single inline FYI note at run start. This is the *only* non-unrecoverable diagnostic that surfaces in normal run UX. The carve-out is narrow on purpose: this diagnostic is a capacity forecast, not a routing event. Recoverable routing events (`account.failover.succeeded`, recovered `account.transient_failure`, `account.route.selected`) remain log-only as the May 12 plan requires. The new code is explicitly *not* classified as recoverable routing — it carries `recoverable: true` but its semantics are "capacity hint" not "I just rerouted."

Workers must enforce both nuances strictly. Counts must never appear next to picker UI; capacity warnings must never name accounts, pools, aliases, or describe failover.

## Current State

Open Design currently:

- Renders one sentence per unrecoverable diagnostic, mapped in `apps/daemon/src/claude-diagnostics.ts:catCodeDiagnosticMessage()`. `quota.exhausted` and `account.pool.unavailable` produce identical copy. `model.provider_mismatch` directs users to `/accounts` even though it is a model-selection failure, not an auth failure. `auth.missing` does not distinguish "never logged in" from "lost auth mid-session".
- Sends recoverable diagnostics to `console.warn` from `apps/daemon/src/server.ts` and never surfaces them. This stays.
- Runs an agent connection test in `apps/daemon/src/connectionTest.ts` that returns `publicCatCodeDiagnostic()` — a sanitized envelope with `version`, `code`, `severity`, `provider`, `recoverable` only. Aggregate counts on the underlying diagnostic are discarded before the contract boundary.
- Submits chat runs in `apps/daemon/src/server.ts` without any pre-flight check against Cat Code. The user discovers `auth.missing` only after the run starts.
- Settings → Local CLI tab in `apps/web/src/components/SettingsDialog.tsx` shows a `CAT_CODE_BIN` path field and the standard connection-test result. No backend-readiness summary.

Cat Code currently:

- Emits the full diagnostic schema (May 12 plan, Track A) including optional `counts` field via `src/services/api/accountDiagnostics.ts`.
- Sanitizes diagnostics through `buildAccountDiagnosticBody()` before stdout/stderr emission. Aggregate `counts` already pass the sanitizer.
- Tracks Codex usage in `src/services/api/codexUsage.ts`, which fetches usage snapshots and pre-marks accounts as `capped` when fully exhausted. Near-cap state (e.g. 80% of cap) is observed but not emitted as a diagnostic today. Claude pool has no equivalent usage telemetry; this plan does not add one.
- For all other work in this plan, Cat Code needs only a documentation pass clarifying that aggregate counts are a stable optional field on the public connection diagnostic surface. The exception is the new `account.usage.warning` code (Track E), which adds one new diagnostic emission in Cat Code's existing usage code path.

## Desired Behavior

**Unrecoverable diagnostic copy** (per-code):

- `auth.missing` (provider has no usable Cat Code auth)
  - First-run variant: "Cat Code is installed but not signed in for the selected provider. Open `cat-code` and complete login, then retry from Open Design. Account state is managed by Cat Code, not Open Design."
  - Mid-session variant: "Cat Code lost authentication for the selected provider. Open `cat-code`, run the login flow for that provider, then retry."
  - First-run detection heuristic: no prior successful run recorded for this `CAT_CODE_BIN` in Open Design's app-config, OR connection-test has never succeeded.
- `quota.exhausted` (all relevant accounts known capped)
  - "All Cat Code accounts for the selected provider are currently capped. Wait for usage to reset, or open `cat-code` and run `/accounts` to inspect cap state. Open Design does not pick accounts — Cat Code handles that."
- `account.pool.unavailable` (no usable account: dead, locked, missing, resolver failure)
  - "Cat Code's account backend is unavailable. This usually needs login or vault repair in Cat Code — waiting will not help. Open `cat-code` and run `/accounts`."
- `model.provider_mismatch` (requested model cannot run against resolved provider)
  - "The selected model cannot run on Cat Code's currently available provider. Pick a compatible model in Settings, or repair Cat Code auth for the model's provider. This is not an account-selection issue."
  - Detail line must reference the model picker in Settings, not `/accounts`.
- `account.token_refresh.failed` (refresh failed, no replacement)
  - "Cat Code could not refresh provider authentication. Open `cat-code` and complete login again."
- `account.transient_failure` unrecovered (selected provider could not complete)
  - "Cat Code could not reach the selected model provider. Try again after the provider connection recovers." (Unchanged from May 12 plan.)

Each variant must be a single user-facing sentence plus, if needed, one detail sentence. No code snippets, no aliases, no counts in the unrecoverable copy itself (counts go to backend-readiness, see below). All copy must name **Cat Code** as the auth/account owner so users learn where account state lives.

**Forward-looking capacity warning (new `account.usage.warning`):**

- Cat Code emits `account.usage.warning` once per Cat Code session when any pool account crosses a near-cap usage threshold (target: 80%, set as a constant in the emitter; not user-configurable).
- Schema: `code: "account.usage.warning"`, `severity: "warning"`, `recoverable: true`, plus the standard `version`/`provider`. Optional `counts` and a sanitized `account_ref` for support logs. No alias, no email, no full account ID.
- Open Design surfaces the warning as a single inline FYI note in the run stream at the very start of the run (before any assistant text), shown at most once per Cat Code session per Open Design tab. Copy: **"Cat Code is near provider capacity."** No remediation prose, no account vocabulary, no link.
- This is the only non-unrecoverable diagnostic code that surfaces in normal run UX. All other recoverable codes (`account.route.selected`, `account.failover.succeeded`, recovered `account.transient_failure`) remain log-only.
- If the warning would fire on every run (account stays near-cap), Open Design must throttle to once per Cat Code session per tab — repeated warnings degrade the signal into noise.

**Pre-flight probe on run submit:**

- When the user submits a chat run targeting `cat-code`, run a short pre-flight probe against the configured `CAT_CODE_BIN` and selected model before spawning the actual run.
- Probe is a fast cat-code invocation that exits cleanly on success or emits a structured diagnostic on failure. Probe completes in <2s on success or returns the diagnostic on failure.
- If the probe returns an unrecoverable diagnostic, block the run and show the per-code copy above. Do not spawn the run.
- If the probe returns a recoverable diagnostic, log to `console.warn` and proceed with the run. The recoverable diagnostic is hidden from the user (May 12 contract).
- If the probe times out (network glitch, slow disk), proceed with the run. Pre-flight is advisory, not authoritative. The real run's own diagnostic is the source of truth.
- The probe must not write any global Cat Code state. It uses the same spawn path as the connection test.

**Backend-readiness counts in connection-test result:**

- Extend `publicCatCodeDiagnostic()` to optionally include `counts` aggregate `{total, healthy, capped, dead, locked}` when present on the source diagnostic. Counts are aggregate sanitized integers; nothing identity-bearing.
- Update the `CatCodeConnectionDiagnostic` contract in `packages/contracts/src/api/connectionTest.ts` to include `counts?: { total: number; healthy: number; capped: number; dead: number; locked: number }`.
- When the connection test succeeds, surface counts in Settings as backend readiness: "Cat Code backend ready: 2 of 3 usable" or "Cat Code backend ready" when counts are not present.
- When the connection test fails with an unrecoverable diagnostic that includes counts, append counts to the existing error detail: "0 of 3 usable" so the user understands the scope.
- Counts render only after an explicit Test action. No polling. No spawn-on-render. No fetch on Settings open.

**Explicitly rejected (do not implement):**

- In-run failover UI of any kind, even a "Cat Code recovered" toast. Recoverable diagnostics stay log-only.
- Post-run account attribution. The opaque `account_ref` field is for support logs, not user-facing copy.
- Any picker, dropdown, deep-link to `/switch-account`, or per-project account binding.
- Polling Cat Code for pool state. Counts are sampled only during user-initiated connection tests and pre-flight probes.

## Parallel Implementation Tracks

### Track A: Per-code unrecoverable copy

**Owner:** Open Design diagnostics subagent.

**Goal:** Replace the current single-sentence copy in `catCodeDiagnosticMessage()` with per-code messages including the first-run `auth.missing` variant and the model-picker-routed `model.provider_mismatch` variant.

**Files:**

- Modify: `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`
- Modify: `/Users/pt/open-design/apps/web/src/i18n/locales/en.ts`
- Modify: `/Users/pt/open-design/apps/daemon/tests/connection-test.test.ts`
- Modify: `/Users/pt/open-design/apps/web/tests/components/SettingsDialog.execution.test.tsx`

**Can run in parallel with:** Track C.

**Must wait for:** none.

**Do not touch:**

- Cat Code repository files.
- Recoverable diagnostic handling in `server.ts` (must remain `console.warn`-only).
- The diagnostic schema itself.

**Steps:**

- [ ] Add failing tests in `connection-test.test.ts` for each code: `auth.missing` first-run, `auth.missing` mid-session, `quota.exhausted`, `account.pool.unavailable`, `model.provider_mismatch`, `account.token_refresh.failed`. Each test asserts the per-code copy specified in "Desired Behavior" above.
- [ ] Add failing test asserting `model.provider_mismatch` detail does not contain `/accounts`.
- [ ] Add failing test asserting every `auth.missing` variant names "Cat Code" as the auth owner.
- [ ] Decide first-run detection signal. Options: (a) absence of `lastConnectionTestSucceededAt` in app-config keyed by `CAT_CODE_BIN`, (b) a boolean `catCodeFirstRunSeen` flag. Pick (a) — it self-heals when the user reinstalls or changes binary path.
- [ ] Implement the per-code copy in `catCodeDiagnosticMessage()` and the detail mapper.
- [ ] Update i18n keys for any user-visible copy that lives in `en.ts`.
- [ ] Run focused tests.
- [ ] Run `pnpm --filter @open-design/daemon typecheck` and `pnpm --filter @open-design/web typecheck`.

**Done when:**

- Each unrecoverable code produces distinct user-facing copy that names the correct remediation surface (`cat-code`, model picker, or both).
- First-run `auth.missing` differs measurably from mid-session `auth.missing`.
- `model.provider_mismatch` never references `/accounts`.
- All copy names Cat Code as the auth/account owner.

### Track B: Pre-flight probe on run submit

**Owner:** Open Design daemon subagent.

**Goal:** Probe `CAT_CODE_BIN` + model before spawning a real run, surface unrecoverable diagnostics before the user commits, treat the probe as advisory on timeout.

**Files:**

- Modify: `/Users/pt/open-design/apps/daemon/src/server.ts`
- Modify or extend: `/Users/pt/open-design/apps/daemon/src/connectionTest.ts` (reuse existing probe path)
- Modify: `/Users/pt/open-design/apps/daemon/tests/chat-route.test.ts`
- Create or modify: `/Users/pt/open-design/apps/daemon/tests/preflight.test.ts` if a focused test file is warranted.

**Can run in parallel with:** Track A, Track C.

**Must wait for:** Track A unrecoverable copy keys, because the pre-flight error surface reuses the same copy mapping.

**Do not touch:**

- The recoverable diagnostic path.
- Cat Code repository files.
- Global Cat Code state (no `/accounts` calls, no profile mutation).

**Steps:**

- [ ] Add failing test: chat submission for `cat-code` calls the pre-flight probe before spawning the run.
- [ ] Add failing test: pre-flight returning an unrecoverable diagnostic blocks the run and surfaces the Track A copy via the SSE error channel.
- [ ] Add failing test: pre-flight returning a recoverable diagnostic logs and proceeds. The user never sees recoverable copy.
- [ ] Add failing test: pre-flight timing out proceeds with the run (advisory, not authoritative).
- [ ] Add failing test: pre-flight only runs for `agentId === 'cat-code'` and does not run for other agents.
- [ ] Implement pre-flight as a thin wrapper around the existing connection-test probe path. Reuse `testAgentConnection()` plumbing rather than introducing a new spawn surface.
- [ ] Set a 2s timeout. Past timeout, log a warn and proceed.
- [ ] Wire blocked runs into the existing SSE error path with `AGENT_EXECUTION_FAILED`.
- [ ] Run focused tests.

**Done when:**

- A user with `auth.missing` Cat Code sees the first-run copy before the run starts, not 10 seconds in.
- A user whose Cat Code is healthy notices no delay attributable to pre-flight on successful submits.
- Pre-flight never blocks a run on a recoverable diagnostic or on a probe timeout.
- Pre-flight only runs for the `cat-code` agent.

### Track C: Backend-readiness counts in connection-test result

**Owner:** Open Design contracts + UI subagent.

**Goal:** Surface aggregate Cat Code pool counts as backend readiness in the connection-test result. No polling, no Settings-open spawn, no account-management framing.

**Files:**

- Modify: `/Users/pt/open-design/packages/contracts/src/api/connectionTest.ts`
- Modify: `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`
- Modify: `/Users/pt/open-design/apps/daemon/src/connectionTest.ts`
- Modify: `/Users/pt/open-design/apps/daemon/tests/connection-test.test.ts`
- Modify: `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx`
- Modify: `/Users/pt/open-design/apps/web/src/i18n/locales/en.ts`
- Modify: `/Users/pt/open-design/apps/web/tests/components/SettingsDialog.execution.test.tsx`

**Can run in parallel with:** Track A, Track B.

**Must wait for:** none.

**Do not touch:**

- The recoverable diagnostic path.
- Cat Code repository files.
- Any code path that would call Cat Code outside an explicit user action.

**Steps:**

- [ ] Add failing contract test asserting `CatCodeConnectionDiagnostic` accepts an optional `counts` field with shape `{ total, healthy, capped, dead, locked }`.
- [ ] Add failing daemon test asserting `publicCatCodeDiagnostic()` preserves `counts` when present and omits it when absent. Existing redaction guarantees still apply.
- [ ] Add failing daemon test asserting `counts` survives the connection-test result envelope end-to-end.
- [ ] Add failing web test asserting Settings renders "Cat Code backend ready: N of M usable" after a successful connection test with counts, and "Cat Code backend ready" without counts.
- [ ] Add failing web test asserting Settings does not render counts on initial render or via any polling — only after an explicit Test action.
- [ ] Add failing web test asserting failed connection tests with counts append "0 of M usable" to the error detail.
- [ ] Extend the contract, extend `publicCatCodeDiagnostic()`, plumb through the connection-test response.
- [ ] Render the readiness line in Settings using the contract field. Use backend-readiness phrasing, never account-management phrasing.
- [ ] Run focused tests including `pnpm --filter @open-design/daemon typecheck` and `pnpm --filter @open-design/web typecheck`.

**Done when:**

- The contract has a typed optional `counts` field.
- Successful connection tests surface aggregate counts as backend readiness in Settings.
- Failed connection tests with counts append usable/total to the error detail.
- No spawn on Settings render. No polling. No background refresh.
- Counts appear nowhere in UI surfaces other than connection-test result and unrecoverable error detail.

### Track E: Forward-looking `account.usage.warning` code

**Owner:** Cross-repo subagent (Cat Code emitter + Open Design parser/display).

**Goal:** Cat Code emits a new `account.usage.warning` diagnostic when any pool account crosses a near-cap threshold. Open Design surfaces it once per Cat Code session as an inline FYI note at run start.

**Files (Cat Code):**

- Modify: `src/services/api/accountDiagnostics.ts` (add the new code to the schema's allowed code set; ensure sanitizer accepts it).
- Modify: `src/services/api/codexUsage.ts` (threshold check + emission).
- Modify or create: `src/services/api/codexUsage.test.ts` (or equivalent focused test) — assert emission on threshold crossing, no emission below threshold, no emission when account already capped (the capped diagnostic supersedes it).
- Modify: `src/entrypoints/sdk/coreSchemas.ts` and `src/entrypoints/sdk/coreTypes.generated.ts` only if the code list is enumerated in the schema (it likely is not; codes are string-typed). Confirm before changing.
- Update: `src/services/api/cat-code-account-diagnostics.golden.json` — add a golden fixture entry for `account.usage.warning`.

**Files (Open Design):**

- Modify: `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts` (recognize the new code; never describe it as unrecoverable; provide the FYI copy).
- Modify: `/Users/pt/open-design/apps/daemon/src/server.ts` (route the warning into the run stream as an inline note, throttled once per Cat Code session per tab).
- Modify: `/Users/pt/open-design/apps/daemon/tests/chat-route.test.ts` (assert inline note is sent exactly once per session; assert no SSE error event is emitted for this code; assert subsequent same-session warnings are suppressed).
- Modify: `/Users/pt/open-design/apps/daemon/tests/structured-streams.test.ts` (parser parity for the new code via the golden fixture).
- Modify: `/Users/pt/open-design/apps/daemon/tests/connection-test.test.ts` (assert the new code is not treated as unrecoverable; connection test still succeeds when only `account.usage.warning` is present).
- Modify: `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx` only if the existing run-stream rendering does not already support inline notes; otherwise no UI file change beyond locale strings.
- Modify: `/Users/pt/open-design/apps/web/src/i18n/locales/en.ts` (FYI copy string).

**Can run in parallel with:** Track A, Track C. Track B (pre-flight) does not depend on this code but should ignore it (pre-flight only blocks on unrecoverable diagnostics).

**Must wait for:** Cat Code Track E emitter PR must land before Open Design Track E display PR is merged; otherwise the Open Design test would have nothing to fixture against. Use the golden fixture as the integration contract between the two repos, as Tracks A–F of the May 12 plan did.

**Do not touch:**

- The classification of any existing diagnostic code.
- Any per-request route-selection diagnostic.
- Failover code paths.
- The pre-flight probe path (Track B) — that path must not surface `account.usage.warning` because pre-flight runs *before* the user has committed to the run. Showing capacity warnings during pre-flight would conflate "ready to run" with "running low."

**Steps:**

- [ ] Decide the threshold constant in Cat Code (target: 80%). Document it in `accountDiagnostics.ts` as a constant with a short comment.
- [ ] Add a failing Cat Code test: when usage snapshot reports an account at ≥80% but <100%, `account.usage.warning` is emitted with the correct schema fields and counts; below 80% no warning is emitted; at 100% the existing `capped`/`quota.exhausted` path runs and no warning fires.
- [ ] Add a failing Cat Code sanitizer test: `account.usage.warning` events strip aliases, emails, account IDs, tokens. Only aggregate `counts` and opaque `account_ref` survive.
- [ ] Add the golden fixture entry.
- [ ] Implement emission in `codexUsage.ts` near the existing cap pre-mark logic.
- [ ] Add a failing Open Design parser test: golden fixture for the new code parses into a `cat_code_account_diagnostic` event with `recoverable: true` and `code: "account.usage.warning"`.
- [ ] Add a failing Open Design daemon test: `account.usage.warning` produces exactly one inline note in the SSE run stream, with the FYI copy and no remediation prose; second occurrence in the same session produces zero additional notes.
- [ ] Add a failing Open Design daemon test: `account.usage.warning` never produces an `AGENT_EXECUTION_FAILED` SSE error.
- [ ] Add a failing Open Design daemon test: `account.usage.warning` arriving during the pre-flight probe is logged but not surfaced as an inline note (because the run has not started).
- [ ] Implement the daemon-side routing and once-per-session throttle. The throttle key is the Cat Code session id from the diagnostic envelope (`session_id`), scoped to the Open Design tab.
- [ ] Add the FYI locale string. The string must be exactly the copy specified above — no detail line, no link, no remediation.
- [ ] Run focused tests in both repos.
- [ ] Run `bun run build:dev:full` in Cat Code and `pnpm --filter @open-design/daemon typecheck` + `pnpm --filter @open-design/web typecheck` in Open Design.

**Done when:**

- Cat Code emits `account.usage.warning` exactly once per Cat Code session per crossing account when usage crosses the threshold, with no identity leakage.
- Open Design surfaces a single FYI note at the start of the next run, then suppresses repeats for the same Cat Code session.
- No SSE error path is taken for this code.
- Pre-flight does not surface the warning.
- The copy contains no account vocabulary, no failover description, no remediation prose.
- Tests in both repos pass; golden fixture parity holds.

### Track D: Cat Code-side documentation pass

**Owner:** Cat Code docs subagent.

**Goal:** Document that aggregate `counts` on the diagnostic schema is the stable optional field Open Design relies on for backend-readiness display, and reaffirm that recoverable diagnostics remain log-only on consumers.

**Files:**

- Modify: `docs/maps/auth-accounts-oauth.md`
- Modify: `docs/superpowers/plans/2026-05-12-open-design-cat-code-account-routing.md` (only the "Open Questions" section, marking the recoverable-diagnostic question resolved with a back-link to this plan)

**Can run in parallel with:** Track A, Track B, Track C, Track E.

**Must wait for:** Tracks A, B, C, E completion of code changes (to avoid documenting unbuilt behavior).

**Do not touch:**

- Implementation files in either repo.
- The May 12 plan's Hard Product Boundary, schema sections, or merge strategy.

**Steps:**

- [ ] Update the "Structured Diagnostics Boundary" table in `auth-accounts-oauth.md` to (a) note that aggregate `counts` is the field Open Design consumes for backend-readiness display and (b) document `account.usage.warning` as the single forward-looking, non-unrecoverable code that surfaces in normal run UX. All other optional fields and recoverable codes remain support-log-only.
- [ ] Add a back-link from `2026-05-12-open-design-cat-code-account-routing.md` Open Questions to this plan, marking the recoverable-diagnostic UI question resolved with the narrow `account.usage.warning` carve-out and the boundary discipline that limits it (verified by Track A/B/C/E tests).
- [ ] Run `git diff --check` for docs-only changes.

**Done when:**

- Future readers of the May 12 plan can find this plan and see the recoverable-UI question is answered.
- The auth/accounts map names aggregate `counts` as a stable consumer-facing optional field and `account.usage.warning` as the single inline-note code with throttling rules.

## Merge Strategy

Merge order:

1. Track A: per-code copy. Self-contained, ships first.
2. Track C: contract extension and backend-readiness display. Independent of A and B but benefits from landing after A so Settings copy and error copy share one mapping.
3. Track B: pre-flight probe. Reuses Track A copy.
4. Track E: `account.usage.warning` code. Cat Code emitter PR lands first; Open Design display PR follows once the golden fixture is shared. Independent of A/B/C but easier to review after A/C have established the per-code mapping conventions.
5. Track D: docs pass after A, B, C, E land.

Conflict-prone Open Design files:

- `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts` (Tracks A and C)
- `/Users/pt/open-design/apps/daemon/src/connectionTest.ts` (Tracks B and C)
- `/Users/pt/open-design/apps/daemon/src/server.ts` (Track B)
- `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx` (Track C)
- `/Users/pt/open-design/packages/contracts/src/api/connectionTest.ts` (Track C)

Coordination rules:

- Track A owns the per-code message map and locale keys. Tracks B, C, and E must reuse Track A's keys rather than inlining copy.
- Track C owns the contract change for `counts`. Track B and Track E must not introduce competing pool-status fields.
- Track E owns the new `account.usage.warning` code. No other Track may add a UI-surfacing path for any recoverable code, even one that "looks like" usage. If a similar signal is wanted, extend `account.usage.warning` rather than add a sibling code.
- No Track may add UI that consumes the existing recoverable routing codes (`account.route.selected`, `account.failover.succeeded`, recovered `account.transient_failure`). Those stay log-only.
- No Track may spawn Cat Code outside an explicit user action (submit, connection test).

Checkpoint tests after each merge:

- After Track A: daemon connection-test tests and web SettingsDialog tests pass with per-code copy assertions.
- After Track C: contract test and Settings backend-readiness test pass; redaction-property tests still pass.
- After Track B: chat-route and pre-flight tests pass; submit path still works for non-cat-code agents unchanged.
- After Track E: Cat Code emitter test, golden fixture, Open Design parser/throttle tests, and pre-flight-ignores-warning test all pass. `account.usage.warning` produces inline notes, never SSE errors, and never repeats within a Cat Code session.
- After Track D: `git diff --check` clean; map references resolve.

## Testing Plan

Open Design unit and integration tests:

- Per-code unrecoverable copy distinguishes all six code paths above.
- First-run `auth.missing` differs from mid-session `auth.missing` based on the chosen first-run signal.
- `model.provider_mismatch` copy and detail reference model selection, not `/accounts`.
- Pre-flight probe blocks runs on unrecoverable diagnostics, proceeds on recoverable, proceeds on timeout, only runs for `cat-code`.
- Connection-test contract carries optional `counts` and Settings renders backend-readiness only after explicit Test.
- `account.usage.warning` produces exactly one inline run-stream note per Cat Code session, never an SSE error, never any account vocabulary.
- Pre-flight does not surface `account.usage.warning`.
- No Settings render path triggers a Cat Code spawn.
- No new surface displays recoverable routing diagnostic content (`account.route.selected`, `account.failover.succeeded`, recovered `account.transient_failure`).
- All existing May 12 guardrail tests still pass unchanged.

Cat Code unit and integration tests:

- `account.usage.warning` fires when an account crosses the threshold and not before.
- The warning does not fire when the account is already `capped` (the cap diagnostic supersedes it).
- Sanitizer strips aliases, emails, account IDs, tokens from the new code.
- Golden fixture round-trips through the existing emitter and Open Design parser without divergence.

## Verification Commands

Open Design focused commands:

```bash
cd /Users/pt/open-design
corepack enable
corepack pnpm --filter @open-design/daemon test -- apps/daemon/tests/connection-test.test.ts apps/daemon/tests/chat-route.test.ts apps/daemon/tests/structured-streams.test.ts apps/daemon/tests/app-config.test.ts apps/daemon/tests/runtimes/registry-and-args.test.ts apps/daemon/tests/runtimes/env-and-detection.test.ts
corepack pnpm --filter @open-design/web test -- apps/web/tests/components/SettingsDialog.test.ts apps/web/tests/components/SettingsDialog.execution.test.tsx
corepack pnpm --filter @open-design/daemon typecheck
corepack pnpm --filter @open-design/web typecheck
```

Cat Code docs-only validation (Track D):

```bash
cd /Users/pt/cat-code
git diff --check -- docs/maps/auth-accounts-oauth.md docs/superpowers/plans/2026-05-12-open-design-cat-code-account-routing.md docs/superpowers/plans/2026-05-21-open-design-cat-code-diagnostic-ux.md
```

Broader validation after all tracks land:

```bash
cd /Users/pt/open-design
corepack pnpm --filter @open-design/daemon test
corepack pnpm --filter @open-design/web test
corepack pnpm typecheck
corepack pnpm guard
```

## Non-Goals

- No in-run failover UI of any kind.
- No "Cat Code recovered and continued" status, generic or otherwise.
- No post-run account attribution (`account_ref` stays in logs only).
- No picker, dropdown, or deep-link to `/switch-account`.
- No per-project Cat Code account binding.
- No polling Cat Code for pool state.
- No spawn-on-render in Settings.
- No exposure of aliases, emails, full account IDs, tokens, or any other identity material.
- No user-configurable usage-warning threshold. The constant lives in Cat Code.
- No remediation prose, link, or call-to-action attached to `account.usage.warning`. It is pure FYI.
- No Claude-pool usage warning (Claude pool has no usage telemetry today; out of scope).
- No additional non-unrecoverable codes surfaced in normal UX beyond `account.usage.warning`.
- No change to Cat Code's diagnostic schema beyond clarifying `counts` and adding the single `account.usage.warning` code in Track E.
- No re-litigation of the May 12 product boundary.

## Risks and Tradeoffs

**First-run signal correctness:**

- Using `lastConnectionTestSucceededAt` keyed by `CAT_CODE_BIN` means a user who reinstalls Cat Code or moves the binary briefly looks like a first-run user again. That is acceptable — the first-run copy is still correct guidance for that state. The alternative (boolean flag that never resets) would mislead users in exactly those cases.

**Pre-flight latency:**

- A 2s probe adds perceptible latency on every cat-code submit. Mitigation: probe runs in parallel with prompt preparation; results are checked at the moment of spawn. If the probe finishes after spawn would have happened, do not block — log and proceed. Test must assert no added latency on the success path beyond pre-existing prompt-prep cost.

**Counts staleness:**

- Counts come from the diagnostic emitted at the moment of the probe or connection test. They age out the moment Cat Code's pool state changes (login, cap reset, refresh). That is the same staleness window as the connection test itself, and it is acceptable for an advisory readiness display. The Settings copy must not imply real-time accuracy ("currently ready" is fine; "always ready" is not).

**Boundary creep:**

- Aggregate counts are a sanctioned exception to "no account topology in UI" because they do not name accounts. The risk is future PRs treating counts as a precedent to surface more detail. Mitigation: this plan explicitly limits the surface (connection-test result + unrecoverable error detail). Any future request to render counts elsewhere goes through a new boundary review.

**Pre-flight unique to Cat Code:**

- Other agents (Claude Code, Codex CLI, Gemini, etc.) do not get pre-flight. That asymmetry is intentional — they do not emit structured diagnostics. If they ever do, pre-flight can extend. Tests must assert pre-flight only runs for `cat-code` to prevent accidental fan-out.

**Recoverable diagnostic temptation:**

- Workers implementing Track B will see recoverable diagnostics flowing through the pre-flight path and may be tempted to surface them ("just a small toast"). The plan rejects this explicitly. Reviewers must enforce.

**`account.usage.warning` boundary creep:**

- The new code is the *only* non-unrecoverable diagnostic that surfaces in normal run UX. Future PRs may treat it as precedent ("we already show usage; let's also show recoveries / route selections / health"). The plan rejects that. Reviewers must treat any new UI surfacing of recoverable codes as a separate boundary review, not a follow-on PR.
- Threshold choice (80%) is a guess based on typical provider cap shapes. If it produces too much noise, raise it; if users still hit caps unexpectedly, lower it. Do not introduce per-user configuration as the first response — tune the constant.
- Throttle keying on Cat Code's `session_id` means a user who restarts Cat Code mid-run gets a fresh warning. Acceptable: it matches the user's mental model of "new Cat Code session, new state."
- Pre-flight runs the cat-code binary briefly before the actual run. If pre-flight's short-lived process emits `account.usage.warning`, that warning belongs to a transient Cat Code session distinct from the run's session. The Track E implementation must scope the throttle to the *run's* session, not the pre-flight session, or the warning will fire on every submit. The Track E test for "pre-flight does not surface the warning" catches this.

## Open Questions

- Should the pre-flight probe reuse the connection-test code path verbatim, or share a common probe primitive? Decision deferred to Track B implementer; prefer reuse if the surfaces match cleanly.
- Should Settings remember the last backend-readiness counts between tabs/sessions, or always require a fresh Test action? Default: do not persist. If user feedback requests it later, persist with a clear "last tested at" timestamp.
- Does the first-run `auth.missing` copy need a separate "Cat Code not installed" branch? Out of scope — Cat Code-not-installed is already handled by agent detection in `executables.ts` before any diagnostic emission.
- Threshold value for `account.usage.warning` is set to 80% as a starting point. Revisit after one cycle of real usage data — adjust the constant, do not add user-facing configuration.
- Should `account.usage.warning` also be emitted by Claude pool when telemetry exists? Out of scope today; the Claude pool does not expose usage snapshots. If Claude pool gains usage telemetry later, extend the same code rather than add a sibling.
