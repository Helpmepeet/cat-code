# Lid-closed power-control feasibility

Date: 2026-10-14 (Asia/Bangkok)

Historical status at f1d7ff70: Implementation blocked at the original power-control contract. The tested ad hoc helper also failed launch because of restricted entitlements on this Mac. The product feature
is not implemented. This investigation does not establish universal impossibility
on macOS; it establishes that none of the candidates examined meets the requested
contract with the current Cat Code build. No power settings were changed.

## Approved continuation on 2026-10-14

The user approved ordinary Sleep being blocked during active operation, an explicit End mode and sleep action, exclusive global-override use with disclosed indistinguishable same-value writes, and measured recovery targets rather than an unconditional guarantee. Those changes supersede the original rejection of pmset below. Implementation now proceeds through a narrowly scoped privileged helper and independent recovery watcher. The private-entitlement path remains rejected and will not be retried. Historical tests below remain evidence of the old path only.

## Original requirements that constrained the mechanism

The [product specification](../design/2026-10-13-lid-closed-mode-spec.md) and the
implementation brief require battery operation, explicit user sleep taking
precedence, bounded recovery when supervision disappears, and restoration of only
Cat Code-owned changes. A successful command is not evidence of observed sleep.
A recovery owner must function without Electron or the renderer.

## Candidates examined

| Candidate | Assessment | Outcome |
| --- | --- | --- |
| Existing `caffeinate -i` | Owns an idle-sleep assertion, not a lid-close override. | Insufficient. |
| Ordinary `PreventSystemSleep` assertion | Does not by itself establish battery or lid-close support. | Insufficient. |
| Process-owned assertion with battery and lid-close properties | Authority requires Apple-internal entitlements absent from the installed app. | Blocked on authority. |
| Root helper using `pmset disablesleep` | A watchdog could bound supervision-loss recovery, but the global sleep disable also obstructs demand sleep. Baseline restoration cannot distinguish another writer requesting the same value. | Violates required precedence and ownership. |
| Direct `kPMSetClamshellSleepState` user-client method | Shares powerd's clamshell-disable bit; closing the connection has no corresponding restore. | Violates ownership; not an assertion lease. |
| macOS external-display clamshell configuration | Apple's support guidance requires power and external accessories; a current false clamshell-sleep property does not qualify unplugged operation. | Does not establish the required battery behavior. |

The assertion candidate is based on Apple's
[private IOPM declarations](https://github.com/apple-oss-distributions/IOKitUser/blob/main/pwr_mgt.subproj/IOPMLibPrivate.h):
`com.apple.private.iokit.assertonbattery` and
`com.apple.private.iokit.assertonlidclose`. A declared entitlement is not proof of
usable authority. Administrator consent and ordinary app signing do not establish
these internal capabilities.

Apple's [powerd assertion implementation](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmconfigd/PMAssertions.c),
`callerIsEntitledToAssertion`, checks battery and lid-close properties separately.
Its root/admin check is separate. Root alone does not satisfy those entitlement
checks. `configAssertionType` treats ordinary `PreventSystemSleep` as not valid
on battery by default; `setClamshellSleepState` derives its effect from privileged
assertions and desktop mode.

The [root-domain user client](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/RootDomainUserClient.cpp),
`externalMethodDispatched`, routes the clamshell selector to the shared
`kClamshellSleepDisablePowerd` bit. `clientClose` terminates the connection without
clearing that bit. This is a private OS path, not a product API promising leases.

The [kernel power policy](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp),
`setClamShellSleepDisable`, sets or clears a bit rather than allocating client
ownership. `checkSystemSleepAllowed` checks the global sleep-disable state before
allowing idle or demand sleep. A compare-before-restore cannot identify a second
writer setting the same global value during Cat Code's interval.

Apple's [idle versus forced sleep explanation](https://developer.apple.com/library/archive/qa/qa1340/_index.html)
and [external-display troubleshooting guidance](https://support.apple.com/en-la/102501)
provide the public API and supported-configuration context.

These upstream source observations are not a reverse-engineered or executed proof
of the exact installed kernel/powerd binary. The separate helper launch failure
below establishes the current code-signing restriction, not IOPM API behavior. Live power-control experiments were
not authorized or run. A kernel extension, system security changes, or injection
into an Apple process is not an approved alternative for this feature.

## Current-machine observations

At `2026-10-13T17:06:24Z` (2026-10-14 00:06:24 Asia/Bangkok), the read-only
inspection observed macOS 26.6.2, build 25G83, an internal battery at 80 percent on
external power, an open lid, `SleepDisabled=false`,
`AppleClamshellCausesSleep=false`, and nominal thermal category.

`codesign -dv '/Applications/Cat Code.app'` reported identifier
`com.catcode.desktop`, an ad hoc signature, and no team identifier.
`codesign -d --entitlements :- '/Applications/Cat Code.app'` returned no
entitlements. The native static-code inspection independently reported both
required entitlement declarations absent. The package script signs ad hoc and
does not provision them.

The false clamshell-sleep property is an observation of existing state, not a
Cat Code change or evidence of lid-closed progress. Nominal thermal category is
not proof of reliable thermal monitoring. Exact Mac model identification was
unavailable through the sandboxed `hw.model` read; no model was inferred.

## Reproducible read-only inspection

Run from the repository root:

```sh
bun run scripts/lid-closed/inspect.ts
bun run scripts/lid-closed/inspect.ts '/Applications/Cat Code.app'
bun test scripts/lid-closed/inspect.test.ts
```

The default runner path compiles its native Swift observer in a unique temporary directory,
limits compile/run time, and removes compiler artifacts. It reads only allowlisted
power facts and static code-signing metadata. It creates no assertions, changes
no power settings, installs no helper, and requests no administrator consent.
It does not output battery serials, signatures, paths, or full registry records.

Missing facts stay unavailable/null. Signature inspection failure differs from
observed missing entitlement declarations. Even declared entitlements remain
unverified. `powerControlSupported`, `hardwareQualified`, and
`thermalMonitoringQualified` remain false: this tool cannot certify them.

## Remaining implementation and release gate

Before integrating activation, establish an available mechanism with app-scoped
ownership and explicit-sleep precedence. The preferred direction is a
process-owned lease with independent supervision, not a global sleep kill switch.
No administrator installation has been prepared because it would grant authority
to a rejected mechanism.

A target for supervision-loss recovery is **10 seconds maximum**, measured from
last successful supervision to removal of Cat Code's authority. This is a
qualification target, not a demonstrated guarantee. It must cover stalled and
killed clients and failure of the recovery owner, not merely normal shutdown.

The composer, app-wide lifecycle, work enrollment, temporary model context,
protective work reduction, persistent recovery, and live UI are still required.
There are no simulated active states or permanent away instructions added by
this change. The untracked visual references are preserved.

Once a viable candidate exists, obtain explicit approval for the exact live
power-control probe and its recovery procedure. Physical checks must capture
closed-lid workload timestamps, separate assertion/setting restoration from
observed sleep, and test battery/unplugging, explicit sleep, display/backlight,
locking, crash recovery, and interference from other keep-awake software.

## Prepared live authority probe, awaiting approval

```sh
bun run scripts/lid-closed/inspect.ts --probe-authority
```

This opt-in path is separate from the read-only observer and the test suite.
It ad hoc signs only its temporary probe executable with the two private
entitlement declarations, then calls the real `IOPMAssertionCreateWithProperties`
with battery and lid-close
properties, a two-second release timeout, and immediately releases any assertion
that succeeds. It does not change persistent settings, install administrator
authority, close the lid, or request sleep. If accepted by the installed OS, it
briefly changes live power assertions. The executable also requires the explicit
flag when launched directly. Compilation is independent of executing it.

The implementation brief explicitly reserves approval for live power changes;
CLAUDE.md section 10 also protects real machine state and the security baseline.
Approval is required before running this exact power probe. It can confirm rejection or reveal a
usable candidate on this OS; it cannot certify that the candidate is effective
or safe while closed. Signing is not an entitlement grant; macOS may refuse to launch the executable
or reject the assertion. Either refusal leaves the present blocker. A successful create
would require separate supervised hardware qualification before implementation
could claim availability.

## Review and final evidence

The requested `review-impl` pass used distinct correctness/contracts/spec and
execution-evidence reviewers. It confirmed the full product implementation gap.
It found two defects in the prepared probe: the runner discarded native stdout
on failed release, and a comment misattributed the requested timeout to the
kernel. Both are fixed. Failure output now reaches the operator while exit
status remains unsuccessful; requested cleanup is not described as measured
recovery.

`bun test scripts/lid-closed/inspect.test.ts` passed **3 tests, 15 assertions**.
An isolated copy with the output-forwarding fix removed failed the exact stdout
assertion. The other tests also failed under isolated qualification/exit-status
mutations. The forwarding test uses a harmless native stdout-and-exit child with
an empty entitlement dictionary. It validates subprocess transport only and
cannot stand in for an assertion release receipt.

A separate copy of that harmless native child was signed with the two proposed
private entitlement declarations. It contained no IOPM or other power calls.
It terminated with `SIGKILL` before reporting output. The default read-only
observer and the harmless child without those declarations ran successfully.
At 2026-10-14 00:13:33 and 00:14:28 Asia/Bangkok, narrowly filtered macOS security
logs tied the private-entitlement child's failure to `AppleMobileFileIntegrity`
error **-424**: "The file is adhoc signed but contains restricted entitlements".
No system security settings were changed. This rules out this ad hoc helper
candidate on the current machine; it does not rule out every possible approved
signing arrangement or future OS.

The actual authority probe compiled and its declarations were inspected, but it
was never launched. Its signed-helper arrangement is now known to fail launch in
this environment. There is no reason to request a live power experiment with
that arrangement unless the signing/authority condition changes.

The standalone Bun runner bundle, `bun run maps:lint`, and `git diff --check`
passed. No app/engine runtime code changed, so desktop/engine builds, live GUI,
model-facing context, and physical closed-lid tests were not run. The original
end-to-end request remains incomplete and requires a viable authorized power
mechanism, not a simulated UI or an unmeasured recovery promise.
