# Manual whole-Mac lid mode

Updated 2026-10-16. **Real packaged setup, XPC authentication, Start/Stop, app freeze/exit
restoration and cleanup have now been observed on this Mac. The affected
physical lid-close/reopen check remains unverified.** All live leases used the
restrictive single-use 60-second trial, never an unrestricted production lease.

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

## Live qualification after administrator readiness

The user confirmed readiness for the administrator prompt. Actual packaged
Set up and start installed the root helper, daemon, watcher and independent
cleanup guardian. Root configuration v3 was read back: UID 501, explicit account
access, exact bridge requirement and restrictive application-trial expiry.
No Apple certificate or per-activation biometric mechanism was added.

| Live boundary | Observation |
|---|---|
| No-job app activation | Actual packaged AX displayed all-apps active notice and Stop/Sleep controls inside first-run sign-in; no account or job was created. Kernel flag changed No → Yes. |
| Approved account program | A separate Python-launched installed bridge returned authenticated status and changed the fixed preset from 15 to 30 minutes. The native 60-second deadline was unchanged. |
| Substituted path | A copied, still-signed bridge returned `helper-unavailable` while the installed bridge returned valid active status. |
| Receiving UID | Administrator test ran the installed signed bridge as nobody (UID 4294967294). It returned `helper-unavailable` while UID 501 status continued to succeed. Root itself is rejected earlier by `invalid-client`; that earlier root probe alone was not counted as receiving-UID proof. |
| Closed command schema | A status request with an extra arbitrary path was rejected as `invalid-command`; no arbitrary command was executed. |
| Actual expiry | Native deadline stayed exactly start + 60 seconds. Continuous observation captured active at 0.102 seconds remaining, then kernel No and root `ended`/`expired`; helper removal and guardian PID 32178 departure followed. |
| Real Stop | The app confirmed normal sleep restored. Kernel returned No, helper/jobs were removed, tracked guardian PID 18364 exited. |
| Frozen Electron main | SIGSTOP targeted only isolated PID 23677. Kernel restoration was observed 5.356468 seconds after injection; helper removal and guardian PID 26517 absence at 5.703175 seconds. Root record reported `supervision-lost`. Main was then resumed. |
| Killed Electron main | SIGKILL targeted only that isolated PID. Kernel restoration was observed after 4.760483 seconds; helper removal and guardian absence after 5.122894 seconds. Guardian PIDs 28050 (unused setup) and 29435 (active run) were absent. |
| Repair/startup recovery | Actual native Repair and retry settled the isolated pending marker before new admission. A subsequent real activation succeeded in the same process after helper replacement. |

Repeated setup found one additional MEDIUM connection-lifetime bug: a bridge
process can remain alive with an invalidated XPC connection after the temporary
helper is removed. Before repair, reinstall left the UI unresolved even though
fresh bridge probes confirmed normal sleep. Setup now closes the old connection
before replacement, and a reply without a snapshot discards its dead bridge.
The real stdin/stdout regression fails before the fix and passes afterward;
10 focused checks, 70 assertions, typecheck, rebuilt package, packaged smoke and
19/19 hardening checks pass. The fixed real repair/start path was re-executed.
This adds no production test bypass or dependency.

One expiry attempt was deliberately excluded: concurrently launching the
separate smoke/hardening app invoked restore-first startup and ended the shared
lease with reason `recovered` after about 16 seconds. This was test interference,
not timer expiry. The final expiry check ran without another Electron launch and passed: the native record reported `expired`, restored state, and the unchanged 60-second deadline.

Detailed temporary evidence: `live-observer.jsonl` (Start/Stop),
`live-stall.jsonl`, `live-crash.jsonl`, `live-expiry.jsonl`,
`wrong-uid-xpc.json`, and reconnect regression/build logs under the scratch root.
Native power observations and human-confirmed physical behavior remain separate.
Repeated test repairs are needed because the restrictive guardian removes each
trial installation; production activation after setup does not do that.

## Remaining physical qualification

Only the new lid-close/reopen timer continuity needs fresh user participation.
The current source/controller tests keep the original deadline through both
transitions, but this changed policy has not yet been observed physically.
Earlier battery/Sleep/mechanism evidence is retained; do not redo all of it.
No lid, power or Sleep action was requested or inferred during the live tests
above. Remove authority and confirm normal sleep before asking for readiness.

## Cleanup

After final expiry: `SleepDisabled=No`, clamshell open, helper absent, both launchd jobs absent and guardian PID 32178 absent. The Start/Stop, freeze, crash and expiry trials all restored sleep and removed their authority. Some unused restrictive setups expired after their 30-second admission window and also removed themselves.
The ordinary installed app and real accounts remain untouched. Retained root
journal/configuration evidence cannot activate without helper/jobs. Guardian
PID absence proves departure; the shell was not their parent, so process exit
codes were not observed directly.
