# Lid-closed guardian launch repair and retry approval packet

Prepared 2026-10-14. Status: **AWAITING EXACT REPLACEMENT APPROVAL AND AGREEMENT TO ONE ADDITIONAL INSTALLATION; NOT INSTALLED**.

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

## Evidence limits

The identical native helper preserves the prior automated Core/process checks and historical open-lid recovery results. The replacement installer compiles/pins/verifies and passes shell syntax checks. Requested review-impl found no new defect in the launch repair. A real, harmless unprivileged Swift child launched through AppleScript do shell script returned control in 0.296 seconds, remained alive after its launcher exited, survived explicit SIGHUP and wrote completion after five seconds (launcher PID 9898, child PID 9900). A separate non-root shell probe also survived SIGHUP. These prove the shell/process contract without installation, administrator privileges or power operations. The administrator authorization environment and actual root guardian remain UNPROVEN until the new idle trial. Actual battery lid closure, ordinary Sleep, End mode and sleep, Electron lifecycle, cup/shared notice UI and packaged app/helper boundary remain unqualified or unimplemented. The feature is incomplete. App integration follows physical success under the specification and requires its own actual UI/package verification.
