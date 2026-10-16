# Lid-closed integration review

## Current direction, 2026-10-16

The user superseded app-exclusive/job-scoped activation with a manual whole-Mac
mode available without any Cat Code job. Account programs may invoke the fixed
native bridge after one administrator setup. Protected app copies, Continue,
job enrollment and app rebuild reauthorization have been removed. Current
implementation, review fixes and qualification limits are recorded in
[the new report](2026-10-16-systemwide-lid-mode.md).

The prior `process.exited` log was not actual exit evidence. The user identified
and repaired the quit regression in `3e8992b4`; see the
[OS-process investigation](../reports/2026-10-16-packaged-quit-regression.md).

## Historical integration record

The evidence and pending checks below describe the earlier architecture.

Updated 2026-10-16. **Qualification remains incomplete.** The certificate-free
repair pass used the existing A+C, B/security and D/execution roster, including
a B follow-up on the protected-snapshot repairs. No additional agents were
spawned for that follow-up. The earlier review is retained below as history.

## Current repair pass

| Severity | Finding | Repair and evidence |
|---|---|---|
| High | Mutable ASAR/Info.plist swap and restore passes a later static check after substituted JavaScript runs. | Reproduced in a real Electron process. Activation now requires the fixed root-controlled snapshot; source is recovery-only. Actual protected installation/RPC negative qualification remains pending. |
| High | Trial Continue can revive a retired lid-open record. | Retirement makes lid-open terminal under the transition lock. Native regression passes; removing the transition produces the intended fatal regression. |
| High | Mutable setup resources can author their own expected privileged hashes. | Sealed main embeds three asset digests and verifies buffer reads before staging. All three substitutions reject before execution/authorization; packaged helper hash matches embedded source. Initial administrator setup still assumes a trusted local build. |
| High | Installer executes installed helpers before excluding write-granting destination ancestors/ACLs. | Verified root-stage helper now checks fixed destination nodes before either installed generation executes and again after publishing. Native compilation and review pass; root preflight execution awaits administrator authentication. |
| High | An installer failure after publishing authority can appear as dismissible Unavailable. | Recheck installed authority/kernel status, retain unresolved intent even if the marker cannot be written, and run recovery. Regression fails on the preceding owner and passes after repair. |
| Medium | Actual authorization timeout displays internal shell text. | Map cancellation, timeout and other setup failures to user-facing messages. Source/type checks cover the change; revised failure copy awaits live recheck. |

Provenance: no dependencies, test skips/deletions, agent-rule changes, unrelated
subsystem repairs or installed-app replacement were added. Build changes bind
setup assets and exact libraries to the sealed package. Root configuration v2
adds `setupOnly` and an optional restrictive `applicationTrialUntil`; the older
`19c92d0b` reader explicitly requires version 1 and rejects version 2. Recovery
journal format is unchanged. `reopen` crosses the closed renderer command
boundary and launches only the fixed protected executable after work checks;
`relaunchRequired` and setup/recovery messages reach the shared shell notice.

The live administrator attempt timed out before installation. No power lease
was started. Therefore static review is not presented as proof of persistent
authority, negative XPC callers, app crash/stall restoration or active UI. See
the current [results](2026-10-15-lid-closed-integration-results.md).

## Earlier review (2026-10-15)

Scope: this task's lid-closed hunks and its supplied specification. Other
shared-tree work is excluded. `review-impl` used five risk signals (reach,
concurrency, trust boundary, runtime spread, derivation changes), with three
reviewers: A+C, B/security and D/execution. The parent validated findings, made
repairs and checked the repairs in the same pass.

**Triage:** 13 valid findings (4 high, 9 medium), 1 false positive. Repairs or
fail-closed guards are implemented. Verification is incomplete for the signed
app/helper boundary and live active UI. This is not a feature-complete verdict.
No unrelated subsystem repair was deferred as part of this pass; the concrete
signing prerequisite and remaining acceptance evidence are documented in the
[integration results](2026-10-15-lid-closed-integration-results.md).

## Findings and disposition

| # | Severity | Impact | Finding and repair | Verification |
|---|---|---|---|---|
| 1 | High | Security | Generic Electron identity admits alternate JavaScript. Require sealed payload, startup fuses and hardened, team-signed app at the native receiving boundary. Ordinary ad-hoc builds cannot install permanent authority. | Native refusal and actual UI refusal observed; alternate-main/Node/inspector probe rejected. Signed XPC authorization remains unproven. |
| 2 | High | User-visible | Unreadable native journal could appear dismissible with a false local marker. Preserve unresolved recovery. | Owner regression passes; deleting the guard produces the intended failing assertion. |
| 3 | High | User-visible | A transient thermal ending could lose protection after the reading cools. Use durable ending reason/latch. | Owner regression sees inactive context, blocked admissions and suppressed idle assertion. |
| 4 | High | User-visible | Hardened ad-hoc Electron package cannot launch under library validation. Preserve ordinary local signing and refuse privileged setup; supplied Apple identity selects the hardened branch. | Concrete dyld failure recorded; repaired ordinary package launches. Hardened signed branch remains unverified. |
| 5 | Medium | User-visible | Stale helper/app signature had no repair path. Explicit repair reauthorizes after restore-first installation. | Fake-native failure/retry and actual signing refusal UI checked; live signature replacement unproven. |
| 6 | Medium | User-visible | Cancel during the last work poll could admit work; a canceled native reply briefly emitted Active. Recheck epoch and restore late results without publishing Active. | Reviewer reproduced old emitted phases. Repaired owner assertion checks all emitted phases, not only final state. |
| 7 | Medium | User-visible | Blocked-work grace leaked into a fresh activation. Reset grace state on fresh activation. | Source/lifecycle review; timed multi-activation scenario not executed. |
| 8 | Medium | User-visible | Retry lost red recovery while pending, including failed repair. Retain recovering state through error handling and disable duplicate Retry. | Failed-repair owner test checks every emitted phase; actual unresolved retry remains red. |
| 9 | Medium | User-visible | Idle-sleep suppression survived unrelated later work indefinitely. Release it only on an explicit new user run after the window ends. | Real owned caffeinate process test passes; removing reset fails on fresh-run assertion. |
| 10 | Medium | User-visible | Expanded numeric cup lacked its approved drawing. Add raised cup and reduced-motion CSS. | Dark actual numeric presentation and DOM focus behavior observed; active steam/wheel/reduced-motion visuals unproven. |
| 11 | Medium | User-visible | Sidebar covered the shared notice, including its expanded overlay. Place notice in shared content and reserve overlay width for that notice. | Actual before/after screenshots; final light recovery text and action fully visible beside expanded sidebar. |
| 12 | Medium | User-visible | Reopening a window during cleanup could create overlapping mode owners and stale notifications. Await prior cleanup and reject old-owner emissions. | Typecheck and source review; live active close/reopen race unproven. |
| 13 | Medium | Internal | Receiving validators coerced action/status objects to strings. Require primitive strings before whitelist checks. | Typecheck and focused boundary checks; no separate malicious-object process probe. |
| 14 | Medium | Scope | Independent CreatePeer runs do not join the mode. | False positive under existing peer contract: ordinary independent sessions are not child agents. Documented exclusion; local Agent/Bash descendants remain included. |

## Provenance and effects

- New dependencies are the user-approved build-time `@electron/asar@4.3.1` and
  `@electron/fuses@2.1.3`. Lockfile changes include their dependencies and Bun's
  relocation of already-present dependency versions; no test was deleted/skipped
  to obtain a pass.
- Build changes compile/copy the narrow native helper, archive the app, pin ASAR
  integrity, disable alternate startup paths, and select signing posture.
  Ordinary local builds remain runnable but cannot acquire persistent authority.
- The native root journal is the existing recovery owner. New local
  `desktop/lid-closed-recovery.json` contains only pending intent, and is not
  shared with an older writer. Transcripts do not store an active work window.
- `lid.work` crosses main → supervisor → socket → sidecar runtime, returns
  generation/sequence-bound work observations, and is consumed before renderer
  forwarding/replay. It is deliberately not retained. Three fixed preload IPC
  channels expose only read/command/change; agents cannot author mode commands.
- Screen text lives in the shared notice/cup accessibility description. Temporary
  model context is queried by enrolled root identity and explicitly withdrawn.
  Bash's finite/service description now clarifies explicit background work.
- Sidebar's existing width token is shared with the notice only to repair the
  observed overlay defect. The sidebar's ordinary overlay behavior is retained.
- Read-only probes, tests, scratch app launches and a loopback model fixture were
  used. No helper was installed and no global sleep override changed in this pass.

## Evidence limits and next operator steps

The [results](2026-10-15-lid-closed-integration-results.md) record exact test
counts, baseline failures, actual UI labels and final cleanup. The earlier
battery/lid, Sleep and native recovery evidence is preserved separately.

Before completing the feature:

1. Complete one administrator setup of the certificate-free protected copy,
   then verify actual launch and native receiving-boundary rejection of
   substituted/unqualified callers. No certificate or repeated biometric
   approval is required; do not add DYLD/debugger exceptions.
2. Use the restrictive app-trial configuration: normal UI presets remain at
   15 minutes while the native trial cap is 60 seconds. Install with
   independent bounded cleanup, then exercise real Stop, app failure recovery,
   original-scope enrollment, protection and restoration/removal.
3. Inspect active presets, wheel gating, steam/reduced-motion, narrow/split panes,
   both appearances and contrast in the real app. Coordinate any physical lid,
   power or Sleep actions individually. Reuse unaffected native recovery results.

No completed feature or unqualified safety claim is made while these layers
remain unverified.
