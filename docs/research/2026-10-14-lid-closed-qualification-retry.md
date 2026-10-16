# Lid-closed guardian launch repair and retry approval packet

Prepared 2026-10-14. Approved by the operator for the exact hashes/commands, four further installations (five total attempts) and three 60-second leases. Status: **IDLE CHECK PASSED; BATTERY/LID ATTEMPT UNQUALIFIED; TESTING STOPPED AT OPERATOR REQUEST; INSTALLATION REMOVED**.

This is the historical packet and stopped-trial report. Subsequent user approval
superseded its per-hash and installation-attempt caps while retaining short
leases, physical coordination, and restore-first cleanup. See the
[continuation results](2026-10-14-lid-closed-physical-results.md) for observed
battery closed-lid progress and ordinary Sleep blockage. The original approvals
and observations below remain preserved as historical evidence.

The [approved installation-only check](2026-10-14-lid-closed-physical-qualification.md#installation-only-observation-2026-10-14) failed at macOS nohup console detachment before the guardian started. Its restore-first failure path removed authority. One installation attempt was used, zero leases. Independent observations confirmed SleepDisabled=false, no helper/plists/jobs or remaining helper processes, no guard ownership marker, and no pending power child. Preserve [raw observations](2026-10-14-lid-closed-qualification-evidence.json) and all c9a8af09 recovery evidence. No physical lid, power or Sleep action has been performed.

## Concrete repair

Replace nohup with a background shell that ignores SIGHUP and execs the same native guardian, with stdin/stdout/stderr redirected. This avoids the failing console-detachment call. Helper bytes are unchanged, as are deadline, monitoring, caller authentication, single-use admission, recovery and power commands. Installer readiness and restore-first failure cleanup remain enforced. Root launch and 30-second idle cleanup are still UNQUALIFIED.

## Exact replacement payload

Prepared directory: `/private/tmp/cat-lid-install-bWYiZk`. Only this packet may be used after its own approval; no regeneration is implied.

| Artifact | SHA-256 |
| --- | --- |
| Reviewed installer | `f4857c21a06592ed43e5d423515217f49de800150c528335d3f9a8820d2f106b` |
| helper | `c2f637c1cc2ae1706c8a553a66840baf240e94687c2ff4a503cbc945600826b5` |
| configuration.json | `3fafbda929fbfdb2901bc15a8cbf0f11d6526e82ec5974a2569ef5b2726f53a4` |
| daemon.plist | `c051e921e46b434c125a60be409b030ff1adc1362c89bc0bf39c956438ef1a58` |
| recovery.plist | `782e65e415044c1746606fc5245f04336fa45fbc3a6a7853b451fefa341321f9` |
| uninstall.sh | `cfe1d533c674f23a4bf9be6b332fc51f7eba0151ff03f85dac0786319c78e033` |

Native code requirement: `cdhash H"d062f8f0e28f6aebc7acf602d9abf77002d5f124"`; UID 501; native experiment parent only; hardware qualification false. Configuration expires at **2026-10-15T08:51:03.690Z**. The helper digest is identical to the previous approved packet; the installer and expiring configuration differ. Later regeneration or mutation needs a new exact approval.

Exact administrator command, at most four further invocations:

```sh
sudo /bin/bash -c 'set -euo pipefail
lid_root_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-root.XXXXXX)
trap '\''/bin/rm -rf "$lid_root_stage"'\'' EXIT
/usr/bin/install -o root -g wheel -m 0600 '\''/private/tmp/cat-lid-install-bWYiZk/install.sh'\'' "$lid_root_stage/install.sh"
/bin/echo '\''f4857c21a06592ed43e5d423515217f49de800150c528335d3f9a8820d2f106b  '\''"$lid_root_stage/install.sh" | /usr/bin/shasum -a 256 -c -
/bin/bash "$lid_root_stage/install.sh" '\''/private/tmp/cat-lid-install-bWYiZk'\'''
```

Root paths and receiving/cleanup contracts remain those in [the original packet](2026-10-14-lid-closed-physical-qualification.md#exact-payload-and-installation): one helper, two launchd jobs, root-only recovery/owner/child/configuration records and uninstaller. The temporary cleanup guardian is not a third job. No sudoers, dependencies, restricted entitlements, or security settings change.

## Additional agreement requested

Raise the total installation-attempt cap from **four to five**, including the one failed attempt already used. Approve **up to four further installations of this exact payload**, covering the repaired idle check followed by the three physical trials. The original limit of **three 60-second leases** is unchanged; all three remain unused. No additional trials or retries are authorized beyond this packet.

1. Re-run only the failed installation-only idle cleanup check: lid open, power unchanged, no lease. Measure actual guardian cleanup, verify restoration, helper/job removal and guardian exit before proceeding. Stop and investigate if it fails again.
2. Battery/lid lease: coordinate unplugging if needed, verify battery operation/reserve and active override, then cue closure. Operator closes for approximately 20 seconds on a ventilated hard surface, reopens and reports both. Require timestamped SHA work during lidClosed=true/onBattery=true and restoration/removal after opening.
3. Ordinary Sleep lease: separate readiness and explicit Apple menu Sleep cue while active. Record the operator's action/observation and scoped Sleep/Wake records. If blocked, let the fixed lease expire and observe the corrected expiry label and cleanup. If it sleeps, require actual wake report and corresponding records; investigate unexpected behavior before expanding implementation.
4. End mode and sleep lease: separate readiness and explicit cue before sending S to the interactive native driver. Require observed restoration before sleep request, actual operator-observed sleep/wake and corresponding system records, then cleanup verification. Cleared flags or successful commands alone do not prove sleep.

The [original coordination, evidence and abort rules](2026-10-14-lid-closed-physical-qualification.md#bounded-approved-actions-requested) apply. Never infer physical actions from elapsed time. Never leave a live installation waiting for participation. Native C/EOF ends its lease; cancellation may stop only the newly tracked native experiment process. Reuse the prior recovery trials without extra helper/watcher failure signals. A failed qualification stops the sequence for investigation.

## Cleanup and fallback

The guardian's original execution budgets remain unchanged: 30 seconds to await admission; an admitted lease's deadline plus 15 seconds, capped at 90 seconds from detection; 15 seconds for recovery contention and 30 seconds for removal. These are budgets, not unconditional guarantees. Every ending must restore and confirm normal sleep before removal; unresolved restoration retains recovery authority and evidence. Verify guardian exit before another installation.

Explicit restore-first cleanup and fallback remain part of the requested replacement authorization:

```sh
sudo '/Library/PrivilegedHelperTools/com.catcode.lid-closed' --restore-for-uninstall
sudo /bin/bash '/Library/Application Support/Cat Code/LidClosed/uninstall.sh'
```

If restoration is unresolved, retire pending power children through the verified helper's restore path, then use the documented fallback if required:

```sh
sudo /usr/bin/pmset -a disablesleep 0
```

If the child-retirement path is broken, retain evidence and diagnose before removing recovery authority. Independently observe kernel SleepDisabled=false after fallback, then run restore-first removal. Report fallback use. Confirm both helper/plist removal and missing-service results, guardian exit, and absence of pending power children before any extended wait. Root recovery evidence is retained.

## Evidence limits before replacement approval

The identical native helper preserves the prior automated Core/process checks and historical open-lid recovery results. The replacement installer compiles/pins/verifies and passes shell syntax checks. Requested review-impl found no new defect in the launch repair. A real, harmless unprivileged Swift child launched through AppleScript do shell script returned control in 0.296 seconds, remained alive after its launcher exited, survived explicit SIGHUP and wrote completion after five seconds (launcher PID 9898, child PID 9900). A separate non-root shell probe also survived SIGHUP. These prove the shell/process contract without installation, administrator privileges or power operations. The administrator authorization environment and actual root guardian remain UNPROVEN until the new idle trial. Actual battery lid closure, ordinary Sleep, End mode and sleep, Electron lifecycle, cup/shared notice UI and packaged app/helper boundary remain unqualified or unimplemented. The feature is incomplete. App integration follows physical success under the specification and requires its own actual UI/package verification.

## Observations after replacement approval

### Repaired installation-only check

Installation attempt 2 verified the approved payload and launched both jobs plus guardian PID 13821. Root observation matched the guard marker to the kernel PID/birth identity, UID 0 and exact installed executable. No lease was started. The native snapshot observed SleepDisabled=false, lid open, battery source at 100 percent and nominal thermal category. These readings do not qualify closed-lid operation, actual sleep or thermal protection.

The administrator launcher returned while the guard continued independently. The guard's restoration-confirmed snapshot was written at 09:36:22.609390 UTC, 30.050 seconds after its kernel birth time. The independent removal/exit observation began after cleanup and confirmed helper/plists absent, SleepDisabled=false and that exact guardian gone (kernel ESRCH) by 52.509 seconds after birth. This is an observation upper bound, not an exact removal/exit timestamp. At 09:39:00 UTC root verification confirmed both jobs specifically missing (launchctl 113), the guard absent, no power child, and retained journal draining=true/needsRestore=false/sleepRequested=false. No manual removal or fallback was used.

This check qualifies the repaired launch and idle cleanup under this one administrator-session scenario. It does not establish unconditional guardian survival or recovery. The prior c9a8af09 recovery evidence remains separate.

### First battery/lid attempt

After explicit readiness and agreement to a separate 20-second reopening step, installation attempt 3 launched guardian PID 14202. Lease 1 began at 09:48:45 UTC (16:48:45 Bangkok), confirmed battery source at 100 percent, nominal category and SleepDisabled=true. A close-now cue was sent after activation confirmation. The trace contains 61 SHA work samples through 09:49:46 UTC: each reported lidClosed=false and onBattery=true; there were zero closed-lid samples. Deadline remained fixed. The operator subsequently reported missing the cue and requested that pending preparation finish, then testing stop and wait. No physical closure/reopening confirmation was supplied; do not infer physical actions from elapsed time.

The lease expired rather than ending for lid opening. Its recorded restoration began 0.730 seconds after the original deadline; the driver confirmed SleepDisabled=false/needsRestore=false/reason=expired at elapsed 60.831 seconds and exited with status 0. Total sampled SHA work reached 3,997,696 bytes. This proves open-lid battery progress and expiry/restoration, not closed-lid operation or actual sleep. At 09:51:40 UTC root verification showed helper/plists absent, both jobs missing (113), guardian PID 14202 absent (ESRCH), no power child, and retained ended/draining recovery with no sleep request. No manual removal or fallback was used. Subsequent independent checks again showed the flag false and files absent.

Raw observations and trace are retained in [the evidence file](2026-10-14-lid-closed-qualification-evidence.json). Physical battery/lid qualification, ordinary Sleep, actual End mode and sleep, and app/UI/package integration remain incomplete.

### Current limits and stopped state

Three of five total installation attempts and one of three leases have been used. Two installations and two leases remain under this approval. The missed-cue lease cannot be silently reset or reused. Completing a new battery/lid attempt plus the two separately specified Sleep trials would require agreement to one additional installation and one additional 60-second lease. No further trial is started or authorized by that observation alone.

Testing is stopped at the operator's request. Finish only independent preparation/documentation and wait for a new instruction. Keep the machine restored and the experimental installation removed during that wait; coordinate any resumed physical action explicitly.
