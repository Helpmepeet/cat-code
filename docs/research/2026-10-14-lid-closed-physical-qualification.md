# Lid-closed remaining physical qualification packet

Prepared: 2026-10-14. Status: **AWAITING EXACT APPROVAL; NOT INSTALLED OR RUN**.

This packet continues [the experiment report](2026-10-14-lid-closed-pmset-experiment.md). Preserve its c9a8af09 recovery evidence and raw artifact. Its previous installation was removed and SleepDisabled was false. That approval does not cover this replacement. No closed-lid or intentional Sleep result is implied here.

## Exact payload and installation

Prepared directory: `/private/tmp/cat-lid-install-kPwAkB`.

| Artifact | SHA-256 |
| --- | --- |
| Reviewed installer | `9c649e7016037316e36287f4f9758d3ac6c5ba9ebc36bf91c492597c08235332` |
| helper | `c2f637c1cc2ae1706c8a553a66840baf240e94687c2ff4a503cbc945600826b5` |
| configuration.json | `1f1cc933a1029861ad3b64b8618f63ad3ec41b843c439f69ba590fdd61c89771` |
| daemon.plist | `c051e921e46b434c125a60be409b030ff1adc1362c89bc0bf39c956438ef1a58` |
| recovery.plist | `782e65e415044c1746606fc5245f04336fa45fbc3a6a7853b451fefa341321f9` |
| uninstall.sh | `cfe1d533c674f23a4bf9be6b332fc51f7eba0151ff03f85dac0786319c78e033` |

Ordinary ad hoc code requirement: `cdhash H"d062f8f0e28f6aebc7acf602d9abf77002d5f124"`. No restricted entitlements or system security changes. Configuration admits only UID 501 with this pinned native bridge and installed native experiment parent; the real Electron app is not yet enrolled. Authorization expires at **2026-10-15T08:02:02.071Z**. Expiration or any payload change requires a new pinned packet and approval.

Exact administrator command, executed at most four times, using the same payload each time:

```sh
sudo /bin/bash -c 'set -euo pipefail
lid_root_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-root.XXXXXX)
trap '\''/bin/rm -rf "$lid_root_stage"'\'' EXIT
/usr/bin/install -o root -g wheel -m 0600 '\''/private/tmp/cat-lid-install-kPwAkB/install.sh'\'' "$lid_root_stage/install.sh"
/bin/echo '\''9c649e7016037316e36287f4f9758d3ac6c5ba9ebc36bf91c492597c08235332  '\''"$lid_root_stage/install.sh" | /usr/bin/shasum -a 256 -c -
/bin/bash "$lid_root_stage/install.sh" '\''/private/tmp/cat-lid-install-kPwAkB'\'''
```

The installer first copies and verifies its approved script in a root-owned private directory. The script pins payload hashes, copies into a root-private staging directory, and verifies installed hashes/signature before root execution. It restores retained recovery state before launching jobs and reopening admission. Failure after verification attempts restore-first removal; unresolved recovery retains the recovery jobs.

Root paths:

- `/Library/PrivilegedHelperTools/com.catcode.lid-closed`.
- `/Library/LaunchDaemons/com.catcode.lid-closed.plist` and `com.catcode.lid-closed.recovery.plist` in that directory.
- Root-only journal, configuration, child/owner records, uninstaller and cleanup log in `/Library/Application Support/Cat Code/LidClosed` (0700 directory, private records).

No sudoers entry. The two persistent jobs use the prior helper/watch architecture. This replacement also starts one temporary root cleanup guardian, not a third launchd job. Guardian exit must be verified before another installation. Production app installation is outside this packet.

## Changes requiring this approval

- Includes the locally tested c9a8af09 fresh-pulse expiry reason correction.
- The native driver computes and timestamps actual SHA-256 work: 64 KiB per sample, cumulative bytes and per-sample digest, with kernel lid/battery/override snapshots.
- Sleep is requested only by an explicit `S` byte in the interactive `--experiment sleep` driver. `C` or stdin EOF requests Stop. No timed automatic End mode and sleep cue.
- Experimental activation durably consumes its single-use admission before changing power. Fresh starts and Continue are refused until a fresh installation; pulses, Stop and recovery remain available. This proof profile does not change production's original-deadline Continue contract.
- The temporary guardian waits up to 30 seconds for that one attempt, then restores and removes experimental authority. Once an attempt is observed, its wait ends by the recorded deadline plus 15 seconds, capped at 90 seconds after observation, or promptly after confirmed ending. Recovery contention has a 15-second retry budget and uninstallation a 30-second process wait. These are execution budgets, not unconditional hardware recovery guarantees; suspension, failed OS calls or lost recovery processes can exceed them or leave recovery unresolved.
- Pending power children are retired under the transition lock before restoration/removal. The guardian records confirmation before removal. Failed/unobservable restoration must retain recovery authority and be reported.

## Bounded approved actions requested

Approval covers **at most four installations of the exact above payload and three 60-second leases**, with no retries or extra trials unless separately agreed:

1. Installation-only cleanup check: keep the lid open and power unchanged, start no lease, measure the guardian's 30-second idle cleanup and confirm helper/jobs removed and SleepDisabled false. This exercises the newly added cleanup path without enabling the override.
2. Battery/lid lease: after readiness, coordinate any required unplugging first and independently observe onBattery=true, reserve above 20%, nominal/fair thermal state and open lid. Install only when the operator is ready. Start the native interactive driver, verify active identity and SleepDisabled=true, then explicitly cue **close now**. Operator closes on a ventilated hard surface for approximately 20 seconds, reopens and explicitly reports both actions. Do not infer either from a timer. Compare operator reports with timestamps, lidClosed=true samples, onBattery=true, advancing sequences, cumulative SHA bytes and changing digests. Reopening must end the mode and restore normal sleep behavior; measure it and verify removal before waiting further. If closure/opening cannot be coordinated within this allowance, cancel and clean up.
3. Ordinary Sleep lease: lid remains open, save unrelated interactive work, install/start after readiness, verify active override, then explicitly cue the operator's Apple menu Sleep action. Operator reports the action and observed behavior; if sleep happens, operator wakes normally and reports that too. Correlate feature samples with only the relevant system Sleep/Wake records. If ordinary Sleep is blocked, observe continued work during the attempted sleep and let the lease expire to check the corrected expiry reason and guardian cleanup. A display going dark or continued samples alone is not decisive physical sleep evidence.
4. End mode and sleep lease: separately obtain readiness with open lid and saved work. Install/start, confirm active state, coordinate a sleep-now cue, and only then send `S`. Require the journal's observed override restoration before its sleep request. Operator observes actual sleep, wakes normally and reports both. Correlate a new system Sleep/Wake pair and a workload pause, including reason/timestamps, with this exact request. A successful pmset receipt or cleared flag alone does not qualify actual sleep. Verify restoration/removal after wake.

Only fixed helper operations and fixed pmset disable/restore/sleep vocabulary execute. No model calls, unrelated work, deliberate heating or deep discharge. Read-only scoped observations cover power/lid/battery facts, installed hash/signature/permissions, job identities, root recovery/cleanup/child records and relevant system Sleep/Wake evidence. Retain only feature evidence.

Do not repeat prior helper/watcher crash/stall trials: their measured recovery results remain recorded, with native-client rather than Electron qualification. No new scoped failure signals are requested in this packet. Cancellation may stop only the newly started, tracked native experiment process; its lost supervision causes restore. Keep the independent watcher/guardian through restoration.

If qualification fails, stop and investigate the concrete failure before another trial or app expansion. Ordinary Sleep blocking is an approved limitation; actual End mode and sleep must still be demonstrated. No claim of perfect global-setting ownership, thermal safety or general recovery guarantee is allowed.

## Restore-first cleanup and fallback

Every completed trial, failure, cancellation or coordination delay must end with restoration confirmation and experimental removal before an extended wait. Use guardian cleanup where observed; do not assume it ran. Explicit cleanup remains authorized:

```sh
sudo '/Library/PrivilegedHelperTools/com.catcode.lid-closed' --restore-for-uninstall
sudo /bin/bash '/Library/Application Support/Cat Code/LidClosed/uninstall.sh'
```

If restoration is unresolved, the requested fallback authorization is:

```sh
sudo /usr/bin/pmset -a disablesleep 0
```

Before fallback, retire any recorded power child using the verified helper's restore path so a pending enable cannot run after restoration. If that path is broken, retain root child identity evidence and diagnose before blindly removing authority. After fallback independently observe SleepDisabled=false, then run restore-first removal. Never remove the watcher while restoration is unconfirmed. Fallback invocation is reported explicitly.

After each installation, independently verify kernel SleepDisabled=false; helper and both plist files absent; both launchctl lookups specifically report missing services; no remaining tracked experimental driver, cleanup guardian or pending power child can re-enable the override. Root-only recovery state remains as evidence. A running guarded session must not be left waiting for approval or physical participation.

## Verification completed before approval

Real native Core/process suite passed. It exercises durable intent, restoration failure/retry, supervision, fixed deadlines, protections, at-most-once sleep ordering, real stdin and child commit/retirement. Isolated mutations discriminate Sleep input and commit gating. A separate real-Core behavioral harness discriminates experimental Continue, a second start after Stop and a second start after failed activation; all are rejected by current code and accepted when durable consumption is removed. This is Core evidence with harmless power closures, not a privileged or hardware execution.

Full helper compiles and its prepared ordinary signature, payload manifest and shell syntax are verified. Requested review-impl found one MEDIUM user-visible single-use admission race and one LOW cleanup timing edge; both were fixed. No deferred finding. Installer/guardian root execution, live XPC, new cleanup timing, closed-lid progress and actual Sleep remain UNPROVEN until this packet runs. The historical recovery evidence is preserved rather than generalized to the new guardian.

## Product gate

After physical qualification succeeds, complete app-wide enrollment/context/lifecycle and numeric cup/shared notice UX from [the specification](../design/2026-10-13-lid-closed-mode-spec.md), then verify actual Cat Code Dev interaction and packaged app/helper authentication. This proof packet does not install a qualified production app/helper configuration. No UI or feature-complete claim is made while those layers remain unverified.
