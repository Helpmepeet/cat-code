# X02b — unwired features, migrations, dead exports

## Verdict

The wiring machinery in this repo is in good shape: the feature build-list has **zero**
orphan names, both migrations added on this branch are wired through all four steps and
are guarded by an explicit source-text tripwire test, `package.json` script targets all
exist, and there are no unresolved imports or broken in-repo `file:line` citations. The
weakness is on the other side of the ledger — **exports that survive only because a test
imports them**. The single most important thing to fix is
`abandonForegroundDeferredAttempt` (`src/services/deferredContinuationRunner.ts:460`): it
exists specifically to prevent a cross-process lock leak that its own comment describes,
and it has zero production call sites, so the leak it guards against is unguarded. Beyond
that, one whole renderer file and one whole renderer state module are dead, and three
state selectors that encode a documented rule sit unused while production re-derives (or
skips) that rule inline.

## Findings

### [HIGH] The deferred-continuation lock-leak guard has zero call sites

- **Where**: `src/services/deferredContinuationRunner.ts:460` (`abandonForegroundDeferredAttempt`); leak site `src/hooks/useDeferredContinuation.ts:146-167`; only settle site `src/screens/REPL.tsx:3396`
- **Type**: correctness / dead-code
- **What**: `beginForegroundDeferredContinuation` acquires both deferred-continuation
  lockfiles and releases them *only* when `registration.result` resolves
  (`:714-720`, `finally { await guard.release() }`). That promise is resolved by exactly
  two functions: `settleForegroundDeferredAttempt` (called once, from the REPL's `onQuery`
  `finally`) and `abandonForegroundDeferredAttempt`, which nothing calls.
- **Trigger / why it matters**: `useDeferredContinuation` enqueues the continuation command
  (`:146`) with `priority: 'later'` and then returns a cleanup that only sets
  `canceled = true` and clears a timer (`:164-167`). The effect's dep array is
  `[activeSessionId, setMessages]`, so a session switch re-runs it. If the queued command
  is dropped before it reaches `onQuery`'s `finally` — session switch, queue reset, app
  teardown — the registration is never settled, `guard.release()` never runs, and the
  process holds both lockfiles for its remaining lifetime. The recovery path then spins
  forever: `useDeferredContinuation:96-106` polls `reconcileDeferredContinuationJob` every
  1s and swallows the failure with the comment *"A live foreground/background owner still
  holding the locks is expected. Retry until it settles"* — but with no abandon call, it
  never settles. The user-visible end state is a session whose automatic continuation is
  permanently stuck. The function's own comment states the failure exactly: *"would leave
  `beginForegroundDeferredContinuation`'s awaiter pending forever, holding both filesystem
  locks for the process lifetime."*
- **Fix**: call `abandonForegroundDeferredAttempt(attempt.command.origin)` from the
  `useDeferredContinuation` effect cleanup when `attempt.finished` has not settled.
- **Note**: may overlap with the S01-deferred-continuation scope; reported here because
  it surfaced as a zero-call-site export.

### [MED] `WorkspaceTrustSection.tsx` is a 93-line file no one imports

- **Where**: `app/renderer/src/WorkspaceTrustSection.tsx:14`
- **Type**: dead-code / parity
- **What**: The file's single export is imported by **no** production file and **no** test.
  Verified two ways: symbol grep across `src/`, `app/`, `scripts/`, `web/`, and a
  whole-file importer sweep. Only `docs/` mentions it (11 files).
- **Trigger / why it matters**: This is the P4-14 "Settings → Workspace" section — trust
  badge, detected repo, additional trusted directories. It is fully built against the real
  `workspace-trust.snapshot` seam and the user never sees it. The seam data itself *is*
  live (`MetadataInspector.tsx:338` reads `state.workspaceTrust`), so this is a mounting
  gap, not a data gap. Same class as the previously-caught built-but-unwired trio.
- **Fix**: mount it in the settings shell, or delete the file and record the cut.

### [MED] `bannerStackModel.ts`: whole module alive only for its test

- **Where**: `app/renderer/src/bannerStackModel.ts:4,15,22` (`upsertBanner`, `dismissBanner`, `useBannerStack`)
- **Type**: dead-code / testability
- **What**: All three exports are imported only by `app/renderer/src/BannerStack.test.tsx`.
  Production never imports the module: `App.tsx:1393-1396` derives a **0-or-1 element**
  array (`accountHealthBanner ... : EMPTY_BANNERS`) and passes it straight to
  `<BannerStack banners={...}>` (`App.tsx:3398`).
- **Trigger / why it matters**: the test asserts stack semantics production cannot reach —
  *"upsertBanner appends a new id to the bottom of the stack"*, *"replaces an existing id in
  place (no duplicate)"*, *"removes the addressed banner only"*. A green suite reads as
  "multi-banner dedupe is covered" when the rendered stack is structurally capped at one.
- **Fix**: either route the account-health banner through the model so the tested path is
  the shipped path, or delete the module and its test.

### [MED] `selectTranscriptDisplayItems` is dead and its composition differs from production

- **Where**: `app/renderer/src/transcriptProjector.ts:797`
- **Type**: dead-code / naming
- **What**: Only `transcriptProjector.test.ts` imports it. Production composes the pieces
  itself: `TranscriptView.tsx:205` calls `selectNestedTranscriptRows`, and `:298` calls
  `groupDisplayItems(groupAgentDelegates(rows), reasoningMode)`.
- **Trigger / why it matters**: the dead wrapper is `groupAgentDelegates(selectNestedTranscriptRows(...))`
  with **no** `groupDisplayItems`/`reasoningMode` step. So the exported symbol named
  "the transcript display items" produces a different list from the actual display items,
  and its doc comment ("Read-time transcript display list") asserts otherwise. Any test
  written against it cannot catch a reasoning-grouping regression.
- **Fix**: delete the wrapper, or make it the single composition `TranscriptView` calls.

### [MED] Desktop sidecar runs the engine with 1 feature; the CLI build ships 38

- **Where**: `app/main/mainDecisions.ts:41-44` (`SIDECAR_RUNTIME_ARGS`), pinned by
  `app/main/mainDecisions.test.ts:30-33`; compare `scripts/build.ts:13-50,82` and
  `package.json` `build:dev:full` (`--feature-set=dev-full`)
- **Type**: design / convention
- **What**: `cli-dev` is built with `defaultFeatures` + `fullExperimentalFeatures` = 38
  names. The sidecar — which runs the *same* engine — is spawned with exactly
  `--feature=TRANSCRIPT_CLASSIFIER`. The comment at `app/main/main.ts:635-637` says it
  "runs the same default classifier feature as the engine bundle", which is true and
  deliberate; `docs/maps/web-app-runtime.md:36` records the intent.
- **Trigger / why it matters**: the consequence is not recorded anywhere. Concretely,
  `src/constants/prompts.ts:838-852` adds a `token_budget` system-prompt section under
  `feature('TOKEN_BUDGET')`; that name is in `dev-full` but not in the sidecar's args, so
  **the desktop app and the CLI send different system prompts for the same session**.
  `CACHED_MICROCOMPACT` (`prompts.ts:83,1180`, `microCompact.ts:276`) and
  `PROMPT_CACHE_BREAK_DETECTION` (`microCompact.ts:362,525`) diverge the same way, and
  `contextBreakdownDomain.ts` calls `microcompactMessages` directly. This is exactly the
  "app/ and src/ silently disagree" class the repo watches for.
- **Fix**: no code change implied — record the intended sidecar feature set (and the
  prompt-level consequence) next to `SIDECAR_RUNTIME_ARGS`, so the divergence is a
  decision rather than an accident of two build paths.

### [MED] The dead hidden-workspaces reducer is the variant the module documents as wrong

- **Where**: `app/renderer/src/sidebarHiddenWorkspaces.ts:166` (`reduceHiddenWorkspacesCleared`)
- **Type**: dead-code
- **What**: Consumed only by `sidebarHiddenWorkspaces.test.ts`. Production uses the sibling
  `reduceHiddenWorkspacesShown` (`Sidebar.tsx:119,947`).
- **Trigger / why it matters**: the doc comment on the *live* sibling (`:172-180`) explains
  why the blunt "un-hide everything" behaviour is wrong: *"a search-narrowed render could
  read 'Show 1 hidden project' while its click cleared every hidden project."* The dead
  export is precisely that wrong behaviour, still exported, still green under its own test.
  A future caller reaching for the obvious name reintroduces the documented bug.
- **Fix**: delete it, or rename it so the blast radius is in the name.

### [MED] `selectWritableSelection` is dead while its predicate is re-derived three times

- **Where**: `app/renderer/src/sessionsPageState.ts:191`; duplicates at
  `app/renderer/src/SessionsPage.tsx:236`, `:443`, `:604`
- **Type**: duplication / dead-code
- **What**: The selector exists with a doc comment stating the rule ("Rename / Export /
  Branch / Tag all run inside a session's OWN live engine ... a selection that includes
  closed sessions writes only to the live part of it"). `SessionsPage.tsx` imports
  `selectKnownTags` from the same module (`:70,200`) but not this one, and inlines
  `row.live && row.appSessionId != null` at three sites instead.
- **Trigger / why it matters**: behaviour is currently correct — this is not a missing
  guard. The cost is that the rule now lives in four places, only one of which is tested.
  If "writable" ever widens (e.g. a restorable-but-closed row becomes writable), the
  selector and its test stay green while the three inline copies are the ones that matter.
- **Fix**: have `SessionsPage.tsx` call `selectWritableSelection` at all three sites.

### [MED] `selectSettingField` dead: the settings panel reads values but never their resolution

- **Where**: `app/renderer/src/settingsState.ts:76`
- **Type**: dead-code
- **What**: Only `settingsState.test.ts` imports it. Its immediate sibling
  `selectEditableValue` (`:91`) *is* live (`SettingsShell.tsx:122,862`).
- **Trigger / why it matters**: the doc comment calls it "the lookup every `Field` in a
  panel makes" — the winning source plus editable/managed status. Nothing makes that
  lookup, so the managed/editable state it was written to drive is not surfaced by the
  panel, even though the snapshot carries it and `SourceBadge` exists to render it
  (`MetadataInspector.tsx:433,454` uses `SourceBadge` for a different surface).
- **Fix**: wire it into the settings `Field` rows, or delete it and record the deferral.

### [MED] Two prototype components built and never mounted

- **Where**: `app/renderer/src/SettingsField.tsx:223` (`ResolutionOrderLegend`),
  `app/renderer/src/AgentChrome.tsx:137` (`AgentStateWord`)
- **Type**: dead-code / parity
- **What**: `ResolutionOrderLegend` renders the settings "Resolution order:" legend from
  the prototype's `Settings.jsx`, built on the real `SETTING_SOURCE_PRECEDENCE`; it is
  imported only by `SettingsField.test.tsx`. `AgentStateWord` (P4-32b, the prototype's
  compressed lifecycle word) is imported by nothing at all — not even a test. Both have
  live siblings in the same files (`SourceBadge`, `AgentStateLabel` at
  `TranscriptView.tsx:1862`), which is what makes them easy to miss.
- **Trigger / why it matters**: prototype-parity elements that exist in code but not on
  screen read as "built" in any grep-based audit while the user sees nothing — the silent
  parity cut the program rules forbid.
- **Fix**: mount or record as a tagged cut.

### [MED] Coordinator Mode is compiled out of every build this repo can produce

- **Where**: `src/coordinator/coordinatorMode.ts:41-46`, gate registered at
  `src/tools.ts:135`; ~35 `feature('COORDINATOR_MODE')` sites incl. `src/main.tsx:78,79`,
  `src/tools/AgentTool/AgentTool.tsx:581,920`, `src/utils/sessionRestore.ts:274,677,782`
- **Type**: dead-code
- **What**: `COORDINATOR_MODE` appears in neither `defaultFeatures` nor
  `fullExperimentalFeatures` (`scripts/build.ts:13-50,82`), so `isCoordinatorMode()`
  returns `false` unconditionally in `./cli`, `./cli-dev`, and the sidecar. Agent Mode is
  **not** affected — `isAgentMode()` (`src/agent-mode/agentMode.ts:39-41`) is a plain env
  check with no gate, and is checked *before* the coordinator gate at `:96-100`.
- **Trigger / why it matters**: this branch added `src/coordinator/coordinatorMode.test.ts`,
  which imports `getCoordinatorSystemPrompt` directly and so passes regardless of the gate.
  A subsystem no build can reach now has a green test asserting its prompt wording — the
  strongest form of "kept alive by its test".
- **Fix**: no code change needed if the omission is intentional; add `COORDINATOR_MODE` to
  the dev-full list if it is meant to be exercisable, and say which in one line near the
  test.

### [LOW] ~9 sidecar `createReal*` factories exported for no external consumer

- **Where**: `app/sidecar/accountsDomain.ts:254,489`, `agentModeDomain.ts:68`,
  `leaseDomain.ts:95`, `remoteSettingsDomain.ts:177`, `runControlsDomain.ts:114`,
  `sessionActionsDomain.ts:82`, `taskControlDomain.ts:49`, `workspaceTrustDomain.ts:80`
- **Type**: quality
- **What**: Each is used exactly once, inside its own file, as the `options.executor ??
  createRealXExecutor()` default. No other file — production or test — imports any of them.
- **Trigger / why it matters**: not dead code; the `export` keyword is the surplus. It
  widens each domain module's public surface past the "narrow interface" the sidecar domain
  convention asks for, and it is what made an automated referrer-sweep flag nine live
  functions as dead. Cheap to tighten.
- **Fix**: drop `export` from the ones no test needs.

### [LOW] Broad surplus-export surface across `app/`

- **Where**: worst case `app/renderer/src/settingsScope.ts` (1,133 lines, 46 exports, at
  least 7 with no consumer outside the file: `isSettingsScopeKind:75`,
  `settingsProjectLabel:159`, `normalizeProjectCwd:166`, `SETTINGS_RAIL_ITEM_IDS:235`,
  `isSettingsRailItemId:255`, `SETTINGS_LAYER_PHRASE:1021`, `SETTINGS_WRITE_TARGET_LABEL:1101`)
- **Type**: quality
- **What**: 454 exported symbols across `app/renderer/src`, `app/sidecar`, `app/shared`,
  `app/host` have no consumer in any other production file. Most are genuinely used inside
  their own module (so not dead), but the export makes every one of them a public API.
- **Trigger / why it matters**: it is the reason a dead-export sweep on this repo returns
  475 raw candidates that collapse to ~20 real ones. Each surplus export is a maintenance
  claim nobody is making.
- **Fix**: not worth a sweep; worth applying to new code and to `settingsScope.ts` if it is
  touched for other reasons.

### [LOW] `isSettingsScopeKind` has no consumer anywhere

- **Where**: `app/renderer/src/settingsScope.ts:75`
- **Type**: dead-code
- **What**: A type guard with zero references — not in its own file, not in its test, not
  in production. Distinct from the surplus-export cluster above.
- **Fix**: delete.

### [LOW] Three exported types with zero references

- **Where**: `app/shared/protocol.ts:1384` (`AgentModeVerbType`),
  `app/renderer/src/sessionsPageState.ts:28` (`SessionsPageAnchor`),
  `app/renderer/src/shellState.ts:239` (`selectSession`, a runtime accessor consumed only
  by `shellState.test.ts`)
- **Type**: dead-code
- **What**: `AgentModeVerbType` is derived from the live `AGENT_MODE_VERB_TYPES` allowlist
  and nothing consumes the derived type; `protocol.ts` is a designated care-file, so an
  unused type there is worth pruning rather than accumulating.
- **Fix**: delete all three.

### [LOW] `reducePasteRemoved` — composer state (already reported)

- **Where**: `app/renderer/src/composerState.ts:169`
- **Type**: dead-code
- **What**: Consumed only by `composerState.test.ts`. Folded into totals here; the composer
  dead-export cluster was already found by the per-scope agent.

## What is good here

- **The migration wiring tripwire is the right shape.**
  `src/migrations/migrateRetiredClaude46ModelsToClaude5.test.ts:232-252` reads `main.tsx`
  as *text* and asserts the import line, the call inside `runMigrations`, and the
  `CURRENT_MIGRATION_VERSION` gate/bump — all four steps, including the one a normal unit
  test structurally cannot see (a migration that runs correctly but is never invoked
  because the version was not bumped). Both migrations added on this branch are correctly
  wired (`main.tsx:188,189,346,347`, version 11 → 14), and the ordering is safe: the
  migrations that run *after* the 4.6-retirement write aliases (`sonnet`, `opus[1m]`), not
  retired explicit IDs, so nothing resurrects a retired model.
- **The feature build-list has zero orphans.** Every one of the 38 names in the `dev-full`
  set has at least one live `feature(...)` call site. That direction of the audit is
  perfectly clean, which is unusual.
- **`app/sidecar/engineTypeDriftCheck.ts` is a tripwire that *looks* dead and is not.**
  Nothing imports it and it exports a single unused type, so every referrer-grep flags it —
  but it is a compile-time `Assert<IsMutuallyAssignable<...>>` tuple, and
  `app/sidecar/tsconfig.json` includes `./**/*.ts`, so the sidecar typecheck wrapper (which
  fails on owned-file diagnostics) is what fires it. Worth keeping as the canonical example
  of why this sweep must read before deleting.
- **`SessionActionIcon`'s closed-union tripwire documents its own bug history**
  (`app/renderer/src/SessionActionIcons.tsx:26-33`): the `default: never` arm replaced a
  bare `return null`, "which is exactly how `copy-text` shipped with an empty icon slot".
  A convention with a scar attached is one people keep.
- **Stale references are clean.** All 12 `package.json` script targets exist; the 87
  branch-added `src/` files have zero unresolved relative imports; and every in-repo
  `file.ts:line` citation in comments resolves (the only "missing" hits are `.jsx`
  prototype anchors, which live outside the repo by design, plus grep-test fixture paths).

## Not reviewed / uncertain

- **Prototype `.jsx` citation accuracy.** ~200 comment anchors point at
  `~/catcode_prototype/cat-app/*.jsx` line numbers. The prototype is outside the repo and
  read-only, so I verified only that these are intentional (they are — CLAUDE.md §2 states
  the anchors are ~83% exact routing hints). Whether any individual line number still
  matches would need the prototype tree.
- **Direction B of the feature audit, in full.** 51 `feature(...)` names have call sites
  but no build-list entry (largest: `KAIROS` 156 sites, `PROACTIVE` 38, `COORDINATOR_MODE`
  35, `CONTEXT_COLLAPSE` 24, `EXPERIMENTAL_SKILL_SEARCH` 24). I verified these are
  inherited upstream Claude Code features this fork does not enable, and only pursued the
  ones this branch touched. I did **not** confirm for each of the 51 that the omission is
  intentional rather than a name that was renamed on one side. Full list at
  `/private/tmp/claude-501/.../scratchpad/feats.json` if that matters.
- **The 176 "surplus export + own test" symbols.** These are used inside their own module
  *and* imported by their test. I sampled rather than read all of them, so there may be a
  few more cases like `reduceHiddenWorkspacesCleared` (in-file mention is only a doc
  comment, actual use is zero) hiding in that set. Resolving it needs a real
  import-graph/AST pass rather than a name grep; I flagged this specifically because my
  first automated pass produced ten false "dead" claims on
  `SessionActionIcons.tsx` alone before I checked in-file usage.
- **Overlap with sibling scopes.** `abandonForegroundDeferredAttempt` may also appear in
  S01-deferred-continuation, and `selectSettingsProjectBinding`
  (`app/renderer/src/settingsProjectBinding.ts:89`, test-only, verified dead) is very
  likely one of the "3 unwired modules in renderer settings/misc state" A17 already
  reported, so I folded it rather than re-reporting it.
- **Referrer-greps cannot see documentary wiring.** Every "dead" claim above was also
  checked against `docs/`, `docs/migration/`, decision docs, backlog files, `.claude/`, and
  `package.json` before being reported. `engineTypeDriftCheck.ts`, `vite-env.d.ts`, the
  `Action*Icon` set, and the nine `createReal*` factories were all caught by the automated
  sweep and **cleared by reading**; none of them should be deleted.
