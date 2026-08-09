# S06 — engine settings, usage, reset flow

> Produced by a separate Claude session working from the handoff prompt in this
> review set. Reproduced here verbatim so the finding set is complete. Its top
> finding was independently re-verified in source by the review lead (see the
> note at the end).

## Verdict

RED — the redeem mechanics are generally careful, but two consequential
integration failures remain: redemption audit lines can be discarded, and
ordinary settings writes can overwrite concurrent engine changes. The most
important fix is to require all nested or collection-based settings updates to
compute from fresh state while holding the cross-process lock.

## Findings

### [HIGH] Locked object updates can still erase concurrent settings
- **Where**: `src/utils/settings/settings.ts:568`
- **What**: The lock protects only the fresh file read and final write; object-form
  callers may supply nested state computed before the lock. `Config.tsx:508`
  spreads a stale `settingsData.permissions` snapshot while changing
  `defaultMode`. If another engine process appends a permission rule before this
  writer acquires the lock, `mergeWith` replaces the stale arrays at lines
  582-586 and silently removes the new rule.
- **Fix**: Convert nested/collection read-modify-write callers to
  `SettingsUpdater` functions. Preferably reject collection-bearing object
  patches so future callers cannot accidentally bypass the concurrency
  guarantee.

### [HIGH] Config close paths discard successful-redemption audit records
- **Where**: `src/components/Settings/Settings.tsx:105`
- **What**: `Settings` accumulates redemption lines and preserves them through its
  own `closeSettings`, but `Config` receives the raw parent `onClose`. Trigger:
  redeem a reset, switch to Config, then press Escape or finish configuring.
  `Config.tsx:1164` or `Config.tsx:1256` closes the entire dialog without the
  redemption line, so a real quota-spending action disappears from the
  transcript.
- **Fix**: Centralize all Settings closure through a wrapper that accepts the
  child's message/options and appends any accumulated redemption audit lines.

### [MED] Failed settings migrations are permanently marked complete
- **Where**: `src/main.tsx:339`
- **What**: Both new migrations ignore the `{error}` returned by
  `updateSettingsForSource` (`src/migrations/migrateRetiredGptModelsToGpt56.ts:51`,
  `src/migrations/migrateRetiredClaude46ModelsToClaude5.ts:49`), while
  `runMigrations()` unconditionally records version 14. If the settings lock
  remains unavailable past its retry window, or the file cannot be written,
  startup still advances the migration version and never retries that migration.
  Retired model selections or overrides can therefore remain persisted
  indefinitely.
- **Fix**: Make synchronous migrations propagate write failure and save
  `CURRENT_MIGRATION_VERSION` only after every required migration succeeds. Add a
  production-path test where a migration write returns an error.

### [MED] Shared settings can fall back to truncate-then-write
- **Where**: `src/utils/settings/settings.ts:596`, falling back to `src/utils/file.ts:453`
- **What**: The selected helper normally uses a temporary file and rename, but on
  any atomic-path failure it explicitly performs a direct write. If rename or
  temporary-file preparation fails while the direct write succeeds, concurrent
  readers can observe partial JSON; interruption during that fallback can leave
  the shared settings file truncated. The normal path also lacks the directory
  fsync used by the repository's stronger persistence implementation.
- **Fix**: Use the `atomicWriteJson` durability pattern from
  `codexTokenRefresh.ts` (temporary file, file fsync, rename, directory fsync)
  and fail safely instead of reverting to in-place writing.

### [LOW] The critical retry-id test is tautological
- **Where**: `src/components/Settings/redeemResetMachine.test.ts:382`
- **What**: The test assigns one variable to `firstAttempt` and `retryAttempt`,
  then asserts equality; it never exercises `Reset` or its retry transition. A
  regression that mints a new UUID on "Try again", posts after a
  reauthentication failure, or reorders success auditing would still pass. The
  module is also named a state machine despite containing no state or transition
  logic, which overstates what its focused tests cover.
- **Fix**: Add a `Reset` component/integration test covering confirm → network
  error → retry with the same UUID, reauthentication → no POST, and success
  audit ordering. Rename the module to a helpers/policy module unless
  transitions are moved into it.

## What is good here

- Settings precedence correctly uses `getEnabledSettingSources()` at
  `src/utils/settings/settings.ts:936`.
- The updater form reads fresh state and invokes the transformation under the
  cross-process lock; the contention probe validates this using separate
  processes.
- The redeem flow defaults confirmation to Cancel, refreshes and re-resolves the
  target account, preserves the request UUID across retries, and
  heals/invalidates/refetches after success.
- Migration wiring is complete: both files are imported, positioned in
  `runMigrations()`, and accompanied by a migration-version bump.
- Candidate construction and backend outcome mapping are isolated into small,
  deterministic helpers with exhaustive focused tests.

## Not reviewed / uncertain

- No live redemption request was sent, so backend billing/quota behavior and
  production response variations were not exercised.
- No GUI verification or full build/typecheck was run in the shared dirty tree.
  Focused runs passed: 34/34 Settings and contention tests, 149/149
  reset/API/account tests, 12/12 migration tests.
- Representative unsafe settings callers were verified, but not every
  `updateSettingsForSource` call site was inventoried for stale nested objects or
  precomputed arrays.
- No files or git state were modified.

## Lead re-verification note

The HIGH at `settings.ts:568` was re-checked in source independently. It holds,
and is arguably under-rated as written: the `mergeWith` customizer's own comment
states "For arrays, always replace with the provided array — This puts the
responsibility on the caller to compute the desired final state", while the
*updater* branch four lines above carries a comment naming this exact hazard
("a state computed before this call could be stale relative to another process's
write"). The object form is the same lost-update shape as the historical
`persistPermissionUpdates` incident, reachable through a different call form.

The "what is good" entry on settings precedence concerns the ENGINE side, which
was not in dispute. The separately-reported divergence is that the DESKTOP's
`app/renderer/src/settingsState.ts` mirrors `SETTING_SOURCES` rather than the
engine's effective `getEnabledSettingSources()` order. This entry confirms the
engine is the correct reference; it does not retire that finding.
