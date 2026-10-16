# Workspace simplification audit

Date: 2026-10-15. Requested lens: ponytail, smallest complete implementation.

Implementation: see the [implementation and validation record](2026-10-15-workspace-simplification-implementation.md). Source anchors below describe the audited baseline `008dc331`; removed paths are historical evidence.

## Assessment

Yes, there are worthwhile simplifications. The clearest opportunities are
unfinished retirements: a feature moves to a new owner, while its previous
protocol, state, tests, and compatibility options remain maintained.

The recommended direction is to finish those retirements and remove redundant
state. There is no evidence here that replacing the desktop architecture,
introducing another state framework, or splitting every large file would help.
Recent history, credential, and lifecycle repairs encode real failure cases.
They should survive cleanup.

This report contains eleven simplification findings. Three fresh subagents
independently verified them before implementation; their verdicts and corrections
are recorded below. F8 needs a separate reservation-race regression and repair
before changing allocation behavior. These are maintenance findings, not eleven
claimed production bugs. Some remove unused internal contracts and therefore
require coordinated protocol and decision-record changes. No application code or
tests were changed for this audit or its verification.

## Scope and evidence

The history window starts **2026-07-15 00:00 Asia/Bangkok**. The initial surveyed
HEAD was `428b27ebb4e3189e6a933a7929d2c36f40775b12`; the last commit before the
window was `3e7aa4ee6f2e2e4bb4e6a2a35b571ec71e84c334` (July 14). At that
initial HEAD, the window contained **2,443 reachable commits** and the endpoint
diff contained **2,845 changed tracked text files**, including **798 under
`docs/`**. These are scope measurements, not a count of independently reviewed
changes. Merge ancestry is included; binary numstat entries are excluded.

Other sessions committed plugin and peripheral-qualification work during the
audit, advancing HEAD to `f6a302270ec8b4707dceada628a5ee9d1d2873c8`. The source
anchors used for the findings were unchanged. Foreign edits and the two
untracked lid-closed HTML mockups were left alone.

The method was a workspace-wide history/file inventory followed by parallel
source reviews and caller tracing. Each retained candidate was checked against
its current owner, production callers, relevant tests, and history. This is a
broad survey with detailed follow-through on the findings below; it is **not a
line-by-line review of every file or commit**.

| Area | Depth and result |
|---|---|
| Engine goals, workers, account/send boundary | Detailed candidate and caller review; four findings. |
| Desktop host, main, preload, sidecar, protocol | Detailed retired-route and recovery review; three findings. |
| Renderer settings, analytics, session composition | Detailed consumer/state review; two findings. |
| Build, dependencies, migration fixtures, test tooling | Inventory and selected owner review; two findings. |
| Transcript/handoff, account leases, streaming/scrolling | Reviewed as preservation constraints; no broad deletion recommended. |
| Native lid-closed code | Preparation-code and structural review only; no full Swift or hardware audit. |
| Vendored code, every terminal command/tool, archived experiments | Inventory/routing coverage only; not exhaustively audited. |

## Findings at a glance

Confidence refers to the evidence for the recommendation. Scope includes the
callers, fixtures, and contracts that must change together.

| ID | Simplification | Confidence | Scope / constraint |
|---|---|---|---|
| F1 | Retire unread per-session settings metadata feeds | High | Medium; keep host inventory and shared builders. |
| F2 | Retire the unused per-session statistics route | High | Medium; breaking internal wire retirement. |
| F3 | Remove obsolete session OAuth state and transport | High | Small renderer deletion first; medium protocol follow-up. |
| F4 | Expose only reachable project-recovery states | High | Small/medium; preserve legacy journal recovery. |
| F5 | Stop persisting the unread `activeWorkers` index | High | Small; retain worker history and atomic writes. |
| F6 | Remove unused standalone component state modes | High | Small; update tests to use the shipped ownership contract. |
| F7 | Remove ignored goal-action arguments and dead helper | High | Small; no persisted format change. |
| F8 | Make worker naming match its single actual pool | Direction confirmed | Allocation caller changes gated on the newly reproduced reservation race. |
| F9 | Test credential authorization through the real send entry | High | Small payoff; preserve all credential checks. |
| F10 | Retire the two adopted migration harnesses | High | Small; remove the generator target simultaneously. |
| F11 | Replace cleanup source-string tests with lifetime checks | Demonstrated | Small test/tooling change; retain unique cleanup coverage. |

## F1. Retire unread per-session extensions and memory feeds

**Evidence.** Durable Settings inventory became the product owner in
`f703de83` (September 26). The current
[SettingsShell read](../../app/renderer/src/SettingsShell.tsx#L238) calls
`readSettingsInventory()` and passes `inventory.extensions` and
`inventory.memory` to its panels at lines 578 and 582.

Meanwhile, [App.tsx:843](../../app/renderer/src/App.tsx#L843) still maintains an
extensions reducer whose state value has no product reader. Its imported
`selectExtensionsSnapshot` is unused. The memory half of
[goalMemoryState.ts](../../app/renderer/src/goalMemoryState.ts#L10) similarly
stores `memory.snapshot`; `selectMemorySnapshot()` has only test consumers.

This is more than a dormant selector. Session startup still awaits
[loadExtensionsSnapshot](../../app/sidecar/sessionController.ts#L502), creates
the session memory domain at line 883 and extensions domain at line 895, then
sends/subscribes/replays the corresponding frames in `sidecarServer.ts`.

**Smallest change.** Remove the unused session publishers, subscriptions,
replay entries, frame variants, renderer stores, and their exclusive tests.
Keep `loadExtensionsSnapshot()` and `readMemorySnapshotOnce()` because
`settingsInventoryWorker.ts` actively uses them. Keep shared metadata value types
such as `ExtensionsSnapshot`, `MemorySnapshot`, and their child types; only the
obsolete frame wrappers are retirement candidates. Keep the goal half of
`goalMemoryState` and the agent-config feed used by composer mentions.

The renderer modules are not wholly dead either. `SettingsExtensions.tsx` still
uses `selectSkillGroups()` and `selectHookGroups()` from `extensionsState.ts`;
`MemoryPage.tsx` uses `selectMemoryInstructionCounts()` and
`selectInstructionFilesByType()` from `goalMemoryState.ts`. Preserve those
helpers, constants, and their behavioral tests when removing session storage.

**Reach and risk.** This spans `sessionController`, `index`, sidecar options,
`sidecarServer`, protocol/replay inventories, batched reducers, App, and fixtures.
Do not delete settings panels, memory readers, live MCP preparation, slash
catalogs, or engine memory behavior. Apply protocol version discipline when
removing frame kinds. The duplicate startup work is source-confirmed; no launch
time or RAM improvement was measured.

**Verification needed.** Settings inventory access/worker tests,
`SettingsShell.dom.test.ts`, extensions/memory owner tests, goal reducer tests,
sidecar attach and replay tests, both desktop typechecks, and renderer build.

## F2. Retire the unused per-session statistics route

**Evidence.** [preload.queryStats](../../app/preload/preload.ts#L438) has no
production caller. Its complete main relay, sidecar schema/dispatch, replay
kind, response projection, cache, and renderer reducer remain. Current
[UsagePage rendering](../../app/renderer/src/App.tsx#L4919) uses the independent
usage dashboard worker instead. The old state even documents this at
[accountsState.ts:87](../../app/renderer/src/accountsState.ts#L87).

The dashboard replacement landed in `e7b22b3a` (September 15). A later cleanup,
`1a3c35a6` (September 25), removed an obsolete accounts-worker analytics path
but retained this session path. The
[protocol comment](../../app/shared/protocol.ts#L2765) explicitly preserves it
for compatibility, so retirement must amend that decision rather than treating
the current implementation as accidental.

**Smallest change.** Remove `stats.query` / `stats.usage.snapshot` end to end,
including `queryStats`, its IPC channel, legacy types, `activeStatsRange`,
`usageStats`, and `selectUsageStatsForRange`. Delete the exclusive projection,
five-second cache, and mutable test seam in
[statsDomain.ts:30-162](../../app/sidecar/statsDomain.ts#L30).

**Reach and risk.** `statsDomain.ts` is not wholly dead:
[collectUsageDashboard](../../app/sidecar/statsDomain.ts#L165) is still used by
the current worker and must remain or move with its imports. Keep terminal
`src/utils/stats.ts`, the dashboard index, last-good/error behavior, closed
schemas, and redaction. Update protocol version, receiving schemas, preload and
hardening inventories, replay tables, fixtures, and the usage decision together.

**Verification needed.** Usage worker/publication/dashboard, accounts reducer,
preload, replay and sidecar protocol tests; desktop typechecks and renderer
build. The Electron hardening run needs its existing launch authorization.

## F3. Finish moving account management out of sessions

**Evidence.** `4cc0b550` (October 3) moved account management and first-run login
to `manageAccount()` and an app-owned worker. App consumes the host
`account-oauth` event and its own `appOAuthProgress`. The old
[per-session OAuth map](../../app/renderer/src/accountsState.ts#L72),
`oauthReset`, and `selectOAuthProgress()` now have only test consumers.

The only production `accountVerb()` call is the pane composer switch at
[App.tsx:3925](../../app/renderer/src/App.tsx#L3925). Main still forwards the
broader session account vocabulary, and the sidecar retains session OAuth
broadcasting and OAuth-specific parking/handoff guards.

**Smallest change.** First delete the unread renderer session OAuth state,
actions, selector, and obsolete reducer tests. This local reduction requires no
wire change. Then restrict the session transport with its own switch-only subset
and receiving allowlist, and retire the old session OAuth transport in a
coordinated protocol change.

Do not narrow the shared `AccountVerbMessage` union to `account.switch`:
`AccountControlVerb` in `app/shared/accountControlWorker.ts:6` derives from it,
and `accountsDomain.runVerb()` accepts that broad domain vocabulary. The host
worker still needs login, rename, touch and OAuth commands. Preserve those shared
types, OAuth progress value types, and the broad account-result verb vocabulary.

**Reach and risk.** The follow-up spans main/preload/protocol, sidecar login
schemas and broadcasts, replay inventories, and exclusive lifecycle guards.
Keep `accountsDomain.runVerb()` and the real OAuth runners: the host worker
reuses them. Preserve pane-local account switching, host deletion/sign-out,
generation invalidation, secret/rate/size guards, and callback cancellation.
The intended ownership is recorded in
[ACCOUNTS-OWNERSHIP](../migration/decisions/ACCOUNTS-OWNERSHIP.md#L127).

**Verification needed.** Account-control session/runner suites, login DOM tests,
accounts reducer, composer switching, sidecar account boundary and preload
tests. Prove app login stays session-independent and switching still targets
the selected pane. No live login is needed for these initial checks.

## F4. Reduce retired project routing to actual message recovery

**Evidence.** Classifier routing landed September 30 (`9516f493`) and was
retired October 1 (`a549c307`). The
[controller constructor](../../app/main/projectRoutingController.ts#L51)
normalizes every unaccepted disk row into `unsent` or `uncertain` before
publishing. Current producers only reach those states plus `recovery` and
`failed`.

The active [shared vocabulary](../../app/shared/projectRouting.ts#L3) and
[ProjectRoutingBar](../../app/renderer/src/ProjectRoutingBar.tsx#L11) still
advertise `checking`, `ask`, `moving`, and a `move` choice. The parser accepts
`move`, but `resolve()` does nothing with it. `stay` is an old resend alias.

**Smallest change.** Keep a tolerant legacy disk reader, then expose a
recovery-only runtime/view type with the four reachable phases and resend /
cancel actions. Remove unreachable classifier UI branches, spinners, and
command choices. Keep the old target cwd only as recovery evidence where needed.
The retained `failed` view must describe sending/context recovery and use
resend/cancel actions. Its current "Could not move" / "Stay in chat" wording is
left over from classification, although failure now comes from the resend cwd
check. Keep that context check and never turn an unknown delivery into an
automatic resend.

**Reach and risk.** Controller/store disk-vs-runtime types, shared host
commands, IPC parsing, preload, recovery bar, and SessionPane branches must
agree. Preserve the full-payload journal, accepted-submit dedupe, unknown-delivery
warning, explicit resend, receipt timeout, publish-before-forward behavior,
readiness and cwd checks, and unreadable-store refusal. Removing the journal
itself would risk lost or duplicate input.

**Verification needed.** `projectRoutingRecovery.test.ts` already covers old
checking/ask/moving records entering direct recovery. Retain those cases, update
command-schema tests, and exercise the recovery bar. Then typecheck/build the
desktop. Do not turn this into a workspace-jump redesign.

## F5. Remove the persisted worker index nobody reads

**Evidence.** [workerState.ts](../../src/utils/workerState.ts#L27) persists both
`activeWorkers` and `knownWorkers`. Repository searches found every production
reference to `activeWorkers` inside its own normalization, initialization,
spawn maintenance, or terminal cleanup. Production callers use `knownWorkers`,
which already carries handle, status, and identity. This owner was copied during
Agent Mode retirement in `7d5c54a8` (September 7).

**Smallest change.** Persist `knownWorkers` alone. Remove the extra field,
normalization loop, initializer, spawn index writes, and terminal cleanup loops.
Ignore the extra field in older JSON records rather than rewriting saved history.

**Reach and risk.** Update `workerState.test.ts` and worker-state fixtures in
SendMessageTool, ResumeAgentTool, and `resolveAgentTarget.test.ts`. Preserve the
terminal-before-spawn regression assertions even when deleting assertions about
the obsolete index. Keep all `knownWorkers` history, serialized writes, atomic
rename, captured state paths, and the legacy coordinator fallback.

**Verification needed.** Worker-state, target-resolution, send/resume-agent,
agent lifecycle and goal-dependency tests, followed by the required engine dev
build. The expected benefit is less duplicated state maintenance and fewer
branches. File-write frequency does not change.

## F6. Remove standalone state modes the product never uses

**Evidence.** [UsagePage.tsx:41-57](../../app/renderer/src/UsagePage.tsx#L41)
supports both supplied selection and `localSelection`, updating the latter even
in controlled use. Its only production caller always passes `selection` and
`onSelectionChange`. Similarly,
[SessionPane.tsx:536](../../app/renderer/src/SessionPane.tsx#L536) keeps a local
history-navigation store and reset effect, although App always supplies
`historyNav` and `onHistoryNavChange` at lines 4319-4320.

The analytics fallback dates to `6801555b` (September 16); the history fallback
remained when state ownership moved to App in `14dff200` (October 11).

**Smallest change.** Make those paired props required and use App as the sole
owner. Delete the two local stores, fallback branches, and local history reset
effect. Give standalone tests a small stateful rendering wrapper so their
interactions exercise the shipped contract.

**Reach and risk.** Update App, component prop types, UsagePage DOM/static
tests, `sessionPaneTestProps.ts`, and direct pane mounts in App, composer,
paste, diagnostics, pane-structure and scroll-memory tests. Interactive history
tests need a stateful wrapper; static fixtures can supply explicit inert props.
Preserve App's per-session history
navigation so drafts survive pane remounts. Keep local hover/scroll state and
focus behavior. This finding does not generalize to every controlled/uncontrolled
component: question drafts can legitimately begin undefined in production.

**Verification needed.** UsagePage DOM tests, composer history/draft interaction,
App pane-remount checks, desktop typecheck, and renderer build.

## F7. Delete ignored goal-action arguments

**Evidence.** [threadGoalActions.ts:88](../../src/utils/threadGoalActions.ts#L88)
accepts `objective` and `resetWorkers` as `_objective` / `_resetWorkers` without
using them. The same leftovers exist on status updates, and creation ignores
`resetWorkers`. Callers still pass misleading values such as
`objective: ''` and `resetWorkers: true`. The
[completeThreadGoalAction helper](../../src/utils/threadGoalActions.ts#L254)
has no callers at all.

These were left behind when `7d5c54a8` removed Agent Mode's
`updateSessionObjective()` on September 7.

**Smallest change.** Remove ignored parameters from the three signatures and
callers; delete the unused completion wrapper. Keep the objective used to create
the actual goal. Remove the obsolete test explanation about the deleted API.

**Reach and risk.** CreateGoalTool, UpdateGoalTool, `/goal`, REPL status actions,
and their tests must compile together. Preserve goal/revision fencing,
transition authority, persistence, and App state updates. Do not make the old
flags meaningful by reintroducing worker-reset side effects.

**Verification needed.** Goal-action, goal command, CreateGoalTool and
UpdateGoalTool tests, plus the engine dev build. No storage or protocol migration
is required.

## F8. Make worker naming match its one actual pool

**Evidence.** [workerNames.ts](../../src/utils/workerNames.ts#L19) has exactly
one constant name pool but retains a multi-pool cursor map, ignored agent-type
and `allowGeneric` arguments, nullable results that cannot be null, and a suffix
fallback loop that returns on its first iteration. Production callers still
carry impossible-null fallback paths. `reserveWorkerName()` has only test
callers; production uses `tryReserveWorkerName()`.

The generic-only implementation came from `7d5c54a8` (September 7); the pool was
expanded in `e3864a2f` (September 12).

**Smallest change.** Use one cursor and nonnullable candidate/allocation
functions that accept reserved names. Remove ignored arguments, impossible-null
branches, the redundant fallback loop, and the test-only compatibility wrapper.

**Reach and risk.** Update `AgentTool.tsx`, `runAgent.ts`, and naming/agent tests.
Preserve random initial offset, rotation, suffix order, case folding, exclusions,
and release cleanup. Keep candidate selection separate from reservation: team
allocation awaits external allocation between them and still needs conflict
retry. Combining those stages would lose a real ownership distinction.

**Independent verification correction.** The current automatic team path at
[AgentTool.tsx:462-474](../../src/tools/AgentTool/AgentTool.tsx#L462) awaits a
team allocation and ignores a false result from `tryReserveWorkerName()`. A
controlled async reproduction against the real `resolveSystemSubagentName()`
showed an explicit non-team caller reserving `Ada` during that await; the
automatic caller then also returned `Ada` as its own process reservation.
Releasing the automatic caller's claimed reservation freed the explicit caller's
hold. The team allocator was mocked to control timing; name selection, explicit
reservation, and automatic result handling used production code. This establishes
a pre-existing ownership failure under that ordering, not a tested production
team-file transaction.

F8 is therefore not a routine allocation-caller cleanup. Add a targeted race
regression and resolve the ownership failure before simplifying those callers;
account for the already-issued external allocation when process reservation
fails. Do not just retry and leave a live team allocation behind, or release
another caller's reservation. No repair was implemented during verification.

**Verification needed.** Worker-name sequence/exhaustion/collision tests and the
AgentTool/runAgent suites, followed by the engine dev build.

## F9. Remove the credential entry point used only by tests

**Evidence.**
[authorizeCodexCredentialUse](../../src/services/api/codexCredentialUse.ts#L577)
has three callers, all in its test file. It repeats the lifecycle transaction
and error mapping around the private `authorizeUnderPermit()` used by the real
`startCodexCredentialSend()` boundary immediately below it. Both were introduced
in `91bdd14c` (September 12).

**Smallest change.** Move the three retained scenarios to
`startCodexCredentialSend(handle, authorized => authorized, options)`, then delete
the standalone authorizer. For denials, assert that the callback never runs.

**Tests to retain.** Legacy vault tagging and generation-one handle; tagged
credentials with missing lifecycle; changed-store refusal without token text in
errors (`codexCredentialUse.test.ts` around lines 294, 337, and 373).

**Reach and risk.** The adapter, websocket transport, usage requests, and image
tool already use the real send boundary and need no new wrapper. Preserve the
private authorizer, bootstrap, immutable handles, generation/profile validation,
lock coverage during send initiation, release before response consumption, and
redacted errors. The production deletion is only about 25 lines; its benefit is
one fewer security entry point and stronger test ownership.

**Verification needed.** Credential-use tests first, then isolated credential
and adapter boundary suites. Never run these against the real account store.

## F10. Retire the two adopted migration harnesses

**Evidence.** the baseline `renderer-theme/README.md` and
`scripts/typecheck/renderer-engine-types/README.md`
still describe adoption into a future renderer. The actual app has its theme and
isolated type configuration already. CLAUDE.md calls both legacy harnesses and
says not to extend them.

They originated July 2 (`63657551`), before the window, but the old snapshots
continued receiving edits during this window. The two directories contain
**12 tracked files / 1,501 lines**, including declarations, documentation and a
separate lockfile. This is their present footprint, not a promised net saving.

**Smallest change.** Remove both obsolete directories and their active map/root
references. In the same change, remove the legacy output target from
[generate-sdk-types.ts:8](../../scripts/generate-sdk-types.ts#L8); otherwise its
next run fails reading the deleted file.

**Reach and risk.** Root `tsconfig.json` implicitly includes the old fixture
through `scripts`, even without an import. Keep the current `app/shared`
snapshots, canonical engine types, sidecar drift checks, and active app theme.
Git retains the original adoption evidence. This removes a redundant package
and snapshot target; it does not change the running UI.

**Verification needed.** Run the SDK generator in a clean temporary snapshot,
check generated diffs, desktop/sidecar typechecks and renderer build, then map
lint and link checks. Do not edit generated declarations manually.

## F11. Replace cleanup source greps that miss the failure they name

**Evidence.**
[harnessDemoSource.test.ts:4](../../app/scripts/harnessDemoSource.test.ts#L4)
claims cleanup is reachable on every exit path but only checks substrings.
[visualAcceptanceSource.test.ts:60](../../app/scripts/visualAcceptanceSource.test.ts#L60)
uses the same pattern. Cleanup repairs were made in July/August, including
`6a4264a3` (August 9); the capture harness arrived in `0648513d` (August 22).

The existing demo source test was copied into three temporary fixture folders.
No production file was edited and no Electron code was executed:

| Fixture | Existing test result | Meaning |
|---|---|---|
| Unchanged source | 2 pass | Baseline. |
| Move `await cleanup()` out of `finally` and after the catch | 2 pass | Early returns can now skip cleanup, but every source assertion still passes. |
| Rename `cleanup()` to `cleanupOwnedChildren()` everywhere | 1 pass, 1 fail | A behavior-preserving identifier change breaks the guard. |

The failing rename assertion expected the exact function declaration. The
broken-lifetime mutation preserved that declaration and all the other strings.
This demonstrates both missed behavior and unnecessary refactoring friction.

**Smallest change.** Replace the cleanup source-shape case with focused isolated
runner checks using fake build/child executables and temporary directories.
Exercise early build failure, failure after a child starts, and completion;
assert owned children and scratch output are cleaned before exit. A bounded
copied-runner probe confirmed this is feasible with the existing scripts and
launcher helper: PATH fakes for `bun`/`bunx`/Electron, harmless driver source for
`Bun.build()`, and a preloaded readiness-fetch fake. Use one focused table-driven
check with these fixtures, not a generic runner framework or a production seam.

Both runners create scratch/config directories before entering `try/finally`
(`harness-demo.ts:34-37`, `visual-acceptance.ts:53-74`); the visual runner also
writes its optional usage fixture there. Failures in that setup are currently
outside the cleanup guard. This gap was identified by source inspection, not a
reproduced setup failure, and must be covered before claiming cleanup on every
exit path. Keep requested capture output; cleanup assertions concern transient
configuration/work directories and owned children.

**Reach and risk.** Existing `devLauncher.test.ts` covers termination mechanics,
but cannot prove the harness reaches cleanup. Therefore this is a replacement,
not permission to delete its unique lifetime coverage. Keep independent
no-focus, isolated-state, security, package, and generated-contract guards.
The driver shutdown-order test is separate; if replaced, use fake Electron to
verify `app.quit()` precedes forced exit. Do not classify all source tests as junk.

**Verification needed.** The new lifetime test must fail on the
cleanup-outside-finally mutation and survive the rename. Run both harness test
files and launcher tests. Real GUI acceptance remains a separate boundary.

## Suggested execution order

1. Land local deletions first: F5, F7, F9 and F6 in small owner-specific
   changes. Each can be reviewed without changing a wire contract.
2. Replace F11's weak cleanup checks, then retire F10's adopted fixtures with
   their generator target. Keep these independent of feature work.
3. Retire F1/F2/F3 protocol slices in coherent batches with version/decision
   updates. Start F3 with its renderer-only deletion if a smaller first step helps.
4. Narrow F4's runtime vocabulary while retaining tolerant legacy recovery.
5. Handle F8's reproduced reservation race in its own regression/repair batch
   before simplifying allocation callers. Keep unrelated naming API deletion
   separate if that makes the ownership proof easier to review.

Do not bundle these into one workspace refactor. Count deleted owners, states,
and contracts as the outcome; a target LOC reduction would reward the wrong cuts.

## Candidates deliberately retained

- Navigation selection versus the last active pane carries different page/chat
  context. They are not safely interchangeable state values.
- Account inventory, leases, token lifecycle and durable attempts protect
  different races. Similar-looking records are not evidence of duplication.
- Transcript ancestry, durable handoff/release, worker terminal outcomes,
  migration fallback, atomic persistence and unknown-delivery recovery remain.
- Shared NDJSON worker mechanics are already consolidated. Receiving validators
  enforce distinct policies and should not be merged just to reduce files.
- `AgentRoleDot` / `AgentStateWord` have no product rendering caller but remain
  design-sync exports under a documented operator parity decision. They need a
  design-library retirement decision, not an automatic dead-code deletion.
- Default-off task restoration has recent experiment documentation. Being gated
  is not evidence that the experiment is abandoned.
- Persisted scheduler wake keys may be overly durable, but changing them needs
  independent restart/multiple-scheduler proof. The stronger deletions above
  should come first; retain attempt/owner/revision/expiry fencing.
- A dependency reference sweep produced only expected type-package, CLI and CSS
  cases without literal source imports. It did not justify removing a dependency.
- Native guardian, journal, watchdog and restoration evidence protect hardware
  recovery. No simplification of those protections is recommended by this audit.

## Verification performed and limits

These checks ran against the **existing implementation**, not a proposed
refactor. Engine tests used isolated temporary `CLAUDE_CONFIG_DIR` directories;
DOM suites ran in separate Bun processes.

| Check | Observed result |
|---|---|
| Worker names, worker state, credential use, goal actions/attempt/scheduler (six files) | 71 pass, 0 fail; 246 assertions. |
| Project-routing recovery and shared command schema | 11 pass, 0 fail; 48 assertions. |
| Account-control session | 8 pass, 0 fail; 15 assertions. |
| SettingsShell DOM, composer interaction DOM, UsagePage DOM | 31 pass, 0 fail; 192 assertions. |
| Copied demo source tests: baseline / broken cleanup / harmless rename | 2 pass / 2 pass / 1 expected failure, as described in F11. |

Source searches and caller tracing establish the listed ownership/usage facts;
the tests provide baseline context. None proves an unimplemented deletion is
safe. No full engine build, full desktop suite, live model/account operation,
GUI launch, packaged installation, or physical lid test was run. Native Swift,
all inherited terminal features, every dependency's internals, and every
experimental harness were not comprehensively reviewed.

Initial report validation passed: map lint (18 maps, zero warnings), whitespace
checks, and 28 local source/document links including their numeric line anchors.
No speed, memory, or reliability improvement is claimed without implementing and
measuring the corresponding change.

## Independent verification before implementation

At the user's request, three fresh subagents independently checked the committed
report (`3f0750f2461630cf9acec51735235c700c8a0b4a`) against current source. They
were separate from the original audit authors, used fresh contexts, and divided
all eleven findings across desktop/runtime, engine, and renderer/tooling lanes.
Each traced production and test consumers and challenged the proposed deletion
scope. The parent checked the material corrections against source and updated
this report. No production simplification or test edit has started.

| Finding | Independent verdict | Correction or implementation constraint |
|---|---|---|
| F1 | Confirmed, scope clarified | Remove session stores/feeds, retaining the live Settings grouping/count helpers and shared metadata types. |
| F2 | Confirmed | Intentional internal compatibility retirement; preserve the independent dashboard and terminal stats, and bump the session protocol coherently. |
| F3 | Scope corrected | Narrow only session transport. The broad account/domain/result vocabulary remains required by the host worker. |
| F4 | Confirmed, retained UI corrected in the plan | Keep legacy disk recovery; change failed-state move/stay language to sending/context recovery with resend/cancel. |
| F5 | Confirmed | Preserve durable `knownWorkers`, terminal-before-spawn assertions, serialization and atomic rename. |
| F6 | Confirmed | No additional product, preview or harness mounts found; interactive tests need actual parent state, not inert callbacks. |
| F7 | Confirmed | Delete ignored arguments and the unused helper; retain creation's real objective and goal fencing. |
| F8 | Needs correction before allocation-caller cleanup | Real resolver reproduced duplicate process reservation ownership under a controlled external-allocation await; add a separate race regression and ownership repair. |
| F9 | Confirmed | Move the three retained scenarios to the send boundary and assert denial never invokes its callback. |
| F10 | Confirmed, generator consequence demonstrated | Remove legacy output and generator target together; preserve active snapshots/drift checks/theme. |
| F11 | Confirmed, test plan qualified | A bounded copied-runner lifetime check is feasible; retain capture output and independent safety guards. Pre-try setup failures still need proof. |

The F8 probe used real naming and resolver code with a deferred mocked team
allocator and isolated configuration. It proved the process-reservation failure
under that async ordering, not a durable team-store transaction. A repair must
own its process reservation across allocation and release only its own claim.
If refusal occurs after external allocation, that allocation needs deliberate
compensation; merely throwing or looping can leave a committed recipient behind.
The explicit-team path has the same post-allocation compensation concern.

Additional checks in this verification round:

| Check | Observed result and limit |
|---|---|
| Desktop schemas/recovery/bar and extensions/goal-memory/accounts reducers, six files | 60 baseline tests passed using isolated configuration. |
| Worker names/state, goal actions and credential use, four files | 34 baseline tests passed using isolated configuration. |
| F8 real-resolver controlled async probe | Duplicate `Ada` ownership reproduced; releasing the automatic result freed the explicit caller's reservation. Team allocator mocked; no actual team store or network. |
| Original F11 demo source mutations independently repeated | Baseline 2 pass; broken cleanup 2 pass; harmless rename 1 pass / 1 expected failure. |
| Both copied runners across build failure, child failure and completion, plus deliberate cleanup/rename variants | 10 hermetic scenarios matched expectations. Both cleanup-after-catch mutants leaked transient directories on build failure; both renamed runners cleaned on completion. No owned children remained. |
| SDK generator in temporary copies | Baseline succeeded; deleted legacy target alone failed; removing target plus generator entry succeeded. The two active generated outputs were hash-identical to baseline. |
| Inventory and configuration parsing | The historical 2,443 / 2,845 / 798 counts and 12 legacy files / 1,501 lines were reproduced. TypeScript includes the legacy fixture and both declarations through root `scripts` input. |

The **94 passing baseline tests** in this round overlap the earlier audit's
tests; do not add them together as distinct regression coverage. Runner probes
used PATH fakes, harmless driver inputs, a readiness-fetch fake, and the existing
launcher helper. They exercised modeled lifetime paths without Electron,
network, live accounts, or production changes. The original historical test
totals were not independently recertified merely by rereading this report.

Source HEAD remained `3f0750f2` during independent review. Other sessions kept
editing lid-closed code, including the protocol, `index`, `sessionController`,
and `sidecarServer` files needed by F1-F3. Those changes were left untouched;
re-read and coordinate ownership before implementing an overlapping batch.
No full build, full suite, process-recovery qualification, real GUI, live model,
credential operation, or hardware check was performed in this verification.

The updated report passed map lint (18 maps, zero warnings), whitespace checks,
and checks of all 29 local links and 27 numeric source anchors.
