# S06 adversarial validation: engine settings, usage, reset flow

> **Verification provenance:** Opus 5 (`claude-opus-5`) at high effort. Read-only
> source review plus five standalone scratch scripts run against the real repo
> modules (`src/utils/settings/settings.ts` imported live against a temp
> `CLAUDE_CONFIG_DIR`; `src/utils/file.ts` exercised against a read-only
> directory; the real `useKeybinding` + Ink `render` used to measure input
> listener ordering). No repo file edited except this report. No test suite run
> (`redeemResetMachine.test.ts` was read, not executed — the finding is about
> what it does *not* assert, which running it cannot show). No GUI, no dev
> server, no live redemption request. Branch `migration` at `a1012b1`.

## Overall verdict

The report is **substantially right on mechanism and consistently over-graded on
consequence**. Its HIGH#1 — the surviving pillar of the review's "unsafe shared
state writes" thesis — I attacked with a runtime repro rather than a re-read, and
it **reproduces on the first attempt**: a permission rule appended by a second
writer between the caller's snapshot and the locked write is gone from disk
afterwards. I then ran the same interleaving through the *updater* form as a
control; the rule survives. So the finding is not "there is a lock, therefore it
is fine" hand-waving in either direction — the two call forms measurably differ.
HIGH#1 stands, and it is **under**-rated in a way the report missed: the same
line writes the *merged, cross-source* permission arrays into `userSettings`, so
a project-scoped `allow` rule is promoted to a global user rule **with no
concurrency at all**. I reproduced that too.

**HIGH#2 is half wrong.** The Escape trigger it leads with does not lose the
audit line: `Settings`' `confirm:no` listener is registered before `Config`'s in
every ordering that can follow a redemption, so `closeSettings()` — the handler
that *does* emit the lines — consumes the key. I proved the ordering rule with a
live Ink probe (parent-first when the child mounts later or remounts; child-first
only on a shared first commit, which a redemption cannot precede). What survives
is the *other* half the report also cites: Enter / save-and-close at
`Config.tsx:1164`, which Settings does not bind at all. And the severity is
wrong: the lost artifact is a transcript display line, not the credit record —
`applyRedeemedUsageReset` and the in-dialog success message are unaffected.

The two MEDs split: the migration one is **OVERSTATED** ("permanently" is false —
every `CURRENT_MIGRATION_VERSION` bump re-runs the whole set, and this branch
bumped 11→14 by itself; and the stale on-disk model string is remapped at runtime
anyway), while the truncate-then-write fallback is **CONFIRMED** and, per the
coordinator's warning about the sibling `settingsSync` refutation, is explicitly
**not** dead code behind an unregistered flag — I made it fire. The LOW is exact.

**Attribution: only HIGH#2 and the LOW are branch-new.** HIGH#1's defective call
form, the unconditional migration-version save, and the `file.ts` fallback are all
byte-identical on `main`. Notably, HIGH#1 is a *documented* hazard on this branch:
`settings.ts:424-429` and `:473-479`, written by the P3-8 lock work, name this
exact failure and say callers must use the updater form. `Config.tsx:508` is a
caller that was not converted.

The single thing most deserving action is HIGH#1, and the cheapest correct fix is
narrower than the report's.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Locked object updates still erase concurrent settings | **CONFIRMED** | Reproduced: peer's rule gone from disk; updater-form control keeps it. Escalates — merged cross-source arrays leak with no race at all |
| F2 | HIGH | Config close paths discard redemption audit records | **PARTIALLY CONFIRMED** | Enter/`:1164` loses them; Escape/`:1256` does not — Settings' earlier listener wins (proved). Severity is LOW, not HIGH |
| F3 | MED | Failed migrations permanently marked complete | **OVERSTATED** | Unconditional save is real and pre-existing house style; "permanently" false (next version bump re-runs all), consequence cosmetic (runtime remaps) |
| F4 | MED | Settings can fall back to truncate-then-write | **CONFIRMED** | Not flag-gated; I made the fallback fire and observed the in-place truncating write |
| F5 | LOW | The critical retry-id test is tautological | **CONFIRMED** | `:382-387` asserts `id === id`; no `Reset` component test exists anywhere |

---

## Per finding

### F1 — [HIGH] Locked object updates can still erase concurrent settings

- **Verdict**: **CONFIRMED** — and under-rated.
- **Cited location holds?**: Yes (re-verification of the source text was
  explicitly out of scope; I confirmed the line numbers only in passing).
  `src/utils/settings/settings.ts:568` is the `mergeWith(existingSettings || {}, settings, …)`
  object branch, with the array customizer at `:582-586`;
  `src/components/Settings/Config.tsx:508` is the `updateSettingsForSource('userSettings', { permissions: { ...settingsData?.permissions, defaultMode } })`
  call.
- **Reachable in production?**: Yes, ungated. `updateSettingsForSource` has no
  env gate, no `feature()` call, and `Config.tsx`'s `defaultPermissionMode` row is
  built unconditionally (`Config.tsx:490-539`; only the *option list* consults
  `feature('TRANSCRIPT_CLASSIFIER')`, not the row's existence). The `/config`
  dialog is the ordinary way to reach it.
- **Trigger**: **Proven with a scratch script importing the real module**
  (`scratchpad/v26/h1-repro.ts`, run with a temp `CLAUDE_CONFIG_DIR`):

  ```
  [a] Config mount snapshot .permissions = {"allow":["Bash(ls:*)"],"defaultMode":"default"}
  [b] peer process appended: disk allow  = ["Bash(ls:*)","Bash(git status:*)"]
  [c] updateSettingsForSource error = null
  [d] disk after = {"permissions":{"allow":["Bash(ls:*)"],"defaultMode":"plan"}}
  >>> RULE ERASED — claim CONFIRMED
  ```

  Step (a) is literally what `Config.tsx:101` stores
  (`useState(getInitialSettings())`); step (c) is literally `Config.tsx:508`.
- **The staleness question, answered**: `settingsData` is captured **once, at
  `Config` mount**, and is never re-read from disk for that mount's lifetime.
  There is no refresh path: `applySettingsChange` (the settings-watcher consumer)
  feeds `AppState`, not `Config`'s component-local `useState`, and internal writes
  suppress the watcher anyway (`Config.tsx:555-557` says so). The window is
  narrowed — but not closed — by `Tab` unmounting non-selected children
  (`Tabs.tsx`: `if (selectedTab !== (id ?? title)) return null`), so switching
  away and back re-snapshots. The residual window is "however long the user sits
  on the Config tab", which for a scrolling settings list is unbounded.
- **Counter-arguments considered**:
  1. *Is `settingsData` re-read, or React state refreshed first?* No — see above.
     `setSettingsData` at `:523` mutates only local state, after the disk write.
  2. *Does the customizer even apply to this shape?* Yes — proven above; the
     `allow` array was replaced wholesale.
  3. *Does the lock save it?* No. This is the exact case the lock's own comment
     excludes: `settings.ts:424-429` — *"this lock alone does not fix the
     lost-update race … a caller that pre-computes an array from a pre-lock read
     still clobbers the other process's write"*. I did not take that on faith: I
     ran the **same interleaving through the updater form**
     (`scratchpad/v26/h1c-updater.ts`) and the peer's rule survives —
     `{"allow":["Bash(ls:*)","Bash(git status:*)"],"defaultMode":"plan"}`. The two
     forms measurably differ; the clean bill on the updater form is earned, and
     the object form is genuinely broken.
  4. *Is `setMode` in `PermissionUpdate.ts:339` the same bug?* No, and it is worth
     not flagging: it passes `{ permissions: { defaultMode } }` with **no arrays**,
     so lodash deep-merges and nothing is replaced. `replaceRules` at `:352` does
     pass an array, but "replace all rules" is its contract.
  5. *Is a second engine process writing permission rules realistic?* Yes — that
     is the whole premise of the N-process desktop model, and
     `persistPermissionUpdate`'s `addRules` path (always-allow) is the writer. The
     `settingsWriteContention` probe exists because this exact race was
     **observed live** in the P3-5a GUI run.
- **What the report missed — this fires with no race at all.** `getInitialSettings()`
  is the **merged effective** settings across every enabled source
  (`settings.ts:912-915` → `getSettingsWithErrors` → `loadSettingsFromDisk`, which
  merges `getEnabledSettingSources()` at `:774`). So `Config.tsx:508` writes
  *project/local/policy* permission arrays into `userSettings`. Reproduced
  (`scratchpad/v26/h1b-merged-leak.ts`), with a project `.cat-code/settings.json`
  present and zero concurrency:

  ```
  user file before = {"permissions":{"allow":["Bash(ls:*)"]}}
  user file after  = {"permissions":{"allow":["Bash(ls:*)","Bash(rm -rf /tmp/x:*)"],
                                     "deny":["Read(./secrets/**)"],"defaultMode":"plan"}}
  ```

  A rule the user scoped to one project is now a global user rule that follows
  them into every other repo. The code knows: `Config.tsx:1211-1214` documents the
  leak and tries to undo it — but only inside `revertChanges()`, i.e. only on the
  Escape path, so pressing Enter (or leaving the dialog any other way) persists it.
- **Branch-new?**: **No.** `git blame -L 504,513 -- src/components/Settings/Config.tsx`
  → root commit `86051a8`; the `mergeWith` array customizer is likewise from
  `86051a8`; `git show main:src/utils/settings/settings.ts` has neither the lock
  nor the `SettingsUpdater` form, so the branch's contribution here (`9487ed3`
  "migration(P3-8 rider): fix settings-write lost-update race", plus `20fdf1a`)
  is a *partial* fix that documented this call form and left it unconverted.
- **True consequence**: (a) with a concurrent writer, a permission rule the user
  just approved in another session is silently deleted when they change the
  default permission mode; (b) with no concurrency at all, project- and
  policy-scoped allow/deny rules are promoted to user scope. (b) is the more
  likely and the more security-relevant of the two.
- **Evidence**: `scratchpad/v26/h1-repro.ts`, `h1b-merged-leak.ts`,
  `h1c-updater.ts` and their outputs above; `settings.ts:424-429,473-479,568-590,774,912-915`;
  `Config.tsx:101,490-539,1211-1221`.
- **Disposition** — take the first half of the report's fix, **not** the second.
  Convert `Config.tsx:508` to the updater form, and make it write only what it
  owns:

  ```ts
  updateSettingsForSource('userSettings', current => ({
    ...current,
    permissions: { ...current?.permissions, defaultMode: validatedMode },
  }))
  ```

  That fixes both halves at once: the updater's `current` is the fresh
  **per-source** read, so neither the peer's rule nor the cross-source leak can
  happen, and `revertChanges`' compensating `permissions` spread at
  `Config.tsx:1217-1220` can then be dropped as dead.
  **Do not take** "reject collection-bearing object patches so future callers
  cannot bypass the guarantee" as written — it would break
  `PermissionUpdate.ts:352` `replaceRules`, whose whole contract is a
  caller-computed array, and `marketplaceManager.ts` / `pluginOptionsStorage.ts`
  patches. If a guard is wanted, make it a lint rule or a dev-mode warning naming
  the updater form, not a runtime rejection.

### F2 — [HIGH] Config close paths discard successful-redemption audit records

- **Verdict**: **PARTIALLY CONFIRMED** — one of the two cited close paths is
  wrong, and the severity is over-graded by two levels.
- **Cited location holds?**: Yes for all three lines. `Settings.tsx:105` is
  `<Config context={context} onClose={onClose} …/>` — the **raw parent**
  `onClose`, not `closeSettings` (`:68-75`), which is the only function that joins
  `redeemedLines`. `Config.tsx:1164/1166` is `handleSaveAndClose`'s
  `onClose(formattedChanges.join('\n'))` / `onClose('Config dialog dismissed', …)`.
  `Config.tsx:1256` is `handleEscape`'s `onClose('Config dialog dismissed', …)`.
- **Reachable in production?**: The Reset tab renders only when
  `hasAnyPoolAccount()` (`Settings.tsx:115`), i.e. a Codex account exists. No other
  gate.
- **Trigger — the Escape half does NOT fire.** Both `Settings` and `Config`
  register `confirm:no` in context `'Settings'`, and `useKeybinding` resolves
  through `useInput`, whose listeners run in **registration order** with
  `stopImmediatePropagation` cutting the rest (`src/ink/events/emitter.ts:21-35`;
  `use-input.ts:62-68` deliberately registers once on mount so the slot is
  stable). I measured the ordering with the real hooks and a real Ink render
  (`scratchpad/v26/h2order2.tsx`; handlers return `false` so both are observed):

  ```
  A. child mounts with parent  : ["CHILD(Config)","PARENT(Settings)"]
  B. child mounts 40ms LATER   : ["PARENT(Settings)","CHILD(Config)"]
  C. child unmounts + REMOUNTS : ["PARENT(Settings)","CHILD(Config)"]
  ```

  Only case A puts Config first, and case A cannot follow a redemption: reaching
  the Reset tab unmounts `Config` (`Tabs.tsx` `Tab` returns `null` when
  unselected), so returning to Config always re-registers it **last** — case C.
  If the dialog opened on Status or Usage, it is case B. Either way
  `Settings.handleEscape` → `closeSettings()` runs first and **does** emit the
  redemption lines, then stops propagation. `Settings`' `isActive` gate
  (`:89-95`) is satisfied at that moment: `configOwnsEsc` is
  `isSearchMode && !headerFocused` (`Config.tsx:193-196`), and Config's own
  Escape binding requires `!isSearchMode && !headerFocused` — the two are mutually
  exclusive, so whenever Config's handler is eligible, Settings' is too, and
  Settings is earlier.
- **Trigger — the Enter half DOES fire.** `Config` binds `settings:close`
  (`enter`, per `defaultBindings.ts:123`) to `handleSaveAndClose`
  (`Config.tsx:1270-1273`). `Settings` binds **no** `settings:close` handler, so
  there is no earlier listener to win. Concrete sequence: redeem on Reset →
  Tab/→ to Config → ↓ (blurs the tab header) → Escape (exits Config's search
  mode) → Enter. `onClose('Config dialog dismissed', {display:'system'})` fires
  and `redeemedLines` dies with the component.
- **Counter-arguments considered**: (a) *Does `ChordInterceptor` dispatch first
  and change the picture?* No — it invokes registry handlers only when
  `wasInChord` (`KeybindingProviderSetup.tsx:263-277`); a bare Escape is not a
  chord. (b) *Does `Tabs`' own `useKeybindings` swallow it?* No — it handles
  `tabs:next`/`tabs:previous`; on a `confirm:no` match `result.action in handlers`
  is false, so it does not stop propagation. (c) *Is there a third close path?*
  `rg -F "onClose(" Config.tsx` returns exactly `:1164`, `:1166`, `:1256` — no
  submenu path calls it. (d) *Is the line the actual credit record?* No — see
  below.
- **True consequence**: on the Enter/save-and-close path only, the transcript
  loses one system line, `Redeemed usage limit reset on <label> (N left)`
  (`redeemResetMachine.ts:53-57`). The credit itself is accounted server-side and
  locally by `applyRedeemedUsageReset` (`codexAccountPool.ts`), followed by
  `invalidateUsageCache()` and a forced `fetchPoolUsage` (`Reset.tsx:208-217`) —
  none of which depend on the line. The user also already saw an in-dialog
  success message (`Reset.tsx:226-229`). So this is a lost UI breadcrumb, not a
  lost record. **HIGH is wrong; LOW is right.**
- **Branch-new?**: Yes, in the sense that matters — `Reset.tsx` and
  `Settings.tsx`'s `redeemedLines` do not exist on `main`. The wiring that drops
  them (`onClose={onClose}` passed straight to `Config`) is pre-existing.
- **Evidence**: `scratchpad/v26/h2order2.tsx` output above; `Settings.tsx:68-75,89-95,101-111,115-125`;
  `Config.tsx:1163-1170,1249-1273`; `emitter.ts:21-35`; `use-input.ts:62-89`;
  `defaultBindings.ts:112,123`; `Tabs.tsx` `Tab`.
- **Disposition**: The report's fix (one wrapper that accepts the child's
  message/options and appends the accumulated lines) is the right shape and I
  would take it — pass `Config` a `handleChildClose = (result, options) => onClose(joinWithRedeemed(result), options)`
  instead of the raw `onClose`. It is a three-line change in `Settings.tsx` and it
  covers `:1164`, `:1166` and `:1256` uniformly, so it does not depend on the
  ordering analysis above being right. Re-grade to LOW.

  **Fix the ordering bug the report missed at the same time** (see the section
  below) — the two share one root cause: two components binding the same action
  in the same context with no defined precedence.

### F3 — [MED] Failed settings migrations are permanently marked complete

- **Verdict**: **OVERSTATED** — the mechanism is exactly as described; the
  consequence is not.
- **Cited location holds?**: Yes. `src/main.tsx:338-361` runs the eleven sync
  migrations then `saveGlobalConfig(prev => … migrationVersion: CURRENT_MIGRATION_VERSION)`
  at `:357`, with no success accounting. `migrateRetiredGptModelsToGpt56.ts:51`
  and `migrateRetiredClaude46ModelsToClaude5.ts:49` both call
  `updateSettingsForSource(...)` as a bare statement, discarding `{error}`.
- **Reachable in production?**: `runMigrations()` is called at `main.tsx:1003`
  (the Commander preAction hook), ungated. A failing write is constructible:
  `acquireSettingsLockSync` retries `ELOCKED` for 2 s
  (`SETTINGS_LOCK_RETRY_TIMEOUT_MS`, `settings.ts:411`) then rethrows, and the
  `catch` at `:611-617` turns it into `{error}`.
- **Counter-arguments considered — this is where it comes apart**:
  1. **"Permanently" is false.** `CURRENT_MIGRATION_VERSION` gates the *whole
     set*, so every bump re-runs every migration for every user. This branch alone
     went 11 (`main`) → 14. A migration that failed once gets another attempt the
     next time anyone adds a migration, which on this repo's cadence is weeks.
  2. **The consequence is cosmetic.** A retired model string left on disk is
     remapped at use time: `getUserSpecifiedModelSetting` applies
     `remapRetiredGptModel` (`model.ts:192`) and `parseUserSpecifiedModel` applies
     both remaps (`model.ts:640-647`). The migration exists to tidy the file, not
     to make routing correct.
  3. **The framing singles out the wrong code.** All eleven sync migrations
     discard the result the same way (`migrateSonnet45ToSonnet46.ts:49`,
     `migrateOpusToOpus1m.ts:40`, `migrateLegacyOpusToCurrent.ts:48`,
     `migrateSonnet1mToSonnet45.ts:33`, `migrateAutoUpdatesToSettings.ts:30`,
     `migrateBypassPermissionsAcceptedToSettings.ts:23`, …). The two new files
     follow house style; they did not introduce this.
  4. **A strictly larger silent-skip path is not mentioned.** If `settings.json`
     has a JSON syntax error, `getSettingsForSource('userSettings')` returns null
     and the migration's `if (settings)` guard skips it outright — no error is
     even produced to ignore — and the version still advances. Propagating
     `{error}` would not catch that one.
  5. *Branch-new?* Both migration files are branch-new (`8b5ce81`, `f1f0518`);
     the unconditional version save is pre-existing (`main` has the identical
     shape at version 11).
- **True consequence**: under lock starvation or a write failure during startup,
  one launch's tidy-up of `settings.json` is skipped and re-attempted at the next
  migration-version bump. Effective model resolution is unaffected throughout.
- **Evidence**: `main.tsx:335-366,1003`; `migrateRetiredGptModelsToGpt56.ts:22-66`;
  `migrateRetiredClaude46ModelsToClaude5.ts:49`; `model.ts:89-155,192,640-647`;
  `settings.ts:411-455,611-617`; `git show main:src/main.tsx`.
- **Disposition**: Do **not** take the report's fix as written — "save
  `CURRENT_MIGRATION_VERSION` only after every required migration succeeds" turns
  a cosmetic skip into an unbounded retry loop for a user whose settings file is
  permanently unwritable (locked-down `~/.cat-code`, read-only home), re-running
  all eleven migrations on every single launch forever. If anything is done here,
  make it observable rather than blocking: have the two new migrations log the
  `{error}` (they currently swallow it entirely) and emit the existing
  `tengu_atomic_write_error`-style telemetry, and leave the version bump
  unconditional. Re-grade to LOW.

### F4 — [MED] Shared settings can fall back to truncate-then-write

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, to the line. `settings.ts:596` is
  `writeFileSyncAndFlush_DEPRECATED(filePath, jsonStringify(updatedSettings, null, 2) + '\n')`.
  `src/utils/file.ts:453` is the `// Fallback to non-atomic write` comment
  immediately preceding `fsWriteFileSync(targetPath, content, fallbackOptions)`
  at `:469`, inside the `catch (atomicError)` block opened at `:439`. The
  characterisation is accurate: the happy path is temp-write → `chmod` →
  `renameSync` (`:423-437`), the catch unlinks the temp file and writes the
  target in place.
- **Reachable in production?**: **Yes — and specifically not the shape the
  sibling verifier refuted.** I checked for exactly that: `writeFileSyncAndFlush_DEPRECATED`
  is called unconditionally from `settings.ts:596` with no `feature()` guard
  anywhere on the path, the helper is a plain export used across `src/`, and the
  catch block carries live telemetry (`logEvent('tengu_atomic_write_error')`,
  `file.ts:443`) — which is not something you add to a branch you believe is
  unreachable. Contrast `settingsSync`, which V30 correctly killed because its
  whole write path sits inside `if (feature('DOWNLOAD_USER_SETTINGS'))` and that
  name is in neither list in `scripts/build.ts`. There is no equivalent gate here.
- **Trigger**: **Reproduced** (`scratchpad/v26/med2-fallback.ts`). A settings
  *directory* that is not writable while the settings *file* is: creating
  `${target}.tmp.<pid>.<ts>` fails `EACCES`, and the fallback's `O_TRUNC` open of
  the existing file needs write permission on the file only, so it succeeds:

  ```
  threw = no
  file after = "{\n  \"model\": \"new\",\n  \"keep\": \"me\"\n}\n"
  dir entries = ["settings.json"]
  >>> FALLBACK PATH TOOK EFFECT (non-atomic in-place write) — reachable
  ```

  Other live routes to the same branch: `ENOSPC` on the temp write, and on
  Windows a `renameSync` `EPERM` when the destination is held open by an editor
  or scanner — the code's own comment at `:434-435` flags Windows rename as the
  divergent case.
- **Counter-arguments considered**: (a) *Is the fallback narrower than the temp
  path, i.e. would it fail too?* Not always — the repro is precisely a case where
  the temp write fails and the in-place write succeeds, which is the exact
  combination the report names. (b) *Does `updateSettingsForSource`'s lock make
  the torn read moot?* No — the lock serialises *writers*; every reader
  (`parseSettingsFile`, `getSettingsForSource`) takes no lock at all, so a
  concurrent reader can see the truncated intermediate. (c) *Is the missing
  directory fsync a duplicate?* Partly — `X02a`/`V30`'s "eleven hand-rolled
  copies" finding already grades `file.ts:362` as the mode/symlink-preserving
  tier without a dir fsync. The *fallback* claim is new; `X02a`'s table row 11
  grades `settings.ts:596` "clean", which this correctly contradicts.
  (d) *Branch-new?* No — `git blame -L 439,477 -- src/utils/file.ts` is entirely
  root commit `86051a8`, and `main`'s copy has the fallback at the same line 453.
- **True consequence**: on a rename/temp-file failure, `settings.json` is
  truncated and rewritten in place with no atomicity and no dir fsync, so a
  concurrent reader can parse a partial file and an interruption leaves it
  truncated — at which point `updateSettingsForSource:537-547` refuses to
  overwrite (good) and every consumer reads the user's permission allowlist as
  absent (bad). Trigger set is narrow; the blast radius when it fires is not.
- **Evidence**: `scratchpad/v26/med2-fallback.ts` output above;
  `file.ts:362-478`; `settings.ts:537-547,596-599`;
  `rg -F "feature(" src/utils/file.ts` → no hits.
- **Disposition**: Take the report's fix in spirit but scope it. Adopting
  `codexTokenRefresh.ts`'s `atomicWriteJson` wholesale would **lose two
  guarantees `file.ts` has and it does not** — symlink resolution (`file.ts:373-383`)
  and mode preservation of an existing target (`:392,429-432`) — both of which
  matter for `settings.json` (dotfile-manager symlinks are common). The correct
  change is local: add the directory fsync to `file.ts`'s happy path, and delete
  the `catch` fallback so a failed atomic write **throws** and surfaces as
  `updateSettingsForSource`'s `{error}` instead of silently degrading. That is a
  behaviour change for every caller of the helper, so it should land with the
  X02a consolidation, not before it.

### F5 — [LOW] The critical retry-id test is tautological

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Exactly. `src/components/Settings/redeemResetMachine.test.ts:382-387`:

  ```ts
  test('reuse: holding one id across Try again keeps the same value', () => {
    const id = mintRedeemRequestId()
    const firstAttempt = id
    const retryAttempt = id
    expect(retryAttempt).toBe(firstAttempt)
  })
  ```

  It asserts `id === id`. `Reset` is never imported by the file.
- **Reachable in production?**: n/a — this is a coverage finding.
- **Trigger**: The regression the test claims to guard is
  `Reset.tsx:405-425` (`RetryView` → `onRetry(retry.target, retry.redeemRequestId)`)
  and `Reset.tsx:250-256` (the `retry` payload carrying the original id). Change
  either to `mintRedeemRequestId()` and this test still passes.
- **Counter-arguments considered**: (a) *Is the behaviour covered by another
  test?* No — `ls src/components/Settings/*.test.*` yields only
  `Settings.test.tsx` (which mocks `Reset` out entirely: `mock.module('./Reset.js', … <Text>Reset body</Text>)`),
  `Usage.test.tsx`, and this file. There is no `Reset.test.tsx`. (b) *Is the
  "state machine" naming complaint fair?* Yes — `grep '^export' redeemResetMachine.ts`
  yields copy constants, `confirmSubtitle`, `successWithCount`,
  `redeemedTranscript`, `confirmDescription`, `buildCandidates`,
  `isCandidateEnabled`, `selectDefaultCandidate`, `noEligibleReason`,
  `mintRedeemRequestId`, `mapConsumeOutcome`, `successMessage`. Zero state, zero
  transitions; the phase machine lives in `Reset.tsx`'s `useState`.
  (c) *Branch-new?* Yes — the file does not exist on `main`.
- **True consequence**: the reauthentication-no-POST path, the retry-id reuse, and
  the success-audit ordering are all untested, and the module name advertises
  coverage the tests do not provide.
- **Evidence**: `redeemResetMachine.test.ts:372-388`;
  `redeemResetMachine.ts:24-230`; `Settings.test.tsx:121-125`; `Reset.tsx:167-256,405-425`.
- **Disposition**: Take the fix, with a caveat the report does not raise: the
  three cases it wants (confirm → network error → retry with same UUID;
  reauth → no POST; success audit ordering) need a **DOM/interaction** harness,
  and `Settings.test.tsx` is SSR-only render-and-strip-ansi. Writing them as
  render tests will produce another set of assertions that cannot see interaction
  order. Either drive them through the Ink `render` + emitter path (the same
  technique used for this report's F2 probe) or extract the phase reducer out of
  `Reset.tsx` into `redeemResetMachine.ts` — which also earns the module its name
  — and unit-test the transitions. The rename is the cheaper half and should not
  be done alone.

---

## Re-derivation of the report's clean bills

All five re-checked; four stand, one is mis-cited, and one deserves a caveat the
report does not give.

1. **"Settings precedence correctly uses `getEnabledSettingSources()` at
   `settings.ts:936`"** — **substance holds, citation is the wrong function.**
   `:936` is `getSettingsWithSources()`, a `/status`-facing helper. The path that
   actually computes effective precedence is `getInitialSettings` (`:912`) →
   `getSettingsWithErrors` (`:956`) → `loadSettingsFromDisk`, whose loop is at
   **`:774`**. Both iterate `getEnabledSettingSources()`, so the conclusion is
   right. The lead's note that this concerns the engine and does not retire the
   desktop-side divergence is correct and I did not disturb it.
2. **"The updater form reads fresh state and invokes the transformation under the
   cross-process lock"** — **holds, and I proved it rather than inferring it from
   the lock's presence.** `settings.ts:507` `acquireSettingsLockSync` → `:518`
   `deleteCachedParsedFile` (without which the "fresh" read is a cached parse) →
   `:524` `getSettingsForSourceUncached` → `:562` `settings(existingSettings)`.
   Counter-repro in `h1c-updater.ts`: same interleaving as F1, peer rule survives.
3. **"The contention probe validates this using separate processes"** — **holds,
   with a gap worth stating.** `settingsWriteContention.probe.test.ts:122-126`
   spawns two real `Bun.spawn` children through
   `settingsWriteContention.probe.child.ts`, which calls the production
   `persistPermissionUpdate`. But the child exercises only `addRules`, i.e. the
   **updater** form. **The probe does not cover the object form at all**, which is
   why F1 survived it. Extending the probe with an object-form contender is the
   cheapest regression guard for F1's fix.
4. **"The redeem flow defaults confirmation to Cancel, refreshes and re-resolves
   the target account, preserves the request UUID across retries, and
   heals/invalidates/refetches after success"** — **holds on all four.**
   `Reset.tsx:380` `defaultFocusValue="cancel"`; `:170-198`
   `refreshPoolAccountForRedeem` then a second `getPoolStatus().accounts.find`
   (genuine re-resolve, not a cached handle); `:250-256` + `:405-425` carry the
   original `redeemRequestId` into `onRetry`; `:208-217`
   `applyRedeemedUsageReset` → `invalidateUsageCache()` →
   `fetchPoolUsage({forceRefresh:true})`.
5. **"Migration wiring is complete: both files imported, positioned in
   `runMigrations()`, and accompanied by a version bump"** — **holds.**
   `main.tsx:188-189` imports, `:346-347` call sites inside the version guard,
   `:337` `CURRENT_MIGRATION_VERSION = 14` against `main`'s 11.

---

## Findings the original report missed

### [MED] Escape from the Config tab closes the dialog **without reverting**, after any tab round-trip

Same root cause as F2 and verified to the same bar. `Config.handleEscape`
(`Config.tsx:1249-1259`) exists to run `revertChanges()` — Config applies every
toggle to disk immediately, so "cancel" means writing the old values back
(`:1172-1174`). But `Settings.handleEscape` (`Settings.tsx:78-85`) binds the same
`confirm:no` action in the same `'Settings'` context, and by the ordering
measured for F2 (`scratchpad/v26/h2order2.tsx`, cases B and C) the **later-mounted**
component loses. On first open via `/config` the Config listener registers first
and revert works; after switching to any other tab and back, `Config` remounts
last, `Settings.closeSettings()` consumes the Escape, and `revertChanges()` never
runs. Every change made in that Config session — including the
`permissions`-array leak F1 describes, whose only compensating undo lives in
`revertChanges` at `:1217-1220` — is silently kept.

I proved the ordering rule with the real hooks and a real render; I did **not**
drive the assembled `Settings`+`Config` tree end to end, so treat the application
of the rule to these two components as source-level. It is worth an operator
check: open `/config`, change a setting, Tab to Usage and back, press Escape, and
see whether the change is undone.

Fix: it is the same three-line fix as F2. Give `Config` a wrapped `onClose` and
delete `Settings`' own `confirm:no` binding while the Config tab is selected (it
already has the `configOwnsEsc` mechanism for exactly this kind of cession —
widen it from "search mode" to "Config is selected"), so exactly one component
owns Escape at a time.

### [LOW] `revertChanges` writes the merged snapshot back too

`Config.tsx:1217-1220` restores `permissions` from `initialUserSettings`
(`useState(() => getSettingsForSource('userSettings'))`, `:147`) — correctly
per-source, unlike `:508`. But it is itself an **object-form** patch containing
arrays, so it has F1's concurrency shape in reverse: a permission rule another
process appended while the dialog was open is erased by the revert. Lower
severity because revert is an explicit "undo my session" action, but it should be
converted to the updater form in the same edit as F1.

## Not settled

- I did not run any test file. `redeemResetMachine.test.ts` was read rather than
  executed because F5 is about assertions that are absent; executing it would
  show green and prove nothing. If the assembled-tree Escape behaviour (the MED
  above) needs to be closed, the deciding evidence is an operator run, or an Ink
  render of the real `Settings` with a `LocalJSXCommandContext` stub — the latter
  is buildable but needed more mocking than this scope justified.
- No live redemption was sent, so F2's server-side accounting is taken from
  source, not observed.
