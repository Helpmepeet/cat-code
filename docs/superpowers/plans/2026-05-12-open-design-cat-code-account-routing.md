# Open Design Cat Code Account Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Open Design rely on Cat Code for account routing, cap recovery, token recovery, failover, and final account diagnostics without exposing Cat Code profiles, account aliases, or account switching controls in Open Design.

**Architecture:** Cat Code owns account pools and emits sanitized, versioned account-routing diagnostics through its existing stream-json SDK output plus an incremental stderr fallback for early failures. Open Design remains profile-free: it selects only the Cat Code binary and model, parses structured diagnostics, logs recoverable routing internally, and shows user-facing account backend errors only when Cat Code cannot recover. Cross-repo work starts with a frozen Cat Code diagnostic schema so Open Design parser/display work and Cat Code failover work do not diverge.

**Tech Stack:** TypeScript, Bun test runner in Cat Code, pnpm/Corepack/Vitest in Open Design, Cat Code SDK stream-json messages, Open Design daemon SSE, Open Design contracts package.

---

## Hard Product Boundary

- Open Design must not add a Cat Code profile picker.
- Open Design must not add an account alias selector.
- Open Design must not add per-design-project account binding.
- Open Design must not call `/accounts`, `/switch-account`, or mutate Cat Code account pointers.
- Open Design must not persist Cat Code account/profile settings.
- Open Design must not prompt users to switch accounts before running.
- Open Design must not expose full account identifiers, full aliases, emails, refresh tokens, access tokens, or provider secret material.
- Recoverable Cat Code account routing and failover are backend details. Open Design should log them, not surface them as normal run-stream UX.

## Current State

Open Design currently controls:

- `apps/daemon/src/runtimes/defs/cat-code.ts`: spawns Cat Code with `-p --output-format stream-json --verbose`, optional `--model`, optional `--add-dir`, and `--permission-mode bypassPermissions`.
- `apps/daemon/src/app-config.ts`: persists only `CAT_CODE_BIN` for Cat Code. It does not persist a profile, account, account alias, `CLAUDE_CONFIG_DIR`, or `OPENAI_API_KEY`.
- `apps/daemon/src/runtimes/env.ts`: treats Cat Code as Claude-auth-compatible for env stripping, while keeping Cat Code account state outside Open Design.
- `apps/daemon/src/server.ts`: forwards Cat Code stream-json output through the Claude stream parser and sends stderr to the client.
- `apps/daemon/src/connectionTest.ts`: tests Cat Code by spawning the configured executable with runtime args.

Cat Code currently controls:

- `src/utils/config.ts`: persists `activeClaudeAccountUuid` and `activeCodexAccountId`.
- `src/services/api/claudeAccountPool.ts`: loads Claude vault/config accounts, repairs the active pointer to a healthy account, and syncs selected Claude OAuth material to legacy storage.
- `src/services/api/codexAccountPool.ts`: loads Codex vault/config accounts, tracks `healthy`/`dead`/`capped`, repairs the active pointer, stores usage hints, and rotates on known failures.
- `src/services/api/codexAccountLeaseManager.ts`: assigns and failovers Codex leases for main and subagent owners.
- `src/services/api/codexTokenRefresh.ts`: refreshes Codex account tokens and marks failed accounts dead.
- `src/services/api/codexUsage.ts`: fetches usage snapshots and pre-marks exhausted accounts capped.
- `src/services/api/withRetry.ts`: retries Codex requests after cap and transient failures.
- `src/services/api/codex-fetch-adapter.ts`: converts pooled Codex `429` and current pooled `401` failures into account-level errors for retry/failover.

Account failover already happens:

- Codex hard cap or usage-limit failures flow through `CodexAccountCapError` to `withRetry()` and `failoverCodexLease()` or `switchToAccount(null)`.
- Codex transient connection failures can fail over after repeated failures without marking the account capped.
- Codex usage snapshots can pre-mark accounts capped before a request.
- Codex refresh failures can mark accounts dead.

Account failover does not happen or is ambiguous:

- Claude automatic failover is weaker than Codex. The pool repairs active selection, but request-time retry/failover on stale auth is not a clear backend contract.
- Pooled Codex `401` is currently handled like cap in the fetch adapter. The integration must distinguish refresh/auth failure from true quota/cap exhaustion before emitting final diagnostics.
- Cat Code all-accounts-unavailable errors are currently prose and can instruct users to `/switch-account`; Open Design should not expose that as normal UX.
- Open Design chat-run diagnostics currently retain stdout/stderr tails only for `claude`, not `cat-code`, so tail-scraped Cat Code diagnostics are unreliable.
- Open Design's `claude-stream-json` path currently sends parser events directly through `send('agent', ev)`, bypassing the `sendAgentEvent()` path that handles parser-emitted errors.
- Open Design diagnostics still contain "Cat Code profile" wording that conflicts with the product boundary.

## Desired Product Model

- Open Design remains profile-free and account-pool-free.
- Open Design users choose only an agent binary and model.
- Cat Code chooses a healthy account automatically.
- Cat Code handles capped, exhausted, stale, locked, dead, and transiently failing accounts internally.
- Cat Code distinguishes transient route failure from true all-accounts-unavailable.
- Cat Code emits structured diagnostics that Open Design can display only when recovery fails.
- Open Design logs recoverable account events for support/debugging but hides account routing details from normal users.
- Open Design settings diagnostics can say "Cat Code account backend unavailable" only when Cat Code reports unrecoverable backend failure.

## Backend Contract

### Primary stdout event

Cat Code should emit a versioned SDK `system` message subtype through stream-json. This is not a free-form JSON extension: the subtype must be added to Cat Code SDK schemas and outbound type unions.

Required schema work:

- Modify `src/entrypoints/sdk/coreSchemas.ts` to add the diagnostic message schema and subtype.
- Regenerate or update `src/entrypoints/sdk/coreTypes.generated.ts` and any outbound SDK message unions used by stream-json printing.
- Preserve required SDK envelope fields already required for `system` messages, including `uuid` and `session_id` if the surrounding schema requires them.
- Add tests proving `--output-format stream-json` can emit and parse the new subtype without breaking existing SDK consumers.

Canonical event body:

```json
{
  "type": "system",
  "subtype": "cat_code_account_diagnostic",
  "uuid": "event-uuid",
  "session_id": "session-id",
  "version": 1,
  "code": "account.pool.unavailable",
  "severity": "error",
  "provider": "openai",
  "pool": "codex",
  "requested_model": "gpt-5.5",
  "resolved_provider": "openai",
  "resolved_model": "gpt-5.5",
  "recoverable": false,
  "user_message": "Cat Code account backend unavailable. Open Cat Code and run `/accounts` to inspect account status.",
  "counts": {
    "total": 3,
    "healthy": 0,
    "capped": 2,
    "dead": 1,
    "locked": 0
  }
}
```

Required fields:

- `version`: `1`.
- `code`: one stable event code from this plan.
- `severity`: `info`, `warning`, or `error`.
- `provider`: `openai`, `anthropic`, or `unknown`.
- `recoverable`: `true` when Cat Code recovered and the run can continue; `false` when Open Design should surface a final diagnostic.

Recommended fields:

- `pool`: `codex`, `claude`, or `none`.
- `requested_model`: the user-selected model passed by Open Design.
- `resolved_provider`: the provider Cat Code actually resolved after applying `gpt-*` and current-provider rules.
- `resolved_model`: the final provider model after Cat Code mapping.
- `counts`: sanitized aggregate pool status.
- `account_ref`: process-local opaque ref such as `codex#1` or `claude#2`, never a real account id.
- `reason`: `usage_cap`, `token_refresh_failed`, `transient_connection`, `auth_missing`, `model_provider_mismatch`, `pool_empty`, `vault_locked`, or `resolver_failed`.
- `user_message`: required for unrecoverable events, omitted or ignored for recoverable events.

Forbidden fields:

- Full account ids.
- Full emails.
- Full aliases in normal events.
- Access tokens.
- Refresh tokens.
- ID tokens.
- Provider API keys.
- Raw HTTP authorization headers.
- Raw serialized account files.

### Stderr fallback

Cat Code should also emit an incremental stderr fallback for failures before stream-json is initialized:

```text
CAT_CODE_DIAGNOSTIC {"version":1,"code":"auth.missing","severity":"error","provider":"openai","pool":"codex","recoverable":false,"user_message":"Cat Code is not signed in for the selected model provider. Open Cat Code, complete login, then retry."}
```

Open Design must parse `CAT_CODE_DIAGNOSTIC ` lines as stderr arrives. It must not rely on truncated stdout/stderr tails for this fallback.

### Event codes

`account.route.selected`

- Severity: `info`.
- Recoverable: `true`.
- Open Design normal UI: hidden.
- Purpose: log selected provider/pool/model without identity.

`account.failover.succeeded`

- Severity: `info` or `warning`.
- Recoverable: `true`.
- Open Design normal UI: hidden.
- Purpose: support/debug log that Cat Code recovered internally.

`account.transient_failure`

- Severity: `warning`.
- Recoverable: `true` if recovery succeeded, `false` if the selected provider backend could not complete the run.
- Open Design normal UI: hidden when recovered; generic error when unrecovered.
- Purpose: distinguish temporary connection/account routing failures from quota exhaustion.

`account.token_refresh.failed`

- Severity: `warning` when another account can be used, `error` when no account remains.
- Recoverable: depends on pool state.
- Open Design normal UI: hidden when recovered.
- Purpose: distinguish stale/dead auth from usage caps.

`account.pool.unavailable`

- Severity: `error`.
- Recoverable: `false`.
- Open Design normal UI: show final diagnostic.
- Purpose: no usable account exists because accounts are dead, locked, missing, or resolver state failed.

`quota.exhausted`

- Severity: `error`.
- Recoverable: `false`.
- Open Design normal UI: show final diagnostic.
- Purpose: all relevant accounts are known capped or exhausted.

`auth.missing`

- Severity: `error`.
- Recoverable: `false`.
- Open Design normal UI: show final diagnostic.
- Purpose: selected provider lacks usable Cat Code auth.

`model.provider_mismatch`

- Severity: `error`.
- Recoverable: `false`.
- Open Design normal UI: show final diagnostic.
- Purpose: requested model cannot run against the provider Cat Code resolved or the healthy provider set.

## Failover Semantics

Active Codex account capped:

- Treat verified `429` or provider usage-limit signals as `usage_cap`.
- Mark the current Codex account capped.
- Fail over the current lease to another healthy account.
- Emit `account.failover.succeeded` with sanitized refs and counts.
- Retry only when no visible output or tool side effect has started.
- If retry would duplicate paid work or tool effects, stop and emit an unrecoverable diagnostic that does not claim all accounts are exhausted.

Codex `401` or token refresh failure:

- Do not emit `quota.exhausted` until refresh/auth failure has been distinguished from cap.
- Attempt account-specific token refresh when the account is refreshable and the failure is compatible with expired access.
- Mark refresh-failed accounts dead or auth-failed.
- Emit `account.token_refresh.failed`.
- Fail over to another healthy account if one exists.
- If no account remains, emit `auth.missing` or `account.pool.unavailable`, not `quota.exhausted`.

All Codex accounts capped or dead:

- Emit `quota.exhausted` when every relevant account is known capped/exhausted.
- Emit `account.pool.unavailable` when accounts are missing, dead, locked, or resolver state failed.
- Do not suggest account picking in Open Design.
- User-facing remediation may say to open Cat Code and run `/accounts` only after unrecoverable failure.

Claude account stale:

- Refresh the active Claude account.
- If refresh fails and another healthy Claude account exists, Cat Code should switch internally and retry before the request starts.
- Emit `account.token_refresh.failed` for the failed route and `account.failover.succeeded` for internal recovery.
- If no healthy Claude account remains, emit `auth.missing` or `account.pool.unavailable`.

Claude has multiple healthy accounts:

- Use the current active Claude pointer.
- Do not proactively rotate merely because multiple accounts exist.
- Do not expose aliases, emails, or account labels to Open Design.

Provider and model resolution:

- `gpt-*` models imply OpenAI/Codex through Cat Code's existing provider resolver.
- Non-GPT models do not automatically imply Claude. They inherit Cat Code's current provider unless Cat Code code changes this behavior.
- Codex may map Claude-style model names to Codex models in the adapter. Diagnostics must include both `requested_model` and `resolved_model` so Open Design can explain failures accurately.
- If the requested model cannot be served by the resolved provider or healthy account pool, emit `model.provider_mismatch`.

Global active state:

- The safest Open Design route is a per-process lease that does not write `activeCodexAccountId` or `activeClaudeAccountUuid`.
- If implementation keeps current global pointer updates, those updates remain Cat Code-owned backend policy. Open Design must not trigger, configure, or display them.
- Track B must make this choice explicit before changing failover code.

## Open Design Behavior

Run stream:

- Hide recoverable account-routing diagnostics from normal users.
- Never show "switched account" or account alias language in normal run UI.
- Show unrecoverable diagnostics as final run errors.
- A generic non-account status such as "Cat Code recovered and continued" may be used only if product review decides users need visible reassurance during long runs. Default is log-only.

Logs:

- Log structured code, severity, provider, pool, requested model, resolved provider, resolved model, counts, recoverable, and sanitized refs.
- Strip or reject identity-bearing fields before writing app logs.

Settings diagnostics:

- `auth.missing`: "Cat Code is not signed in for the selected model provider. Open Cat Code, complete login, then retry."
- `quota.exhausted`: "Cat Code account backend unavailable. Open Cat Code and run `/accounts` to inspect account status."
- `account.pool.unavailable`: "Cat Code account backend unavailable. Open Cat Code and run `/accounts` to inspect account status."
- `model.provider_mismatch`: "The selected model does not match a healthy Cat Code provider. Choose a compatible model or repair Cat Code auth."
- `account.transient_failure` unrecovered: "Cat Code could not reach the selected model provider. Try again after the provider connection recovers."

Settings and config:

- Keep only Cat Code binary path controls.
- Remove "Cat Code profile" wording from Cat Code diagnostics.
- Do not add profile/account fields, environment variables, or persisted account settings.

## Parallel Implementation Tracks

### Track A: Cat Code structured diagnostics contract

**Owner:** Cat Code diagnostics subagent.

**Goal:** Define and emit a valid SDK stream-json diagnostic message plus incremental stderr fallback with complete sanitization.

**Files:**

- Modify: `src/entrypoints/sdk/coreSchemas.ts`
- Modify: `src/entrypoints/sdk/coreTypes.generated.ts`
- Modify: SDK outbound message union files referenced by `coreSchemas.ts`
- Modify: `src/cli/print.ts`
- Create: `src/services/api/accountDiagnostics.ts`
- Create: `src/services/api/accountDiagnostics.test.ts`
- Modify or create focused stream-json SDK tests under the existing Cat Code test layout.

**Can run in parallel with:** Track B using a temporary no-op emitter, Track D.

**Must wait for:** none.

**Do not touch:**

- Open Design files.
- Account selection or retry policy.
- `/accounts` and `/switch-account` command UX.

**Steps:**

- [ ] Inspect existing `system` message schemas in `src/entrypoints/sdk/coreSchemas.ts` and identify the exact outbound union that includes `system` subtypes.
- [ ] Add a failing schema/type test that rejects a diagnostic event missing SDK-required envelope fields.
- [ ] Add a failing sanitizer test with sample email, account id, access token, refresh token, and alias-bearing input.
- [ ] Add the `cat_code_account_diagnostic` subtype to `coreSchemas.ts`.
- [ ] Update or regenerate generated SDK types so the new subtype is type-safe.
- [ ] Implement `accountDiagnostics.ts` with event construction, sanitization, stdout emission hook, and `CAT_CODE_DIAGNOSTIC` stderr fallback.
- [ ] Wire stream-json printing through `src/cli/print.ts` without changing existing `system init`, `system status`, `assistant`, `user`, or `result` message behavior.
- [ ] Run focused tests.
- [ ] Run `bun run build:dev:full`.

**Done when:**

- Cat Code can emit `system.subtype = "cat_code_account_diagnostic"` as valid stream-json.
- Old stream-json consumers continue to receive valid NDJSON.
- Tests prove forbidden identity/token fields do not appear in stdout or stderr diagnostics.

### Track B: Cat Code account failover semantics

**Owner:** Cat Code routing subagent.

**Goal:** Make Codex and Claude account recovery emit the Track A diagnostics and distinguish caps, stale auth, transient connection failures, and all-accounts-unavailable states.

**Files:**

- Modify: `src/services/api/withRetry.ts`
- Modify: `src/services/api/client.ts`
- Modify: `src/services/api/codex-fetch-adapter.ts`
- Modify: `src/services/api/codexAccountPool.ts`
- Modify: `src/services/api/codexAccountLeaseManager.ts`
- Modify: `src/services/api/codexTokenRefresh.ts`
- Modify: `src/services/api/codexUsage.ts`
- Modify: `src/services/api/claudeAccountPool.ts`
- Modify tests adjacent to those files.

**Can run in parallel with:** Track A using a temporary no-op emitter interface, Track D.

**Must wait for:** Track A event names and emitter signature before final merge.

**Do not touch:**

- Open Design files.
- Cat Code command UI except internal error text that currently suggests `/switch-account` during backend failures.
- Standalone explicit-account Codex core paths unless a test proves the Open Design spawn path uses them.

**Steps:**

- [ ] Add a failing Codex test where account one returns a verified cap and account two succeeds. Assert retry uses account two and emits `account.failover.succeeded`.
- [ ] Add a failing Codex test where all accounts are capped. Assert final diagnostic is `quota.exhausted`.
- [ ] Add a failing Codex test where pooled `401` triggers refresh/auth handling and does not emit `quota.exhausted`.
- [ ] Add a failing transient connection test. Assert recovered transient failover emits `account.transient_failure` or `account.failover.succeeded` but does not mark the failed account capped.
- [ ] Add a failing Claude stale-account test. Assert a second healthy Claude account can be used internally without exposing alias/email.
- [ ] Decide and document whether Open Design runs use a per-process lease that avoids writing global active pointers. If yes, implement the route before wiring Open Design diagnostics.
- [ ] Split Codex cap diagnostics from token refresh/auth diagnostics in `codex-fetch-adapter.ts`, `codexTokenRefresh.ts`, and `withRetry.ts`.
- [ ] Emit structured diagnostics at route selected, failover succeeded, refresh failed, exhausted, unavailable, and model/provider mismatch boundaries.
- [ ] Replace user-facing backend prose that instructs Open Design users to switch accounts with structured diagnostics. Keep `/accounts` and `/switch-account` commands unchanged.
- [ ] Run focused Cat Code API tests.
- [ ] Run `bun run build:dev:full`.

**Done when:**

- Cat Code recovers internally from capped, stale, and transiently failing accounts when a safe replacement exists.
- Cat Code emits unrecoverable diagnostics only after backend recovery fails.
- `401`/refresh failure is not mislabeled as quota exhaustion.
- Provider diagnostics include `requested_model`, `resolved_provider`, and `resolved_model`.

### Track C: Open Design Cat Code parser and display

**Owner:** Open Design stream/daemon subagent.

**Goal:** Parse Cat Code structured diagnostics, route unrecoverable diagnostics into daemon error handling, log recoverable diagnostics without surfacing account details, and support incremental stderr fallback.

**Files:**

- Modify: `/Users/pt/open-design/apps/daemon/src/claude-stream.ts`
- Modify: `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`
- Modify: `/Users/pt/open-design/apps/daemon/src/server.ts`
- Modify: `/Users/pt/open-design/apps/daemon/src/connectionTest.ts`
- Modify: `/Users/pt/open-design/packages/contracts/src/api/connectionTest.ts`
- Modify: `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx`
- Modify: `/Users/pt/open-design/apps/web/src/i18n/locales/en.ts`
- Modify daemon and web tests adjacent to those files.

**Can run in parallel with:** Track D after Track A schema is drafted.

**Must wait for:** Track A schema and fixture events.

**Do not touch:**

- Open Design account/profile settings.
- Cat Code runtime args except tests proving no account args are passed.
- Cat Code repository files.

**Steps:**

- [ ] Add fixture NDJSON events for all Track A event codes under the daemon tests.
- [ ] Add failing parser tests proving `cat_code_account_diagnostic` events become typed daemon events.
- [ ] Add failing server tests proving unrecoverable parser diagnostics flow through the same handling path as run errors, not only `send('agent', ev)`.
- [ ] Add failing stderr tests proving `CAT_CODE_DIAGNOSTIC` lines are parsed incrementally as stderr arrives.
- [ ] Add failing connection-test cases for `auth.missing`, `account.pool.unavailable`, `quota.exhausted`, and `model.provider_mismatch`.
- [ ] Implement parser support in `claude-stream.ts`.
- [ ] Rewire `server.ts` so Cat Code diagnostic errors enter the run-error path and recoverable diagnostics are log-only.
- [ ] Extend `connectionTest.ts` and the contracts package with account/backend-specific result mapping or structured detail while preserving old clients.
- [ ] Update Settings copy to use account-backend wording and remove "Cat Code profile" language.
- [ ] Keep prose scraping as fallback for older Cat Code versions.
- [ ] Run focused Open Design daemon and web tests.

**Done when:**

- Open Design displays only unrecoverable Cat Code account backend failures.
- Recoverable account routing is hidden from normal UI and available in sanitized logs.
- Cat Code stderr fallback is parsed without relying on truncated tails.
- Settings diagnostics use account-backend language, not profile/account-picker language.

### Track D: Open Design profile-free guardrails

**Owner:** Open Design boundary subagent.

**Goal:** Lock the product boundary in tests so future work cannot accidentally add Cat Code profile/account controls.

**Files:**

- Modify: `/Users/pt/open-design/apps/daemon/src/app-config.ts`
- Modify tests: `/Users/pt/open-design/apps/daemon/tests/app-config.test.ts`
- Modify tests: `/Users/pt/open-design/apps/daemon/tests/runtimes/registry-and-args.test.ts`
- Modify tests: `/Users/pt/open-design/apps/daemon/tests/runtimes/env-and-detection.test.ts`
- Modify tests: `/Users/pt/open-design/apps/web/tests/components/SettingsDialog.execution.test.tsx`
- Modify tests: `/Users/pt/open-design/apps/web/tests/components/SettingsDialog.test.tsx`

**Can run in parallel with:** Track A, Track B, Track C fixture preparation.

**Must wait for:** none.

**Do not touch:**

- Cat Code repository files.
- Diagnostic schema.
- Open Design settings controls except assertions/copy needed to remove profile wording.

**Steps:**

- [ ] Add negative app-config tests proving Cat Code drops `CAT_CODE_PROFILE`, account id, alias, `CLAUDE_CONFIG_DIR`, `OPENAI_API_KEY`, and any profile/account-looking keys.
- [ ] Add runtime arg tests proving Cat Code spawn never includes profile/account flags.
- [ ] Add Settings tests proving only Cat Code binary path is rendered for Cat Code-specific CLI env.
- [ ] Add env tests proving Open Design does not synthesize account/profile env for Cat Code.
- [ ] Update copy tests so "Cat Code profile" no longer appears.
- [ ] Run focused Open Design tests.

**Done when:**

- Guardrail tests fail if a future change adds Cat Code profile/account config or UI.
- Cat Code settings remain binary-path-only.

### Track E: Integration tests and regression coverage

**Owner:** cross-repo integration subagent.

**Goal:** Prove fake Cat Code diagnostics drive Open Design correctly and fake account pools drive Cat Code failover correctly without live accounts.

**Files:**

- Modify Cat Code tests created by Tracks A and B.
- Modify Open Design daemon tests created by Tracks C and D.
- Create cross-repo fixture docs or test fixtures if both repos need identical event samples.

**Can run in parallel with:** none until Track A and Track C stubs exist.

**Must wait for:** Track A and Track C.

**Do not touch:**

- Live account configuration.
- Real vault files.
- Real user config.

**Steps:**

- [ ] Add shared golden diagnostic fixtures in both repos with identical event payloads.
- [ ] Add a Cat Code test that emits every event code through the real diagnostic emitter and snapshots sanitized JSON.
- [ ] Add an Open Design test that feeds every fixture event through the daemon parser and asserts UI/log disposition.
- [ ] Add an Open Design connection-test fixture for stderr-only fallback.
- [ ] Add regression tests that old Cat Code prose diagnostics still map through fallback.
- [ ] Run focused tests in both repos.
- [ ] Run broad validation commands listed in this plan.

**Done when:**

- Cat Code and Open Design agree on the same event schema.
- No test fixture contains a full email, token, or full account id.
- Old Cat Code versions still produce usable Open Design diagnostics through fallback.

### Track F: Documentation and stale-reference cleanup

**Owner:** docs subagent.

**Goal:** Document the final boundary, diagnostics contract, and troubleshooting path after implementation lands.

**Files:**

- Modify: `docs/maps/auth-accounts-oauth.md`
- Modify: `docs/maps/codex-core.md`
- Create or modify Cat Code docs under `docs/codex/`
- Modify Open Design agent/runtime docs after locating the current docs entrypoint in `/Users/pt/open-design`

**Can run in parallel with:** after Track A and Track C decisions stabilize.

**Must wait for:** Track A contract and Track C Open Design behavior.

**Do not touch:**

- Implementation files.
- Settings UI.

**Steps:**

- [ ] Update Cat Code account docs to describe structured diagnostics and Open Design-safe sanitization.
- [ ] Update Codex map docs to distinguish cap, refresh/auth, transient, and pool-unavailable paths.
- [ ] Update Open Design docs to say Cat Code remains profile-free and account recovery is owned by Cat Code.
- [ ] Remove stale docs that imply Open Design users should choose Cat Code profiles/accounts.
- [ ] Run docs-only checks.

**Done when:**

- Docs match implemented behavior.
- Troubleshooting says to inspect Cat Code with `/accounts` only after unrecoverable backend failure.

## Merge Strategy

Merge order:

1. Track A: Cat Code diagnostic schema and emitter.
2. Track D: Open Design profile-free guardrails.
3. Track C: Open Design parser/display using Track A fixtures.
4. Track B: Cat Code failover semantics emitting Track A events.
5. Track E: integration fixtures and regression coverage.
6. Track F: docs cleanup.

Conflict-prone Cat Code files:

- `src/services/api/withRetry.ts`
- `src/services/api/client.ts`
- `src/services/api/codex-fetch-adapter.ts`
- `src/services/api/codexAccountLeaseManager.ts`
- `src/entrypoints/sdk/coreSchemas.ts`
- `src/entrypoints/sdk/coreTypes.generated.ts`

Conflict-prone Open Design files:

- `/Users/pt/open-design/apps/daemon/src/server.ts`
- `/Users/pt/open-design/apps/daemon/src/connectionTest.ts`
- `/Users/pt/open-design/apps/daemon/src/claude-stream.ts`
- `/Users/pt/open-design/apps/daemon/src/claude-diagnostics.ts`
- `/Users/pt/open-design/packages/contracts/src/api/connectionTest.ts`
- `/Users/pt/open-design/apps/web/src/components/SettingsDialog.tsx`

Coordination rules:

- Track A owns event code names and required fields.
- Track C must parse unknown future codes as generic Cat Code diagnostics.
- Track B must not invent event fields outside Track A without updating fixtures first.
- Open Design should land a tolerant parser before Cat Code emits diagnostics broadly.
- Cross-repo fixtures must be reviewed whenever the event schema changes.

Checkpoint tests after each merge:

- After Track A: Cat Code diagnostic tests and `bun run build:dev:full`.
- After Track D: Open Design app-config/runtime/settings guardrail tests.
- After Track C: Open Design daemon parser/server/connection tests.
- After Track B: Cat Code API failover tests and `bun run build:dev:full`.
- After Track E: focused tests in both repos plus broad validation.
- After Track F: docs link/path checks.

## Testing Plan

Cat Code unit and integration tests:

- Cap failover: first Codex account returns verified cap, second account succeeds, diagnostic is recoverable and sanitized.
- All accounts capped: final diagnostic is `quota.exhausted`.
- All accounts dead/locked/missing: final diagnostic is `account.pool.unavailable`.
- Pooled Codex `401`: refresh/auth path is exercised and does not emit `quota.exhausted` unless a real cap is also proven.
- Token refresh failed: account is marked dead or auth-failed, another healthy account is used if present.
- Transient connection failover: recovery does not mark account capped and does not report quota exhaustion.
- Claude stale account: a healthy alternate Claude account can recover internally.
- Diagnostics sanitizer: output contains no emails, tokens, full account ids, full aliases, or raw account JSON.
- Existing Claude/Codex behavior outside Open Design remains unchanged.

Open Design unit and integration tests:

- Cat Code spawn args do not include account/profile selectors.
- Cat Code app config persists only `CAT_CODE_BIN`.
- Settings UI renders only the Cat Code binary path for Cat Code-specific CLI env.
- `cat_code_account_diagnostic` stream-json events parse into typed daemon diagnostics.
- Recoverable diagnostics are logged but not displayed as account routing UX.
- Unrecoverable diagnostics are displayed with account-backend messages.
- `CAT_CODE_DIAGNOSTIC` stderr lines are parsed incrementally.
- Connection test maps `auth.missing`, `quota.exhausted`, `account.pool.unavailable`, `model.provider_mismatch`, and unrecovered `account.transient_failure` correctly.
- Old prose scraping fallback still handles older Cat Code versions.

## Verification Commands

Cat Code focused commands:

```bash
bun test src/services/api/accountDiagnostics.test.ts
bun test src/services/api/codexAccountLeaseManager.test.ts
bun test src/services/api/codexAccountPool.test.ts
bun test src/services/api/codexTokenRefresh.test.ts
bun test src/services/api/codexUsage.test.ts
bun test src/services/api/codex-fetch-adapter.test.ts
bun run build:dev:full
```

Open Design focused commands:

```bash
cd /Users/pt/open-design
corepack enable
corepack pnpm --filter @open-design/daemon test -- apps/daemon/tests/claude-diagnostics.test.ts apps/daemon/tests/connection-test.test.ts apps/daemon/tests/runtimes/registry-and-args.test.ts apps/daemon/tests/app-config.test.ts
corepack pnpm --filter @open-design/web test -- apps/web/tests/components/SettingsDialog.test.tsx apps/web/tests/components/SettingsDialog.execution.test.tsx
corepack pnpm --filter @open-design/daemon typecheck
corepack pnpm --filter @open-design/web typecheck
```

Broader validation:

```bash
cd /Users/pt/cat-code
bun run build:dev:full

cd /Users/pt/open-design
corepack pnpm --filter @open-design/daemon test
corepack pnpm --filter @open-design/web test
corepack pnpm typecheck
corepack pnpm guard
```

Docs-only validation for this plan:

```bash
cd /Users/pt/cat-code
git diff --check -- docs/superpowers/plans/2026-05-12-open-design-cat-code-account-routing.md
test -f docs/superpowers/plans/2026-05-12-open-design-cat-code-account-routing.md
```

## Non-Goals

- No Open Design profile picker.
- No account alias selector.
- No per-design-project account binding.
- No Open Design mutation of Cat Code active account.
- No prompt-based instruction like "switch accounts before running."
- No leaking full account identity in events, logs, or UI.
- No Open Design usage/cap resolver.
- No live-account dependency in tests.
- No provider auto-switch that contradicts Cat Code's model/provider resolver.

## Risks and Tradeoffs

Global active account state vs per-process routing:

- Current Codex failover can update `activeCodexAccountId`. A per-process Open Design route lease better preserves interactive Cat Code state, but requires careful plumbing through existing lease code.

Subagent leases:

- Main and subagent owners must retain isolated leases. Failover for one owner must not steal another owner's route or overwrite its lease.

Retry safety:

- Retrying after cap is safe only before visible output or side effects. After partial output or tool effects, Cat Code should fail with a diagnostic instead of replaying paid/provider work.

Duplicate paid requests:

- Cap signals usually happen before useful output, but transient network failures can happen after provider-side work. Retry gates need explicit tests.

Identity leakage:

- `codexUsage.ts`, Claude pool records, and account command code can contain emails, aliases, and ids. Diagnostics must use aggregate counts and process-local refs.

Misreporting exhaustion:

- Resolver failure, locked vaults, stale refresh tokens, and provider connectivity are not quota exhaustion. Event codes must keep these states separate.

Parallel subagent conflicts:

- Track A owns schema.
- Track B owns backend semantics.
- Track C owns Open Design parser/display.
- Track D owns guardrails.
- Workers must not modify each other's owned files without a handoff.

## Open Questions

- Should Open Design runs use a Cat Code per-process lease that never writes global active account pointers, or is Cat Code-owned global failover acceptable?
- Should Claude automatic failover be implemented in the first backend pass or added after Codex diagnostics land?
- Resolved by [2026-05-21-open-design-cat-code-diagnostic-ux.md](./2026-05-21-open-design-cat-code-diagnostic-ux.md): recoverable routing diagnostics remain log-only. The only normal run UX carve-out is `account.usage.warning`, a forward-looking capacity FYI with copy `Cat Code is near provider capacity.` that is throttled once per Cat Code `session_id` per Open Design tab and carries no account vocabulary, remediation link, or identity-bearing fields.
- Should Open Design require a minimum Cat Code version for structured diagnostics, or keep prose fallback indefinitely?
- Should `CAT_CODE_DIAGNOSTIC` stderr fallback be considered stable public contract or only a compatibility bridge for early-start failures?
