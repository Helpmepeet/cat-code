# X02b adversarial validation: unwired features, migrations, dead exports

> **Verification provenance:** Opus 5 (`claude-opus-5`) at high effort. Read-only
> source review plus five standalone scratch scripts run against the real repo
> modules (the deferred-continuation runner imported live and driven to the leak;
> `feature()` from `bun:bundle` probed under the sidecar's actual spawn flags; the
> `dev-full` feature union re-derived from `scripts/build.ts`; branch-added `src/`
> imports resolved; in-repo `file:line` citations resolved), plus one
> `tsc --listFiles` run over `app/sidecar/tsconfig.json`. No test file run (none
> was decisive; the one relevant suite is the claimed-dead function's own test).
> No repo file edited except this report. No GUI, no dev server, no full suite.
> Branch `migration` at `a1012b1`.
>
> **Method limit, stated up front because every finding here is a "this is dead"
> claim:** my dead-export evidence is symbol-name `rg` across `src/`, `app/`,
> `web/`, `scripts/` **plus** a documentary sweep of `docs/`, `.claude/`, both
> `package.json` files. I closed the two gaps that would defeat a name grep:
> `app/renderer/src` has **no** barrel or renaming re-export
> (`rg '^export \*|export \{.* as .*\} from' app/renderer/src` → zero hits), and
> there is no dynamic/bracket module access in that tree. A renamed re-export or
> a string-keyed lookup elsewhere would still evade this; nothing suggests one.

## Overall verdict

The report is **right about the facts and repeatedly wrong about what they
mean**. Every symbol it calls dead is dead — I re-derived all fifteen
independently and none collapsed. But six of the fifteen are materially
mis-framed, and in three cases **the fix it proposes would make things worse**.

The HIGH is real and I proved it with a scratch repro — and the report
**understates** it. It says the consequence is "a session whose automatic
continuation is permanently stuck". The true consequence, which I reproduced, is
that the session **refuses every user message** for the rest of the process's
life, and `/continue-after-limit cancel` — the advertised escape — refuses too.
But its *trigger* is wrong: the effect cleanup it blames does not drop the
command, and app teardown releases the locks. The real drop paths are elsewhere,
and its proposed fix (call abandon from that cleanup) would kill healthy
in-flight continuations.

**F8 is the most important correction.** The report says `selectSettingField` is
dead and therefore "the managed/editable state it was written to drive is not
surfaced by the panel". The panel surfaces it fine — through `selectSettingsRow`
(`settingsScope.ts:598`), a near-identically-named live selector the report
missed. This is exactly the name-collision trap the brief warned about, and the
report's fix would reintroduce a source-blind lookup whose own code comment
records it as a past bug.

Three findings are **duplicates of already-adjudicated repo state**, not
discoveries: `WorkspaceTrustSection` and `ResolutionOrderLegend` are named on
`STATUS.md:58`'s explicit **parked-deletions** list with the sentence "Deleting
would have destroyed the only implementation"; `bannerStackModel` was already
filed at LOW by the 2026-08-03 lane-2 review and is named as reusable material in
a live backlog prompt (`phase4.md:4274`); the sidecar feature gap is on record as
**ruling #1, open since 2026-07-21**. The report's own closing paragraph claims it
checked `docs/` before reporting — it evidently ran the grep and did not read the
answers, because it proposes "record the cut" for cuts that are already recorded
and "delete" for modules a queued session is written against.

Two counting errors: the `dev-full` set is **37** names, not 38 (the repo's own
`STATUS.md:58` says 37), and `COORDINATOR_MODE` has **30** call sites, not ~35.

All five clean bills survive re-derivation, including the four false-positive
clearances — `engineTypeDriftCheck.ts` I upgraded from reasoning to proof.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Deferred-continuation lock-leak guard has zero call sites | **CONFIRMED** | Leak reproduced; consequence is worse than claimed (session refuses every prompt), trigger and fix are both wrong |
| F2 | MED | `WorkspaceTrustSection.tsx` imported by nobody | **PARTIALLY CONFIRMED** | Dead file real; "user never sees it" false (data lives in the mounted inspector); state already adjudicated + parked |
| F3 | MED | `bannerStackModel.ts` alive only for its test | **DUPLICATE** | Filed LOW at `lane2-shell-overlays.md:194`; `useBannerStack` has *no* importer at all; delete-fix collides with `phase4.md:4274` |
| F4 | MED | `selectTranscriptDisplayItems` dead and diverges | **CONFIRMED** | Holds, and the divergence is larger — production also applies `groupToolRuns` |
| F5 | MED | Sidecar runs 1 feature, CLI ships 38 | **DUPLICATE** | On record as ruling #1 since 2026-07-21 (`STATUS.md:58`); the number is 37, not 38 |
| F6 | MED | Dead hidden-workspaces reducer is the documented-wrong variant | **CONFIRMED** | Cited lines exact; live sibling's comment says precisely what the report says it does |
| F7 | MED | `selectWritableSelection` dead, predicate re-derived 3× | **PARTIALLY CONFIRMED** | Dead: yes. Fix is wrong: 2 of the 3 sites structurally cannot call it |
| F8 | MED | `selectSettingField` dead → resolution not surfaced | **OVERSTATED** | Resolution *is* surfaced via `selectSettingsRow`; the proposed fix reintroduces a recorded bug |
| F9 | MED | Two prototype components built, never mounted | **PARTIALLY CONFIRMED** | Both dead; "silent parity cut" false for both — one is on the parked list, the other's parity element is ledgered |
| F10 | MED | Coordinator Mode compiled out of every build | **PARTIALLY CONFIRMED** | True for `./cli`/`./cli-dev`; 30 sites not ~35; the sidecar needs no rebuild, only a spawn flag |
| F11 | LOW | ~9 sidecar `createReal*` factories over-exported | **CONFIRMED** | All 9 verified single-use in-file; the two genuine cross-file cases correctly excluded |
| F12 | LOW | Broad surplus-export surface across `app/` | **PARTIALLY CONFIRMED** | Exemplar exact (1,133 lines / 46 exports / 7 symbols); the 454 and 475 aggregates **UNPROVEN** |
| F13 | LOW | `isSettingsScopeKind` has no consumer anywhere | **CONFIRMED** | Zero references, including in its own file and test |
| F14 | LOW | Three exported types with zero references | **CONFIRMED** | All three verified; extends — the `AGENT_MODE_VERB_TYPES` const is code-dead too |
| F15 | LOW | `reducePasteRemoved` composer state | **DUPLICATE** | As the report itself says: `A16-composer-permission-state.md` |

---

## Per finding

### F1 — [HIGH] The deferred-continuation lock-leak guard has zero call sites

- **Verdict**: **CONFIRMED** — both halves. Severity **understated**; trigger and
  proposed fix both wrong.
- **Cited location holds?**: Yes, exactly.
  `src/services/deferredContinuationRunner.ts:460` is
  `export function abandonForegroundDeferredAttempt(origin: unknown): void`, and
  the comment the report quotes is verbatim at `:468-471`. The only settle site is
  `src/screens/REPL.tsx:3396` (`if (result) settleForegroundDeferredAttempt(...)`),
  inside `onQuery`'s `finally` at `:3382`. `beginForegroundDeferredContinuation`
  is at `:686`, and its `finally { await guard.release() }` sits at `:714-720`
  behind `await registration.result`.
- **Reachable in production?**: Yes, ungated. The whole subsystem is **branch-new**
  (`src/services/deferredContinuationRunner.ts` does not exist on `main`;
  `git log -1` on it lands on `fdca782` "fix(engine): stop deferred continuation
  from bricking a session"). `/continue-after-limit` is registered
  unconditionally at `src/commands.ts:282` — no `feature()` gate anywhere in
  `deferredContinuation*.ts`, `useDeferredContinuation.ts`, or the command dir.
  `useDeferredContinuation({ setMessages })` is mounted unconditionally at
  `REPL.tsx:4713`.

  **Half 1 — zero callers: verified.** `rg 'abandonForegroundDeferredAttempt'`
  over the whole tree returns the definition, two calls in
  `deferredContinuationRunner.test.ts:139,146`, and four `docs/` mentions. Nothing
  else. Deleting it breaks only that test file.

- **Trigger**: Proven with a scratch script that imports the real modules,
  creates a pending job in a temp `CLAUDE_CONFIG_DIR`, calls
  `beginForegroundDeferredContinuation`, then simply **never settles** — which is
  what a dropped queued command amounts to:

  ```
  attempt acquired: true
  locks held after begin: [<store>/deferred-continuations/locks/job-….lock,
                           <store>/deferred-continuations/locks/session-….lock]
  after 1.5s with the command dropped: STRANDED
  locks still held:      [ …both, unchanged… ]
  after abandonForegroundDeferredAttempt: SETTLED
  locks after abandon:   []
  ```

  The guard does exactly what its comment claims, and nothing calls it.

  **The production paths that drop the command** — and these are *not* the ones
  the report names:
  1. `clearCommandQueue()` (`src/utils/messageQueueManager.ts:375`) empties the
     module-global queue. Two live callers: `src/hooks/useCancelRequest.ts:253`
     (the `chat:killAgents` chord's second press, while background agents run) and
     `src/hooks/usePtcloveBridge.ts:466` (the bridge's `queue_clear` message).
  2. `src/screens/REPL.tsx:3268-3295` — when `queryGuard.tryStart()` returns null
     because a query is already running, `onQuery` re-enqueues the user text as
     `enqueue({ value: msg, mode: 'prompt' })`, **stripping `origin` and `uuid`**.
     `deferredOrigin` is only computed at `:3298`, *after* that early return. The
     registration is then unsettleable by anything, because the origin no longer
     exists on any message. This is a worse variant than the report's and it does
     not appear in the report.

- **Counter-arguments considered**:
  - *Does the effect cleanup the report blames actually drop anything?* **No.**
    `useDeferredContinuation.ts:164-167` sets `canceled = true` and clears a
    timer. The queue is module-global (`messageQueueManager.ts`), so a session
    switch or remount leaves the enqueued command in place; it still executes and
    still reaches `REPL.tsx:3396`. The report's primary cited leak site is not a
    leak site.
  - *Is "app teardown" a leak?* **No.** `proper-lockfile` registers a
    `signal-exit` handler (`node_modules/proper-lockfile/lib/lockfile.js:6,331`)
    that removes held locks at process exit. The comment's own wording — "for the
    process lifetime" — is the correct bound, and the report's "app teardown" item
    is wrong.
  - *Does `classifyForegroundDeferredAttempt` ever return null on a live
    registration, silently skipping the settle?* No.
    `classifyDeferredHeadlessResult` (`:145-150`) always returns a
    `DeferredAttemptResult`; the null arm fires only when
    `validateForegroundDeferredOrigin` is already false, i.e. the registration is
    gone. Not an additional leak.
  - *Does the deferred command hit the human-prompt guard and get eaten before
    `onQuery`?* No — `handlePromptSubmit.ts:181-204` returns early on the
    `queuedCommands` branch, before the guard at `:226`. No systematic leak.
  - *Does the poll loop recover, as the report says it tries to?* The report says
    the loop "polls `reconcileDeferredContinuationJob` every 1s and swallows the
    failure". **Only after a remount.** In the ordinary case `check()` sets no
    timer after `enqueue` (`:146`); it is parked on `attempt.finished.then(...)`
    (`:147-160`), which never resolves. So it does not spin — it stops. On a
    remount the loop *does* hit `:96-106` and retry forever, since `lock()` uses
    `retries: 0` and the same process holds the file.
  - *Could a stale-lock timeout free it?* No. `acquireOneLock`
    (`deferredContinuation.ts:922-943`) passes `update: DEFERRED_LOCK_UPDATE_MS`,
    so `proper-lockfile` keeps refreshing the mtime while the process lives.
- **True consequence** — **worse than the report claims**, and I reproduced it:

  ```
  attempt: true
  AFTER leak      : {"action":"block","notice":"A scheduled continuation is already
                     in progress. Wait for it to finish, then send your message again."}
  AFTER leak (2nd): {"action":"block", … same …}
  ```

  `handlePromptSubmit.ts:226-228` calls
  `prepareHumanPromptAgainstDeferredContinuation` on every ordinary submission;
  its lock acquisition at `deferredContinuation.ts:802` throws and it returns
  `block` (`:803-809`). So the session **refuses every user message** until the
  process exits. And the advertised escape is closed too:
  `continue-after-limit.tsx:203-211` takes the same lock and returns "Continuation
  is already running and cannot be canceled safely." This is the same failure
  class `fdca782` was written to close ("a crashed `submitted` job bricked the
  session permanently"); the abandon-less drop is a surviving instance of it.
- **Evidence**: `scratchpad/v31/f1-leak.ts` and `f1-brick.ts` (outputs above);
  `deferredContinuationRunner.ts:422-476,686-726`;
  `useDeferredContinuation.ts:129-168`; `REPL.tsx:3268-3298,3382-3399`;
  `messageQueueManager.ts:165-178,371-382`; `useCancelRequest.ts:253`;
  `usePtcloveBridge.ts:466`; `handlePromptSubmit.ts:181-232`;
  `deferredContinuation.ts:775-819,922-943`; `continue-after-limit.tsx:203-211`;
  `node_modules/proper-lockfile/lib/lockfile.js:331`.
- **Disposition** — **do not apply the report's fix as written.** It says to call
  `abandonForegroundDeferredAttempt(attempt.command.origin)` "from the
  `useDeferredContinuation` effect cleanup when `attempt.finished` has not
  settled". That cleanup runs on every session switch, where the command is still
  queued and perfectly healthy; abandoning there would settle a live continuation
  as `aborted` and stop it for attention — converting a non-bug into a user-visible
  failure. Fix at the actual drop sites instead:
  1. Make `clearCommandQueue()` settle what it discards: walk the commands it is
     about to drop and call `abandonForegroundDeferredAttempt(cmd.origin)` for
     each. This is the one change that covers both callers and any future one, and
     it is where the ownership transfer actually breaks.
  2. Preserve `origin`/`uuid` on the `REPL.tsx:3271-3294` re-enqueue, or abandon
     there explicitly. Silently dropping a `MessageOrigin` while replaying the
     text is wrong independently of this finding.
  3. Keep an abandon on true unmount **only** if a genuine unmount path is added
     (there is none today: `useDeferredContinuation`'s cleanup is a re-run, not a
     process exit, and exit is already handled by `signal-exit`).
  Independently of the fix, `prepareHumanPromptAgainstDeferredContinuation`'s
  lock-throw arm (`deferredContinuation.ts:803`) turning into a hard `block` is
  what converts a leak into a bricked session; that arm deserves its own look,
  since a lock held by *this same process* is a different situation from a lock
  held by a live peer and is currently indistinguishable.

### F2 — [MED] `WorkspaceTrustSection.tsx` is a 93-line file no one imports

- **Verdict**: **PARTIALLY CONFIRMED** — the dead-file fact holds; the framing and
  the fix do not.
- **Cited location holds?**: Yes. `app/renderer/src/WorkspaceTrustSection.tsx:14`
  is the single export, and `rg 'WorkspaceTrustSection' src app web scripts`
  returns only that line plus its own doc comment at `:3`. No importer,
  production or test. Branch-new by construction (`git ls-tree main -- app` is
  empty).
- **Reachable in production?**: No, and **deliberately so**. The report presents
  this as a discovery. It is a decision with a commit behind it:
  `PARITY-LEDGER.md:1089` states "⚠️ ORPHANED 2026-07-27 (was ✅ built P4-14) …
  **The mount is GONE. Do not code against this component.** `deae5ec` (CC-19
  Settings rebuild) removed the `workspace` category outright", and
  `PARITY-LEDGER.md:852` records the category removal separately.
- **Trigger / why the framing fails**: the report says "It is fully built against
  the real `workspace-trust.snapshot` seam and the user never sees it". The
  *component* is unmounted; **the data is on screen.** `MetadataInspector` is
  mounted at `App.tsx:3142` and reads `state.workspaceTrust` at
  `MetadataInspector.tsx:338`, with `WorkspaceFacts` at `:271` carrying the
  working-directory and detected-repo rows the ledger reassigned to it
  (`PARITY-LEDGER.md:1091-1092`). The ledger's "renders in NEITHER place" caveat
  described the pre-fix state; `STATUS.md:58` lists "the session inspector was
  mounted without `sessionState`" among the HIGHs **closed** by CC-21. So the
  parity elements survive; the file is a stranded second implementation, not a
  hidden feature.
- **Counter-arguments considered**: I looked for a barrel, a lazy import, or a
  route table that could mount it — none (`app/renderer/src` has no `export *` and
  no dynamic import). I checked whether the docs hits were merely historical: they
  are not — `backlog/phase4.md:828`, `INVENTORY.md:90` and `STATUS.md:43` still
  carry it as live work, which is precisely why `STATUS.md:58` records the
  deletion as **parked**: "Deleting would have destroyed the only implementation."
  I also considered whether the 2026-08-07 status-truth audit had already filed it
  — it had, as `lane-15-extensions-diagnostics.md:312` F1 (Medium).
- **True consequence**: 93 lines of stranded code and one stale `⬜` residual, on a
  surface whose user-visible content renders elsewhere. Not a parity gap.
- **Evidence**: `WorkspaceTrustSection.tsx:1-14`; `MetadataInspector.tsx:271,338`;
  `App.tsx:300,3142`; `PARITY-LEDGER.md:852,1089-1093`; `STATUS.md:53,58,371`;
  `lane-15-extensions-diagnostics.md:312`.
- **Disposition**: **Do not take the report's first branch** ("mount it in the
  settings shell") — that reverses `deae5ec` and CC-19 Law 1. The cut is already
  recorded, so its second branch ("delete the file and record the cut") is half
  done and half wrong: record nothing new, and delete only with the operator call
  `STATUS.md:58` explicitly parked it on, in one edit that also clears
  `STATUS.md:43`'s residual, `backlog/phase4.md:828` and `INVENTORY.md:90`.
  `DiagnosticsSection.tsx` is the same decision and should move with it.

### F3 — [MED] `bannerStackModel.ts`: whole module alive only for its test

- **Verdict**: **DUPLICATE** (facts confirmed).
- **Cited location holds?**: Yes for two of three.
  `bannerStackModel.ts:4` `upsertBanner` and `:15` `dismissBanner` are imported
  only by `BannerStack.test.tsx:7`. **`:22` `useBannerStack` is imported by
  nothing at all — not even the test.** The report's "All three exports are
  imported only by `BannerStack.test.tsx`" overstates by one; the hook is one
  degree deader than claimed. The production side is exact:
  `App.tsx:1393-1396` derives `accountHealthBanner && … ? [accountHealthBanner] :
  EMPTY_BANNERS` (with `EMPTY_BANNERS` at `:406`) and passes it to `<BannerStack`
  at `:3398`. Structurally 0-or-1, as claimed.
- **Reachable in production?**: No. Branch-new by construction.
- **Trigger / why it is a duplicate**: `docs/migration/reviews/2026-08-03-week-code-review/lane2-shell-overlays.md:194`
  already carries "**[LOW]** `bannerStackModel.ts` ships with no production
  consumer — CONFIRMED", with the same `App.tsx` derivation cited at `:199-200`.
  `docs/reports/2026-07-08-ponytail-branch-review.md:12` separately flagged
  `useBannerStack` as zero-caller. The report re-files both at MED without naming
  either.
- **Counter-arguments considered**: I checked whether P4-50 (which the STATUS row
  says gave `BannerStack` "its first production importer", commits `df96f52`,
  `4bbe04e`) routes through the model — it does not; it added
  `accountHealthBanner.ts` and derives the array inline. So the report's factual
  claim survives that check. I also checked whether the module has documentary
  wiring: **it does.** `backlog/phase4.md:4274-4275` names it by path as the
  reusable "pure, tested stacking model (`upsertBanner` / `dismissBanner` /
  `useBannerStack`)", and the P4-50 STATUS row records that ledger §05 "stays ⬜
  because the transcript's own session banners are still unbuilt" — i.e. a second,
  genuinely multi-banner consumer is still on the books.
- **True consequence**: As claimed — a green suite asserting stack semantics the
  one shipped consumer cannot exercise. Real, and already filed at LOW.
- **Evidence**: `bannerStackModel.ts:4,15,22`; `BannerStack.test.tsx:7`;
  `App.tsx:406,1375-1396,3398`; `lane2-shell-overlays.md:194-203`;
  `ponytail-branch-review.md:12,28,84`; `backlog/phase4.md:4273-4275`;
  `STATUS.md:408`.
- **Disposition**: Take the report's **first** branch only — route the
  account-health banner through `upsertBanner`/`dismissBanner` so the tested path
  is the shipped path. **Do not delete the module**: `backlog/phase4.md:4274`
  points a not-yet-run session at it by name, which is the second time this repo
  would have deleted something a backlog prompt depends on. Deleting
  `useBannerStack` alone is safe and was already recommended in 2026-07-08; it has
  no consumer whatsoever, so nothing breaks, not even a test.

### F4 — [MED] `selectTranscriptDisplayItems` is dead and its composition differs from production

- **Verdict**: **CONFIRMED** — and the divergence is *larger* than the report says.
- **Cited location holds?**: Yes, to the line.
  `transcriptProjector.ts:797` is `export function selectTranscriptDisplayItems`,
  its body is `groupAgentDelegates(selectNestedTranscriptRows(state, sessionId,
  revealHidden))`, and the doc comment at `:791-796` does call it the "Read-time
  transcript display list". Only `transcriptProjector.test.ts` imports it
  (7 call sites). `TranscriptView.tsx:205` calls `selectNestedTranscriptRows`
  directly.
- **Reachable in production?**: No — test-only. Branch-new by construction.
  (Note: `transcriptProjector.test.ts` is dirty in the working tree; I read what
  is on disk at `a1012b1`. The projector module itself is clean.)
- **Trigger / correction**: the report says production is
  `groupDisplayItems(groupAgentDelegates(rows), reasoningMode)`. On disk,
  `TranscriptView.tsx:298` is
  `groupToolRuns(groupDisplayItems(groupAgentDelegates(rows), reasoningMode))` —
  **three** derivations, not two. The dead wrapper omits both `groupDisplayItems`
  (reasoning-run folding) *and* `groupToolRuns` (tool-run folding), so a test
  written against it is blind to two classes of regression, not one.
- **Counter-arguments considered**: I checked whether `groupToolRuns` is a
  late/conditional addition that might not apply on every render — it is not; the
  comment at `:294-296` says it "runs LAST and outside the reasoning-mode switch"
  precisely so it survives `blocks` mode. I checked for a second production caller
  of the selector under a different import name — none (no barrels in that tree).
- **True consequence**: An exported symbol named for the display list produces a
  different list from the display list, and its doc comment asserts otherwise.
  Deleting it breaks `transcriptProjector.test.ts` only.
- **Evidence**: `transcriptProjector.ts:789-802`; `TranscriptView.tsx:205,290-299`.
- **Disposition**: Take the report's second branch, not its first. Deleting is
  cheap but loses the memoisation the test at `:1819-1830` exercises
  (`toBe`-identity across calls); making it the single composition
  `TranscriptView.tsx:298` calls is the fix that actually removes the divergence.
  That means moving `groupDisplayItems`/`groupToolRuns` and the `reasoningMode`
  argument into it, and then the name becomes true.

### F5 — [MED] Desktop sidecar runs the engine with 1 feature; the CLI build ships 38

- **Verdict**: **DUPLICATE** — with the number wrong.
- **Cited location holds?**: Yes. `app/main/mainDecisions.ts:41-44` is
  `SIDECAR_RUNTIME_ARGS = ['--feature=TRANSCRIPT_CLASSIFIER', 'run']`, pinned by
  `mainDecisions.test.ts:29-34` (report says `:30-33`). `scripts/build.ts:82`
  `defaultFeatures = ['TRANSCRIPT_CLASSIFIER','VOICE_MODE']`;
  `fullExperimentalFeatures` at `:13-50`.
- **Reachable in production?**: Yes, and I proved the mechanism rather than
  inferring it. `feature()` under Bun is a **runtime** flag read, not only a build
  macro:

  ```
  bun run feat2.ts                              → TRANSCRIPT_CLASSIFIER OFF …all OFF
  bun --feature=TRANSCRIPT_CLASSIFIER run …     → TRANSCRIPT_CLASSIFIER ON, rest OFF
  bun --feature=COORDINATOR_MODE run …          → COORDINATOR_MODE ON, rest OFF
  ```

  So the sidecar genuinely runs with exactly **one** feature on — the report is
  right, and V30's parenthetical that "unbundled execution, i.e. the sidecar, has
  *no* features on" is wrong for the sidecar specifically (true only absent the
  flag).
- **Trigger / corrections**: (a) The `dev-full` union is **37**, not 38 — I
  re-derived it from `scripts/build.ts` (`defaultFeatures` ∪
  `fullExperimentalFeatures`, `VOICE_MODE` appearing in both). `STATUS.md:58`
  independently says "`./cli-dev` enables 37 of those names". (b) The consequence
  the report says "is not recorded anywhere" **is recorded, quantified, and
  ruled**: `STATUS.md:58` reads "911 call sites / 87 flags in `src/` all evaluate
  FALSE in the sidecar because it is spawned unbundled … Three behavioural
  divergences named … This is already on record as **ruling #1, open since
  2026-07-21** … Needs an operator decision … not a patch." The prompt-level
  examples the report contributes (`TOKEN_BUDGET` at `prompts.ts`,
  `CACHED_MICROCOMPACT`, `PROMPT_CACHE_BREAK_DETECTION`) are real and are new
  detail on a known item, not a new item.
- **Counter-arguments considered**: I checked whether anything else injects
  features at sidecar spawn — `rg '--feature' package.json app/ scripts/` returns
  only `mainDecisions.ts:42`, `app/package.json:10` (`sidecar:dev`, same single
  flag) and `scripts/build.ts`. Nothing widens it.
- **True consequence**: As claimed, on a known open ruling.
- **Evidence**: `scratchpad/v31/feat2.ts` outputs above;
  `scripts/build.ts:13-50,82,101-107,182`; `mainDecisions.ts:37-44`;
  `mainDecisions.test.ts:29-34`; `app/package.json:10`; `STATUS.md:58`.
- **Disposition**: The report's fix (a comment next to `SIDECAR_RUNTIME_ARGS`) is
  harmless but redundant against `STATUS.md:58` and would let a documented
  *unresolved ruling* read as a settled decision. Better: leave the code alone and
  add the three prompt-level divergences the report found to ruling #1's open
  entry, where the operator decision already lives. If anything goes next to
  `SIDECAR_RUNTIME_ARGS`, it should point at the ruling, not restate an intent.

### F6 — [MED] The dead hidden-workspaces reducer is the variant the module documents as wrong

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `sidebarHiddenWorkspaces.ts:166`
  `reduceHiddenWorkspacesCleared`, consumed only by
  `sidebarHiddenWorkspaces.test.ts:7,82,84`. The live sibling
  `reduceHiddenWorkspacesShown` is at `:184`, imported at `Sidebar.tsx:119` and
  called at `:947` — both cites exact.
- **Reachable in production?**: No. Branch-new by construction.
- **Trigger**: The report's characterisation of the doc comment is accurate. The
  comment spans `:172-186` (report says `:172-180`) and reads: "a search-narrowed
  render could read 'Show 1 hidden project' while its click cleared every hidden
  project". The test file adds its own scar at `:88` and `:108` ("BUG: it used to
  call `reduceHiddenWorkspacesCleared`"). So the dead export is the exact
  behaviour the module records as a fixed bug.
- **Counter-arguments considered**: I checked whether the dead reducer is retained
  deliberately as the counterexample the test asserts *against* — it is not;
  `:82-86` assert its own behaviour (same-reference no-op, and clear-to-empty), so
  deleting it breaks only those two assertions and nothing else. I also checked
  for a `Sidebar` path that clears all hidden workspaces by another route — none.
- **True consequence**: As claimed. A future caller reaching for the obvious name
  reintroduces a fixed bug, with a green test to reassure them.
- **Evidence**: `sidebarHiddenWorkspaces.ts:158-190`;
  `sidebarHiddenWorkspaces.test.ts:7,82-88,108`; `Sidebar.tsx:119,947`.
- **Disposition**: Take the delete, not the rename. The rename branch keeps a
  function whose only correct number of callers is zero. Delete it and its two
  assertions; the scar comments at `:88`/`:108` should stay, since they are what
  stops the behaviour coming back.

### F7 — [MED] `selectWritableSelection` is dead while its predicate is re-derived three times

- **Verdict**: **PARTIALLY CONFIRMED** — dead: yes. Fix: wrong at two of three sites.
- **Cited location holds?**: Yes. `sessionsPageState.ts:191`
  `selectWritableSelection`, imported only by `sessionsPageState.test.ts:13,103`.
  `SessionsPage.tsx:70,200` do import `selectKnownTags` from the same module and
  not this one. The three inline sites are exactly `:236`, `:443`, `:604`.
- **Reachable in production?**: No (the selector). Branch-new by construction.
- **Trigger / where the fix breaks**: the selector returns `SessionId[]` — the
  **`appSessionId`s of `state.selected` rows** (`:191-201`). Against that:
  - `:236` — `const writable = targets.filter(row => row.live && row.appSessionId != null)`.
    `targets` is `selectedRows` **only when `target.kind === 'bulk'`**; otherwise
    it is `rows.filter(row => row.sessionId === target.sessionId)`, i.e. *not* the
    selection. And the result is passed as **rows** to `onTagRows?.(writable, tag)`,
    not as ids. The selector cannot serve this site on either count.
  - `:604` — `const writable = row.live && row.appSessionId != null` is a
    **per-row boolean** inside the row renderer, with no selection involved. The
    selector cannot serve it either.
  - `:443` — `selectedRows.filter(...).length`, where `selectedRows` is
    `rows.filter(row => selectIsSelected(page, row.sessionId))` (`:201-204`). This
    one **is** equivalent to `selectWritableSelection(page, rows).length`. It is
    the only site the report's fix actually fits.
- **Counter-arguments considered**: I checked whether the selector could be
  generalised cheaply (return rows instead of ids) — it could, but its doc comment
  and its test (`toEqual(['app-live'])`) are both written around returning ids
  "so the bar can say what will happen", which is the `:443` use. Widening it to
  serve `:236` would change the tested contract for a site that is not
  selection-scoped.
- **True consequence**: As the report says, behaviour is currently correct; the
  cost is a rule in four places. But it is **one** duplicate the selector can
  absorb, not three, so the drift risk it describes is smaller than stated.
- **Evidence**: `sessionsPageState.ts:185-201`;
  `sessionsPageState.test.ts:13,103`; `SessionsPage.tsx:70,200-204,230-240,435-445,600-608`.
- **Disposition**: Wire `:443` to `selectWritableSelection(page, rows).length`.
  Leave `:236` and `:604` alone — they are different questions that happen to
  share a predicate. If the shared predicate is worth extracting, extract the
  **row-level** one (`isWritableRow(row)`) and have all three plus the selector
  call it; that is the change that actually collapses four copies into one, and
  the report's proposal does not.

### F8 — [MED] `selectSettingField` dead: the settings panel reads values but never their resolution

- **Verdict**: **OVERSTATED** — the dead export is real, the stated consequence is
  false, and the proposed fix is a regression.
- **Cited location holds?**: Yes. `settingsState.ts:76` `selectSettingField` is
  imported only by `settingsState.test.ts:12`. Its sibling `selectEditableValue`
  (`:91`) is live at `SettingsShell.tsx:122,862`. All four cites exact.
- **Reachable in production?**: The selector, no. **The lookup it describes, yes.**
- **Trigger / why the consequence is false**: the report concludes "Nothing makes
  that lookup, so the managed/editable state it was written to drive is not
  surfaced by the panel." The panel surfaces it. `selectSettingsRow`
  (`settingsScope.ts:598`) does the same lookup inline at `:630` —
  `const winner = snapshot.resolved.find(entry => entry.key === key) ?? null` —
  and returns `annotation`/`read`/`writeTarget`, which `SettingsShell.tsx:665-687`
  turns into `managed={row.annotation.kind === 'enforced'}`, `source={badgeSource}`
  and `origin={selectLayerOrigin(...)}` on the `Field`, rendering `SourceBadge`.
  `SettingsEditors.tsx:168` calls the same selector. This is the name-collision
  case: `selectSettingField` (dead) vs `selectSettingsRow` (the default path).
- **Counter-arguments considered**: I tried to save the finding by checking
  whether `selectSettingsRow` is itself unmounted — it is not; `SettingsShell` and
  `SettingsEditors` are both live, and `SourceBadge` renders from
  `SettingsShell.tsx:976`, `MetadataInspector.tsx`, `PermissionRulesEditor.tsx`
  and `AgentsPage.tsx`. I also checked whether the two lookups agree: **they do
  not, and the live one is deliberately richer.** `settingsScope.ts:632-637`
  documents why: it resolves `layerValue(snapshot, winner.source, key)` rather
  than trusting the winner's own value, "never a lower layer's borrowed via a
  source-blind lookup (**that was the bug**: a value the sidecar's per-key
  validator dropped for this layer fell through to whichever layer's value
  happened to exist, and the row attributed it to the winner regardless)".
  `selectSettingField` is exactly that source-blind lookup.
- **True consequence**: One dead duplicate selector in `settingsState.ts`, plus a
  test that green-lights the weaker of two implementations. Zero user-visible
  effect.
- **Evidence**: `settingsState.ts:74-101`; `settingsState.test.ts:12,88-100`;
  `settingsScope.ts:596-650`; `SettingsShell.tsx:120-122,665-687,862,976`;
  `SettingsEditors.tsx:23,48,168`.
- **Disposition**: **Do not take the report's fix.** "Wire it into the settings
  `Field` rows" would replace `selectSettingsRow`'s layer-aware resolution with
  the source-blind one the comment names as a past bug. Delete
  `selectSettingField` and its test, and if anything is added, add a one-line
  pointer from `settingsState.ts` to `selectSettingsRow` so the next reader does
  not rebuild it a third time.

### F9 — [MED] Two prototype components built and never mounted

- **Verdict**: **PARTIALLY CONFIRMED** — both dead; the "silent parity cut"
  framing is false for both.
- **Cited location holds?**: Yes. `SettingsField.tsx:223` `ResolutionOrderLegend`,
  imported only by `SettingsField.test.tsx:6,89-90`. `AgentChrome.tsx:137`
  `AgentStateWord`, imported by nothing at all. The live siblings are as claimed:
  `SourceBadge` (same file, many consumers) and `AgentStateLabel`
  (`AgentChrome.tsx:114` → `TranscriptView.tsx:78,1862` and `TasksDialog.tsx:57,529`).
- **Reachable in production?**: No, for both. Branch-new by construction.
- **Trigger / why the framing fails**: the report calls these "the silent parity
  cut the program rules forbid". Neither is silent.
  - `ResolutionOrderLegend` is named verbatim on `STATUS.md:58`'s parked list —
    "`WorkspaceTrustSection` / `DiagnosticsSection` / `BannerStack` /
    `ResolutionOrderLegend` all have zero importers … **Deletions parked, not
    made**" — and again at `docs/reports/2026-07-28-bug-catalogue.md:428`.
  - `AgentStateWord`'s parity element is ledgered as built at
    `PARITY-LEDGER.md:996`.
- **Counter-arguments considered — and a miss this turned up**: I tried to
  invalidate the `AgentStateWord` claim using `PARITY-LEDGER.md:996`, which states
  it is "Rendered by `AgentStateWord` (`AgentChrome.tsx:123`) in the `/tasks`
  Workers-tab worker row (`TasksDialog.tsx:466`)". **That ledger row is now
  stale.** `TasksDialog.tsx`'s `WorkerRow` (`:460-475`) renders `AgentStateLabel`
  at `:529`, not `AgentStateWord`; `rg 'agentTranscriptStateWord' app/renderer/src`
  returns only `agentIdentity.ts:274` (its definition) and `AgentChrome.tsx:17,141`
  (inside the dead component). So **`agentTranscriptStateWord` is dead by
  transitivity** — a whole second function the report did not flag — and both
  `PARITY-LEDGER.md:996` ("The function is live with a real production consumer,
  so this is no longer a tested dead export") and `:1491` ("the trailing word is
  §13's `agentTranscriptStateWord`") are now false.
- **True consequence**: Two dead components, one dead helper behind them, and two
  stale ledger rows asserting the opposite. The parity risk is in the *ledger*,
  not in a silent code cut.
- **Evidence**: `SettingsField.tsx:219-236`; `SettingsField.test.tsx:6,89-90`;
  `AgentChrome.tsx:114,131-144`; `agentIdentity.ts:264,274`;
  `TasksDialog.tsx:57,460-475,529`; `TranscriptView.tsx:78,1862`;
  `PARITY-LEDGER.md:996,1491`; `STATUS.md:58`;
  `docs/reports/2026-07-28-bug-catalogue.md:425-428`.
- **Disposition**: Not "mount or record as a tagged cut" — both are already
  recorded. Correct the **ledger** first: `PARITY-LEDGER.md:996` and `:1491` claim
  a live consumer that does not exist, which is the actively misleading artefact
  here. Then delete `AgentStateWord` + `agentTranscriptStateWord` together (they
  fall as a pair; nothing else calls either), and leave `ResolutionOrderLegend`
  parked with its three siblings until the operator call `STATUS.md:58` is waiting
  on.

### F10 — [MED] Coordinator Mode is compiled out of every build this repo can produce

- **Verdict**: **PARTIALLY CONFIRMED** — true for the compiled CLIs, imprecise for
  the sidecar, and the call-site count is wrong.
- **Cited location holds?**: Yes. `src/coordinator/coordinatorMode.ts:41-46` is
  `isCoordinatorMode()` returning `feature('COORDINATOR_MODE') ? isEnvTruthy(...)
  : false`. The gate is at `src/tools.ts:135`. `isAgentMode()`
  (`src/agent-mode/agentMode.ts:39-41`) is a plain env check with no gate, and
  `getCurrentSessionMode` (`:96-100`) checks it **before** the coordinator arm —
  the report's "Agent Mode is not affected" is correct and worth keeping.
- **Reachable in production?**: `COORDINATOR_MODE` is absent from both
  `scripts/build.ts` lists (verified by grep and by re-deriving the 37-name
  union), so `isCoordinatorMode()` is `false` in `./cli` and `./cli-dev`. My
  runtime probe confirms it is also OFF by default unbundled.
- **Trigger / corrections**:
  - **Count**: `rg -c "feature\('COORDINATOR_MODE'\)"` over `src`+`app` gives
    **30**, tests included. The report says "~35 sites".
  - **"every build this repo can produce"** is imprecise for the sidecar.
    `feature()` is read at runtime under Bun: `bun --feature=COORDINATOR_MODE run
    …` turns it ON with **no rebuild**, as I measured. So for the sidecar the gate
    is one entry in `SIDECAR_RUNTIME_ARGS`, not a build change. Same outcome
    today; different fix cost, and the report's proposed fix ("add it to the
    dev-full list") would not affect the sidecar at all.
  - The provenance claim holds: `src/coordinator/coordinatorMode.test.ts` is
    branch-new (added in `bf7beca`; `git ls-tree main src/coordinator/` lists only
    `coordinatorMode.ts`), and it reaches `getCoordinatorSystemPrompt` through a
    dynamic import at `:9-11` that bypasses the gate entirely.
- **Counter-arguments considered**: I checked whether `tools.ts:135`'s
  `coordinatorModeModule` is consumed anywhere that would fail closed loudly —
  it is `null` in every build, and callers branch on it. I checked whether an env
  var alone can enable it — no: `isEnvTruthy(CLAUDE_CODE_COORDINATOR_MODE)` sits
  *inside* the feature check, so the env var is inert without the flag.
- **True consequence**: As claimed — a subsystem no shipped build reaches, with a
  green branch-new test asserting its prompt wording.
- **Evidence**: `scratchpad/v31/feat2.ts` + `scratchpad/v31/orphans.sh` outputs;
  `coordinatorMode.ts:41-46`; `coordinatorMode.test.ts:1-21`; `tools.ts:135-137`;
  `agentMode.ts:39-41,94-101`; `scripts/build.ts:13-50,82`.
- **Disposition**: The report's "no code change needed if intentional" is right.
  If it is to be exercisable, say **where**: adding `COORDINATOR_MODE` to
  `fullExperimentalFeatures` covers `./cli-dev` only; the desktop needs it in
  `SIDECAR_RUNTIME_ARGS` (`mainDecisions.ts:41-44`) and its pinning test. Do not
  let one line near the test imply both.

### F11 — [LOW] ~9 sidecar `createReal*` factories exported for no external consumer

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: All nine verified at the cited lines —
  `accountsDomain.ts:254,489`, `agentModeDomain.ts:68`, `leaseDomain.ts:95`,
  `remoteSettingsDomain.ts:177`, `runControlsDomain.ts:114`,
  `sessionActionsDomain.ts:82`, `taskControlDomain.ts:49`,
  `workspaceTrustDomain.ts:80`.
- **Reachable in production?**: Yes — they are live defaults, which is the point
  of the finding. Spot-checked the "used exactly once, in-file" shape on four:
  `accountsDomain.ts:582` `options.oauthRunner ?? createRealOAuthLoginRunner()`,
  `:581` `options.executor ?? createRealAccountsExecutor()`, `leaseDomain.ts:126`,
  `taskControlDomain.ts:76`. Pattern holds.
- **Counter-arguments considered**: This is the clearance most likely to be wrong,
  so I swept for cross-file consumers and found **two** — and the report correctly
  excluded both: `createRealAnthropicOAuthLoginRunner` (`accountsDomain.ts:301`)
  *is* imported by `accountsDomain.test.ts:23,706,769,801`, and
  `createRealContextBreakdownExecutor` (`contextBreakdownDomain.ts:71`) *is*
  imported by `sessionController.ts:27,621`. Neither appears in the report's list.
  That is a precise nine, not a sloppy nine.
- **True consequence**: As claimed — surplus public surface, not dead code.
- **Evidence**: the nine definitions and their single in-file uses;
  `rg 'createReal[A-Za-z]*' app src` for the two exclusions.
- **Disposition**: Take it, narrowly: drop `export` from the nine. Do **not**
  extend the sweep to `accountsDomain.ts:301` or `contextBreakdownDomain.ts:71`.

### F12 — [LOW] Broad surplus-export surface across `app/`

- **Verdict**: **PARTIALLY CONFIRMED** — the exemplar is exact; the two aggregate
  numbers are **UNPROVEN**.
- **Cited location holds?**: Exactly, for the worst case. `settingsScope.ts` is
  **1,133** lines with **46** `^export` lines, and all seven named symbols have no
  consumer outside the file: `isSettingsScopeKind:75` (none anywhere),
  `settingsProjectLabel:159` (used `:202`), `normalizeProjectCwd:166`
  (`:187,192,200,221`), `SETTINGS_RAIL_ITEM_IDS:235` (`:253,260`),
  `isSettingsRailItemId:255` (`:475`), `SETTINGS_LAYER_PHRASE:1021`
  (`:1045,1050`), `SETTINGS_WRITE_TARGET_LABEL:1101` (`:1113`). Every line number
  is right.
- **Reachable in production?**: n/a — a quality finding.
- **Trigger**: n/a.
- **Counter-arguments considered**: I could not re-derive "**454** exported
  symbols … have no consumer in any other production file" or "**475** raw
  candidates that collapse to ~20" without an AST/import-graph pass, which the
  report itself says it did not do (its "Not reviewed" section flags exactly this,
  and admits its first automated pass produced ten false positives on
  `SessionActionIcons.tsx` alone). A name-grep approximation would reproduce the
  same false-positive class rather than check it. I am marking those two figures
  UNPROVEN rather than inheriting them — they are the load-bearing numbers in the
  finding and neither the report nor I have established them.
- **True consequence**: Established for `settingsScope.ts`; plausible but
  unestablished at the 454/475 scale.
- **Evidence**: `wc -l` and `rg -c '^export '` on `settingsScope.ts`; the seven
  per-symbol greps.
- **Disposition**: Take it as written — "not worth a sweep; worth applying to new
  code and to `settingsScope.ts` if it is touched for other reasons" is the right
  call *especially* given the aggregates are unverified. Do not let 454 be quoted
  downstream as a measured number.

### F13 — [LOW] `isSettingsScopeKind` has no consumer anywhere

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `settingsScope.ts:75`. `rg '\bisSettingsScopeKind\b'`
  over `src app web scripts` returns the definition and nothing else; over
  `docs/`, two hits, both in this review's own reports.
- **Reachable in production?**: No. Not referenced in its own file, its test, or
  any other module. Branch-new by construction.
- **Trigger**: n/a.
- **Counter-arguments considered**: This is the purest delete-candidate in the
  report, so I checked the three ways a type guard survives a name grep: a barrel
  re-export (none in `app/renderer/src`), a renamed import (would still show the
  local name at the definition's export site, and there is no `as` re-export in
  the tree), and a `satisfies`/type-position use (a runtime function cannot be
  used in a type position). It is genuinely unreferenced.
- **True consequence**: 3 lines of dead code.
- **Evidence**: `settingsScope.ts:75`; the grep above.
- **Disposition**: Delete. Note `SettingsScopeKind` (the type it guards) is a
  separate symbol and is used — delete the guard only.

### F14 — [LOW] Three exported types with zero references

- **Verdict**: **CONFIRMED** — and it extends one symbol further.
- **Cited location holds?**: Yes for all three.
  `app/shared/protocol.ts:1384` `AgentModeVerbType`;
  `app/renderer/src/sessionsPageState.ts:28` `SessionsPageAnchor` (zero
  references); `app/renderer/src/shellState.ts:239` `selectSession` (a runtime
  accessor, imported only by `shellState.test.ts:9,70,84,97,171,192` — the report
  correctly labels it as such rather than as a type).
- **Reachable in production?**: No. All branch-new by construction.
- **Trigger**: n/a.
- **Counter-arguments considered**: `selectSession` is a common name, so I greped
  it unanchored across `app/` and `src/` — six hits, all in `shellState.test.ts`
  plus the definition. No collision with an engine-side `selectSession`.
  `protocol.ts` is a §6 care-file, so I checked whether removing an exported type
  is a wire change: it is not — `AgentModeVerbType` is type-only and the wire
  vocabulary is the const. **Which turns up the extension:** the const
  `AGENT_MODE_VERB_TYPES` (`protocol.ts:1382`) has no code consumer either — its
  only other hits are three prose mentions inside comments at
  `sidecarServer.ts:1828,3517,3759`. So the allowlist the report calls "live" is
  itself unreferenced, and the pair should be assessed together.
- **True consequence**: Three dead exports, plus a fourth (the const) whose
  liveness the report assumed.
- **Evidence**: `protocol.ts:1382-1384`; `sessionsPageState.ts:28`;
  `shellState.ts:239`; `shellState.test.ts:9`; `sidecarServer.ts:1828,3517,3759`.
- **Disposition**: Delete `SessionsPageAnchor` and `selectSession` (the latter
  breaks six assertions in `shellState.test.ts` only). For
  `AgentModeVerbType`, **do not delete it alone** — first establish whether
  `AGENT_MODE_VERB_TYPES` was meant to be validated against and is not. If the
  allowlist is genuinely inert, the fix is to *use* it in the sidecar's inbound
  validation (which is what a `§5` closed-allowlist claim implies) rather than to
  prune the type and leave an unenforced const behind. That is a boundary
  question, not a cleanup, and it should not ride on a LOW dead-export finding.

### F15 — [LOW] `reducePasteRemoved` — composer state (already reported)

- **Verdict**: **DUPLICATE** (facts confirmed).
- **Cited location holds?**: Yes. `composerState.ts:169`, imported only by
  `composerState.test.ts:22,168`.
- **Reachable in production?**: No. Branch-new by construction.
- **Trigger**: n/a.
- **Counter-arguments considered**: I confirmed the duplicate the report claims —
  `rg -l 'reducePasteRemoved' docs/reports/2026-08-08-migration-branch-review/`
  returns `A16-composer-permission-state.md` and this report only. The report
  labels it correctly and folds it into totals rather than double-counting the
  severity, which is the right handling.
- **True consequence**: As claimed. Deleting breaks its own test only.
- **Evidence**: `composerState.ts:169-179`; `composerState.test.ts:22,168`;
  `A16-composer-permission-state.md`.
- **Disposition**: Resolve with A16; nothing extra here.

---

## The report's clean bills, re-derived independently

All five survive. Two carry a corrected number.

1. **"The feature build-list has zero orphans."** **CONFIRMED**, count corrected.
   I re-derived the `dev-full` union from `scripts/build.ts` (`defaultFeatures` ∪
   `fullExperimentalFeatures`) — **37** names, not 38 — and checked each for a
   non-test `feature('NAME')` call site. Zero orphans, exactly as claimed.
   (`scratchpad/v31/orphans.sh`.)

2. **"Both migrations wired through all four steps, with a source-text
   tripwire."** **CONFIRMED**, and stronger than stated.
   `git diff --name-status main...HEAD -- src/migrations/` shows exactly four
   added files: `migrateRetiredClaude46ModelsToClaude5.{ts,test.ts}` and
   `migrateRetiredGptModelsToGpt56.{ts,test.ts}`. **Both** tests contain the
   `mainSource` tripwire (the report cites only the first). The tripwire at
   `migrateRetiredClaude46ModelsToClaude5.test.ts:232-258` asserts the import
   line, the call inside `runMigrations`, and — the part a unit test cannot
   otherwise see — that `gateIndex < callIndex < saveIndex`, pinning the call
   between the `migrationVersion !== CURRENT_MIGRATION_VERSION` guard and the
   version-bumping `saveGlobalConfig`. Wiring verified live at `main.tsx:188,189`
   (imports), `:346,347` (calls), `:337` `CURRENT_MIGRATION_VERSION = 14` against
   `main`'s 11. One note the report does not make: that is **three** version bumps
   for **two** new migrations. Benign (a spare bump only re-runs the existing
   list), but the report's "version 11 → 14" reads as if it accounted for all
   three.

3. **"All 12 `package.json` script targets exist."** **CONFIRMED.** Root has 6
   file-target scripts and `app/package.json` has 6, which is where the 12 comes
   from. My first automated pass produced two false positives (`cli.ts`,
   `preview-transcript.ts`) from a regex that clipped the `x` off `.tsx`; both
   files exist as `.tsx`. All 12 resolve.

4. **"87 branch-added `src/` files, zero unresolved relative imports."**
   **CONFIRMED**; the count is **88**. My resolver reported two "unresolved"
   specifiers, both inside the migration tripwires' `expect(mainSource).toContain(
   "import { … } from './migrations/….js'")` **string literals** — not imports.
   Zero real breakage. (`scratchpad/v31/imports.ts`.)

5. **"Every in-repo `file.ts:line` citation in comments resolves."**
   **CONFIRMED.** 350 unique path-bearing citations across `src/` and `app/`
   non-test files; after accounting for `src/tools/`-relative forms
   (`BashTool/UI.tsx:92` → `src/tools/BashTool/UI.tsx`) and for prompt *examples*
   rather than citations (`src/auth/validate.ts:42` and friends are fabricated
   paths inside `coordinatorMode.ts`'s worked examples at `:193-369`), everything
   resolves. One genuine out-of-repo citation the report's carve-out does not
   name: `src/utils/computerUse/setup.ts:21` cites
   `apps/desktop/src/main/local-agent-mode/systemPrompt.ts:314`, an upstream
   repo — same class as the `.jsx` prototype anchors, so the bill stands.

### The four false-positive clearances — all correct

The brief asked me to treat a wrong clearance as seriously as a wrong flag.

- **`engineTypeDriftCheck.ts`** — clearance **upgraded from reasoning to proof.**
  The report argues it is included because `app/sidecar/tsconfig.json` has
  `"include": ["./**/*.ts", ...]`. I confirmed the include and then ran
  `bunx tsc --noEmit --listFiles -p app/sidecar/tsconfig.json`, which emits the
  file in its program (1 match). It is a live compile-time tripwire
  (`Assert<IsMutuallyAssignable<...>>` over the four snapshot↔engine types,
  `:14-29`). **Do not delete.**
- **`vite-env.d.ts`** — correct. `app/renderer/src/vite-env.d.ts` is three lines:
  `/// <reference types="vite/client" />` and `declare module '*.css'`. Ambient
  declarations are consumed by the compiler, never imported. **Do not delete.**
- **The `Action*Icon` set** — correct, and it is the strongest of the four.
  `SessionActionIcons.tsx:34` `SessionActionIcon` dispatches to every glyph
  in-file, and `ActionBranchIcon`/`ActionExportIcon` are additionally imported by
  `SessionActionDialogs.tsx:36`. The closed-union tripwire the report praises is
  real: `const exhaustive: never = kind` at `:63`. **Do not delete.**
- **The nine `createReal*` factories** — correct; see F11, including the two
  cross-file cases the report properly excluded. **Do not delete.**

## Findings the original report missed

Verified to the same bar as the above.

1. **`agentTranscriptStateWord` (`app/renderer/src/agentIdentity.ts:274`) is dead
   by transitivity, and two `PARITY-LEDGER` rows assert the opposite.** Its only
   consumer is the dead `AgentStateWord` (`AgentChrome.tsx:17,141`).
   `PARITY-LEDGER.md:996` states it is "Rendered by `AgentStateWord` … in the
   `/tasks` Workers-tab worker row (`TasksDialog.tsx:466`)" and concludes "The
   function is live with a real production consumer, so this is **no longer a
   tested dead export**"; `:1491` repeats the claim for the worker row. On disk,
   `TasksDialog.tsx`'s `WorkerRow` (`:460-475`) renders `AgentStateLabel` at
   `:529`. The ledger is the artefact that would mislead the next session, and it
   is wrong in the direction that prevents cleanup. **Disposition:** correct both
   ledger rows, then delete the pair together.

2. **`REPL.tsx:3271-3294` re-enqueues a queued message with its `MessageOrigin`
   and `uuid` stripped.** On `queryGuard.tryStart() === null`, `onQuery` replays
   the user text as `enqueue({ value: msg, mode: 'prompt' })` — before
   `deferredOrigin` is computed at `:3298`. For a deferred continuation this loses
   the origin irrecoverably, so no later turn can settle the registration; it is a
   strictly worse variant of F1's leak, and it is silent. It is also wrong
   independently of F1: any origin-carrying queued command (task notifications
   carry `origin` too, `messageQueueManager.ts:179-195`) is downgraded to an
   anonymous prompt by a concurrency race. **Disposition:** preserve `origin` and
   `uuid` on the replay.

3. **`AGENT_MODE_VERB_TYPES` (`app/shared/protocol.ts:1382`) has no code
   consumer** — only three prose mentions in `sidecarServer.ts` comments. See F14.
   Flagged separately because an inbound-vocabulary allowlist that nothing
   validates against is a §5 question, not a dead-export question, and it should
   not be resolved by deletion without someone checking which of the two it is.

## Not settled

- **The 454 / 475 aggregates in F12.** Neither the report nor I established them;
  both need a real import-graph pass. Marked UNPROVEN above rather than inherited.
- **F1's blast radius across sessions.** I proved the leak bricks *its own*
  process. Whether a second cat-code process on the same machine is also blocked
  depends on the lock target paths being per-session (`session-<id>.lock`) versus
  shared, which I did not exercise with two processes. The single-process outcome
  is proven and is on its own sufficient for the HIGH.
- **Line-number accuracy of the ~200 prototype `.jsx` anchors.** Same position as
  the report: the prototype tree is outside the repo, so I verified only that the
  anchors are intentional, not that any given line still matches.
