# Manual whole-Mac lid mode

Updated 2026-10-16. **Implementation and nonprivileged packaged UI verified;
real root installation/XPC and new live power trials remain pending the user's
administrator prompt. This feature is not end-to-end qualified.** No live lease
or helper installation was performed in this revision's verification.

## User-approved behavior

The user chose personal-use simplicity and confirmed: “Yes, keep all apps awake
until Stop or the timer ends.” Manual Start now works without a running Cat Code
job. It keeps the whole Mac awake for other apps. Opening/closing the lid neither
ends nor renews the original timer; there is no Continue step. Job completion,
approval/provider state and newly created work do not affect the timer.

One administrator setup grants programs in this macOS account fixed native
operations through the installed bridge. There is no protected Cat Code copy,
reopen step, Apple certificate or repeated Touch ID requirement. An app rebuild
alone does not require reauthorization; a changed native helper may need setup
repair. The native receiver retains UID, installed bridge path/signature and
per-message XPC checks. This deliberately authorizes account programs, rather
than identifying one parent Electron app. No broad sudoers capability or
arbitrary root command was added.

The numeric cup retains 15/30/60/120-minute presets. Native menu controls also
work without a composer. Setup and recovery controls are visible inside startup
trust/sign-in surfaces, without requiring a model account. Native battery,
thermal, monitoring, exclusive-override, deadline and supervision protections
remain. Start requires an initially open lid. Closing/quitting Cat Code still
ends its supervision and restores sleep. Ordinary Sleep can be blocked while
active; End mode and sleep restores first. External simultaneous override writes
cannot be perfectly attributed. All experimental leases remain independently
capped at 60 seconds.

See the [specification](../design/2026-10-13-lid-closed-mode-spec.md),
[runtime contract](../design/2026-10-15-lid-closed-runtime-contract.md) and
[local-use decision](../migration/decisions/LOCAL-USE-CONTRACT.md).

## Review and repairs

`review-impl` used distinct lifecycle/UX, security/contracts and execution lanes,
followed by parent validation, fixes and re-execution. Five findings: one HIGH,
two MEDIUM, two LOW, all user-visible and repaired; no deferred finding.

| Severity | Finding | Validation and repair |
|---|---|---|
| HIGH | Setup approved hashes were derived by re-reading mutable account-owned staging. | A same-account substitution during code-sign inspection changed the root-accepted removal payload. The regression failed before repair. All expected digests now come from verified/generated memory buffers; it passes afterward. Root-stage digest checking remains. No root execution was used for this test. |
| MEDIUM | Native Start lacked the initial-open check, newly exposed by account-wide callers. | Real Swift controller accepted a closed-lid Start and changed the power closure once. A regression failed with `invalid command accepted`; the native admission guard now rejects before intent/effects. Later lid transitions remain inert. This inherited mechanism was fixed in the changed native owner. |
| MEDIUM | First-run sign-in hid the setup notice from accessibility/focus. | Actual packaged AX showed only sign-in after native-menu activation. The shared notice now renders inside startup dialog ownership, once. Regression fails on the unchanged startup surface; final packaged AX exposes Set up and start and Cancel without an account. |
| LOW | Detached owner could leave native menu showing stale active actions. | Detachment now clears checks and disables commands. Reopened-window AX shows unselected presets and disabled Stop/Sleep. Parked-process menu state was source-checked, not independently observed because UI observation reactivated the window. |
| LOW | Native menu insertion was not published reliably at initial load. | Packaged menu initially lacked the control. Publishing the mutated application menu and syncing at ready-to-show produces all four presets in actual native AX. |

A cancellation check also prevents delayed hardware inspection from continuing
setup after cancellation. The main owner emits no work windows or temporary
agent instructions. Old `lid.work` observations are consumed without renderer
forwarding/replay. Old sidecar inbound window controls remain dormant
compatibility code; they were not claimed to be deleted or universally inert.

Provenance: no dependencies, permission-rule changes, test skips, installed-app
replacement or push. Removed `identity.test.ts` exercised the deleted
app-exclusive parent/protected-copy/constraint contract; keeping it would require
retaining the superseded product behavior. Native configuration/signing tests
replace only the new account-grant validation contract. Existing safety/recovery
and trial-cap tests remain. Old work-enrollment/reopen/Continue assertions were
removed along with those explicitly superseded behaviors. Packaging changes
remove exact Electron library constraints and custom hard/kill flags; ASAR/fuses
and hardened native signing remain. Root configuration advances to v3; old
readers reject it, and restore-first setup preserves journal v1 compatibility.

## Executed verification

Build/test artifacts and detailed logs are under
`/private/tmp/cat-lid-simple-20261016` (temporary, not durable repository assets).
Clean archived snapshots exclude unrelated dirty shared-tree work. The full
suite snapshot starts at `672e46c3`; the final package starts at `4c0d52e1`, with
only this task's source overlaid. Later UI fixes received focused tests,
typecheck, packaging, smoke and hardening checks.

| Boundary | Result | Practical limit |
|---|---|---|
| Main/shared/assets plus final renderer/startup DOM | 12 passed, 83 assertions | Real owner/adapter rendering with boundary fixtures; no XPC/root power claim. |
| Native lifecycle/configuration plus owner/assets/shared review repairs | 11 passed, 82 assertions | Production Swift controller/journal and compiled helper configuration/signing; power closures are fixtures. |
| Regressions | No-job start fails predecessor; lid opening ending fails predecessor/mutant; native closed Start, mutable staging and startup notice fail before fixes and pass after | Native trial-cap mutant also fails for the intended activation-delay bound. |
| Startup surface siblings | 22 passed, 98 assertions | Existing startup/OAuth rendering contracts remain intact. |
| Desktop and scoped sidecar typechecks | Passed | Sidecar wrapper reports existing upstream diagnostics separately. |
| Final packaged build and full packaged smoke | Passed | Real ad-hoc package launches outside checkout with isolated state; not persistent helper authority. |
| Documentation map lint and diff checks | Passed | 18 maps, no warnings; staged diff checked. |
| Final hardening | 19/19 passed | Production renderer and main policy; helper root transport is separate. |
| Full desktop suite | 6,016 passed, 3 existing skips, 2 failed across 421 files | Both scheduled-task failures reproduce on unchanged `672e46c3`: `/var` versus `/private/var` expected/actual cwd. No unrelated repair. |
| Actual packaged AX | Native four presets; first-run setup/Cancel; Cancel removes notice; reopened menu unselected with Stop/Sleep disabled | Isolated Cat Code Dev, empty accounts, no model fixture or real credentials. No active root-backed UI claim. |
| Actual process exit | Native Quit PID 90636 absent at OS check; isolated SIGTERM checks exited in 161/163 ms | The user's `3e8992b4` repair is preserved. A lifecycle log is not exit evidence. |

The original quit bug was introduced in the earlier lid cleanup. The user found
and repaired it; credit and detailed evidence are in the
[quit investigation](../reports/2026-10-16-packaged-quit-regression.md).

Earlier battery-powered physical progress, ordinary Sleep limitation, real
Sleep/input wake and native recovery evidence remain in the
[physical](2026-10-14-lid-closed-physical-results.md),
[Sleep](2026-10-15-lid-closed-sleep-results.md) and
[experiment](2026-10-14-lid-closed-pmset-experiment.md) records. They establish
unchanged power mechanisms on this Mac, not the new account grant or timer
behavior through lid reopening.

## Remaining integration work

The user was asked for readiness to complete the single macOS administrator
prompt. No answer has arrived for this verification round; no prompt or root
power test was started. Once ready, use the concrete final isolated package with
`CATCODE_LID_CLOSED_TRIAL=1`. Production validation remains intact, while the
root configuration admits one lease capped at 60 seconds and an independent
guardian removes experimental authority.

1. Through actual Set up and start, authenticate once and observe account grant,
   active all-apps notice, kernel flag, fixed deadline and root journal.
2. Exercise the installed bridge from a second account program; confirm copied
   bridge/wrong-UID callers cannot invoke it. Source and code-sign checks alone
   do not prove receiving XPC authentication.
3. Test Stop/expiry and app kill/stall restoration with bounded reinstalls as
   needed; verify kernel state, root job removal and guardian exit. A controller
   fixture is not packaged failure recovery evidence.
4. Separately coordinate only affected physical actions: new lid-open timer
   continuity and any needed Sleep check. Do not repeat all earlier physical
   qualification or infer user action from elapsed time.
5. Restore first and remove authority before waiting or discussion. Leave the
   installed normal Cat Code app and real accounts untouched.

## Observed cleanup

At the final nonprivileged check: `SleepDisabled=No`, clamshell open, installed
helper absent, both system launchd jobs absent, and no helper/experimental guardian
process present. No guardian was started in this revision, so there is no new
guardian exit code to report. Root-only historical journal/configuration evidence
is retained under `/Library/Application Support/Cat Code/LidClosed`; it cannot
activate without the helper/jobs. Tracked isolated GUI processes exited. The
normal installed Cat Code app was not replaced.
