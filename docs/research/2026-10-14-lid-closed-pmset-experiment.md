# Lid-closed pmset mechanism and bounded experiment

Status: Approved pinned installation and ten open-lid, 60-second-allowance leases
ran on 2026-10-14. Restoration and uninstallation are verified. The operator
deferred lid closure; actual Sleep was not exercised. The app feature is not
integrated or hardware qualified. The accepted tradeoffs are in the
[product spec](../design/2026-10-13-lid-closed-mode-spec.md).

## Concrete mechanism

`app/native/lid-closed/` contains the real Swift helper, fixed pmset adapter,
XPC client bridge, transition owner, root recovery journal, independent watcher,
installer/uninstaller, and bounded experiment driver. It uses no restricted
entitlements or account-wide sudoers permissions.

Administrator setup copies the signed helper into
`/Library/PrivilegedHelperTools/com.catcode.lid-closed`, installs two launchd jobs
in `/Library/LaunchDaemons/`, and stores configuration and the recovery journal
under `/Library/Application Support/Cat Code/LidClosed/` with root-only access.
The prepared installer copies payloads into a root-private staging directory,
checks embedded digests there, and verifies installed copies before starting
either job. It never writes verification inputs in the caller's prepared directory.
The approval command copies the reviewed installer into a root-owned temporary
directory and verifies its digest before execution.

XPC authenticates the connection UID and pinned native bridge code signature.
The bridge must have the installed executable path and an approved, code-pinned
parent read from the kernel. Future app callers also require a regular registered
Cat Code application. Initial preparation authorizes only the fixed experiment
driver, for 24 hours, with 10–90-second leases. It does not authorize arbitrary
terminal programs to call pmset or grant full administrator execution. Production
activation stays disabled until physical qualification and app binding exist.

The helper accepts only bounded mode operations, identities, presets, and
experiment-only protective endings. It passes only fixed arguments to
`/usr/bin/pmset`: `-a disablesleep 0`, `-a disablesleep 1`, or `sleepnow`.
Power commands get a three-second timeout. Before execution, a native child waits
on an input gate while the parent durably records its PID, kernel birth time,
parent identity, and fixed action. Only then does it receive a commit byte and
replace itself with pmset, retaining the recorded PID. Recovery retires and
observes that exact child before another power change. Child recording, commit,
and retirement share the transition lock; stale retirement cannot delete a newer
record. No client path, shell command, or permission rule is executed.

The journal is written, fsynced, atomically replaced, and directory-fsynced before
changing the override. Both root jobs use the same nonblocking transition lock.
Failed restoration remains unresolved. A successful command is not enough:
`SleepDisabled=false` must be observed before settlement or a separate sleep
request. Corrupt journals prevent activation and require operator recovery.
No startup path silently clears an unreadable journal or reactivates an old mode.
Daemon startup participates in stalled-owner recovery before it starts listening,
with a bounded 15-second contention retry. Removal/upgrade first persists a drain
that refuses new activation through the entire restore-to-job-removal interval.
An interrupted sleep receipt is never automatically replayed: confirmed
restoration and attempted sleep intent are durable before requesting sleep.

The deadline uses `mach_continuous_time`, including suspended time. A heartbeat
cannot renew it or revive a stale lease. Continue keeps the original deadline;
preset adjustment changes total allowance relative to successful activation.
The helper reads lid state, internal battery reserve, and thermal category itself.
Battery operation is ordinary operation. Nominal readings do not certify thermal
monitoring; hardware qualification remains separate.

## Recovery scenarios and targets

Targets apply while macOS schedules the relevant job and power/IOKit operations
are available. They are not unconditional guarantees.

| Failure scenario | Response | Qualification target | Observed result, open lid |
| --- | --- | --- | --- |
| Electron/bridge exits or stops sending supervision | Helper/watcher observes stale client heartbeat | Start restoration within 7 seconds; confirm within 12 seconds if commands/readings work | Native supervision withdrawal: restoration started at 5.83 seconds after last pulse, confirmed at 6.06 seconds. Native client parent SIGKILL: confirmed by 5.17 seconds after signal. Electron itself NOT RUN |
| Helper crashes, including after journal intent or power change | launchd restarts it; watcher independently restores interrupted or stale authority | Confirm within 12 seconds under single-job failure | SIGKILL after confirmed activation: restored by the 1.04-second observation. Crash during activation/power-command execution NOT RUN |
| Helper is stopped or stalls outside transition lock | Watcher detects stale helper progress despite fresh client traffic | Confirm within 12 seconds | Helper SIGSTOP: watcher restored by 5.15 seconds after signal; the same helper PID was resumed. Fresh client traffic could not be processed by the stopped helper |
| Helper/watch job stalls while holding transition lock | Surviving job verifies root-owned job marker, PID birth time, root UID, installed path and pinned signature before terminating that exact stalled instance; retries restoration | Confirm within 15 seconds under single-job failure and functioning kernel process termination | Watcher SIGSTOP with confirmed held lock, plus deliberate helper SIGKILL/relaunch: restored by 6.20 seconds; new watcher observed. Helper-held lock and in-flight pmset child failure NOT RUN |
| Watcher crashes | launchd restarts it; helper remains independent | Measure restart while helper protections remain operational | New watcher observed by 4.04 seconds after SIGKILL; helper remained active and supervised. Lease then ended by deliberate loss of its own client |
| Power command fails or required reading becomes unavailable | Persist unresolved recovery; retry; refuse new activation | No finite restoration claim | NOT RUN |
| Both jobs disabled, launchd unavailable, or authority revoked during override | Automatic recovery may be unavailable | No finite bound; manual restoration required | NOT RUN |
| Reboot with an interrupted journal | Attempt restoration before new activation; never resume mode | Measure after launchd starts jobs | NOT RUN |
| Uninstall or upgrade | Attempt and observe restoration before stopping jobs | Refuse removal/upgrade if restoration unresolved | Restore-first uninstall completed; kernel flag false and both jobs/helper absent. Upgrade and failed-restoration removal NOT RUN |

The accepted exclusive-use requirement cannot detect another utility writing the
same value. Activation refuses an already-disabled setting. Observable changes
end operation. Restoration clears the recorded global override, with the disclosed
possibility of interfering with an indistinguishable simultaneous writer.

## Bounded physical experiment

Only run after explicit approval of the prepared installation and these actions.
Use a ventilated desk, battery above 25 percent, and no other sleep-override
utility. Save unrelated interactive work before any deliberate sleep request.
Do not weaken macOS security or perform a real heat/deep-discharge test.

1. Install the exact prepared payload using its pinned approval command. Verify
   root-owned files and both launchd jobs. Record their PIDs; terminate only these
   newly installed jobs during failure checks.
2. Run the installed native driver's `--experiment progress` mode and retain its
   JSONL output in an isolated evidence directory. The driver runs a 60-second
   fixed lease and supervises it every second. Its sampling loop ends at 75 seconds;
   bounded reply and cleanup waits allow up to 100 seconds after confirmed start
   while the OS schedules it. Actual system sleep suspends those processes.
3. Disconnect external power. Confirm output reads `onBattery=true`. Close the lid
   for about 20 seconds, then reopen before the original deadline. Require
   increasing `progressSequence` and timestamps paired with observed closed-lid
   samples. Do not use an open application after reopening as execution evidence.
4. With the lid open, run `--experiment sleep` and exercise ordinary macOS Sleep
   during its first ten seconds. The driver ends the mode and requests sleep after
   twenty seconds if ordinary Sleep was blocked.
   Record the observed menu/system behavior and continued progress. Ordinary Sleep
   may be blocked; disclose it. Then verify restoration before a separate sleep
   request. The root-only `--observe 90` emits a separate, read-only journal and
   kernel observation stream for crash tests; it never supervises or renews a
   lease. After waking, retain system sleep/wake evidence independently of the
   helper's receipt. A successful `sleepnow` request alone is not observed sleep.
5. Run `--experiment supervision`: it stops sending pulses after ten seconds.
   Record last successful pulse, restoration start, and observed restored flag.
6. Kill only the PID of the newly started experiment driver to exercise real
   client-parent loss; observe independent recovery. During a separate fresh
   bounded lease, kill or stop only the recorded helper PID using
   administrator authorization. Observe the watcher and journal through recovery.
   Repeat after journal intent/activation and during a transition using controlled
   timing. Verify the surviving job retires only the tracked stopped instance.
   Measure actual bounds, including lock contention and relaunch latency.
7. Exercise `--experiment thermal`, `--experiment battery-reserve`, and
   `--experiment monitoring-unavailable`. These inject only protective end reasons
   through the authenticated experiment role. They cannot lower safeguards,
   replace real safety readings, or extend time. Report simulated trigger input
   separately from the real restoration/power observation.
8. Verify Retry after a controlled command/observation failure in isolated tests;
   do not break system pmset or create uncontrolled restoration failures on the Mac.
9. End any remaining lease and run the prepared administrator restoration command.
   Confirm `SleepDisabled=false`. If needed, keep the Mac open, restore manually
   with the approved `sudo /usr/bin/pmset -a disablesleep 0`, and record the failure.
   Remove the helper only through its restore-first uninstaller.

The fixture suite exercises real Swift lifecycle and journal code with power
failure producers. It proves durable intent, fixed deadlines, stale supervision,
independent watcher decisions, restoration failure retention, retry, protections,
sleep ordering, lock contention, and corrupt-journal refusal. It does not prove
XPC authentication, launchd recovery, pmset, or physical closed-lid/sleep behavior.
Those boundaries require the approved installed experiment.

## Automated review evidence

`bun test app/native/lid-closed/native.test.ts` passes (one native suite, four
Bun assertions plus native preconditions). The real Swift controller and durable
journal run with injected safety/power failures. Separate native child tests
exercise the actual stdin commit gate and identity-based retirement using a
harmless file effect. They execute no privileged power operation.

The requested review-impl pass found these helper-stage defects and fixes:

Triage: 11 VALID findings (6 HIGH, 4 MEDIUM, 1 LOW; 9 user-visible, 2 internal),
all repaired; no inherited or deferred findings. Executed lifecycle/process fixes
passed their checks. Installed root, XPC, and launchd effects remain unproven;
source review and compilation do not close those physical qualification gaps.

| Finding | Severity / impact | Repair | Verification |
| --- | --- | --- | --- |
| Mutable installer verification inputs could redirect root writes | HIGH / user-visible | Root-private payload copy and embedded digest checks | Source review; installed root path not run |
| Power child could outlive helper and enable after recovery | HIGH / user-visible | Durable child identity, commit gate, same-PID exec, confirmed retirement | Real harmless native gate/child test; pmset path not run |
| Concurrent retirement could delete a newer child's recovery record | HIGH / user-visible | One shared transition lock for every production ledger path | Reviewer reproduced stale deletion with native sleep children, then proved contention refused and new record retained using real lock |
| Removal/upgrade admitted new activation after restoration | HIGH / user-visible | Persist drain before restore; release only after installation | Native suite; removing the guard fails intended assertion |
| Fast restart retained a freshly supervised active lease | HIGH / user-visible | Restore interrupted session before accepting clients | Native suite; reverting restart recovery fails intended assertion |
| Startup could not retire a watcher stalled with the lock | HIGH / user-visible | Bounded startup contention loop invokes pinned stalled-owner retirement | Source review; root launchd timing not run |
| Preset change could revive an expired lease | MEDIUM / user-visible | Validate old deadline and supervision first | Native suite; removing expiry check fails intended assertion |
| Retained state required an absent old executable on reinstall | MEDIUM / user-visible | Use verified new helper to recover retained state before jobs start | Source review; root reinstall not run |
| Experiment treated a restored failed start as active | MEDIUM / internal | Require matching active identity and observed override | Source review; XPC experiment not run |
| Interrupted sleep receipt could repeat sleep after wake | MEDIUM / user-visible | Persist at-most-once attempt after confirmed restoration | Native suite; removing attempt guard fails intended assertion |
| Installer resolved a root verification command through inherited PATH | LOW / internal | Use absolute `/bin/cat` | Generated installer inspected; shell syntax passed |

These repairs alone do not qualify recovery bounds. The live observations above
apply only to the tested conditions and pinned payload; they do not establish
closed-lid operation or sleep. The integrated app, enrollment, temporary context,
and cup UX remain incomplete until mechanism qualification and the next stage.

## Exact installation and experiment approval packet

Prepared on 2026-10-14. This packet is for the helper proof stage only. It does not
install a production-qualified Cat Code feature. Earlier temporary payloads are
superseded; use only this packet. Experiment authorization expires after 24 hours
in the generated root configuration; a later regenerated payload needs its own
exact approval.

Prepared directory: `/private/tmp/cat-lid-install-PViWrX`.

| Artifact | SHA-256 |
| --- | --- |
| Reviewed installer | `b7e3c92ebb969acb45775479f9dd5079ff86d9ab21b9aea8ddb93195ae1d7b50` |
| Signed native helper | `a69bdffb568e287c3aebbb4eb87a493c80bdd18f7ab7a62b73cb77a281b7a15f` |

The other payload digests are pinned inside that installer. Their manifest,
generated launchd plists, ordinary code signature, shell syntax, and focused
TypeScript checks passed. The native source compiled, the focused suites passed
(4 tests, 19 Bun assertions plus native preconditions), and map/diff checks passed.
No privileged job or live power change has run.

Exact administrator install command:

```sh
sudo /bin/bash -c 'set -euo pipefail
lid_root_stage=$(/usr/bin/mktemp -d /private/tmp/cat-lid-root.XXXXXX)
trap '\''/bin/rm -rf "$lid_root_stage"'\'' EXIT
/usr/bin/install -o root -g wheel -m 0600 '\''/private/tmp/cat-lid-install-PViWrX/install.sh'\'' "$lid_root_stage/install.sh"
/bin/echo '\''b7e3c92ebb969acb45775479f9dd5079ff86d9ab21b9aea8ddb93195ae1d7b50  '\''"$lid_root_stage/install.sh" | /usr/bin/shasum -a 256 -c -
/bin/bash "$lid_root_stage/install.sh" '\''/private/tmp/cat-lid-install-PViWrX'\'''
```

Approval covers those exact root paths and two jobs described above, verification
of their installed permissions/signatures, and the following bounded live actions:

- Up to twelve separate 60-second leases, using the installed driver's progress,
  supervision, sleep, and protective-ending scenarios. Only fixed `pmset`
  disable/restore and sleep requests can execute; no model calls or unrelated
  work are launched.
- Battery unplug, lid closure for approximately twenty seconds, and reopening
  performed by the operator on a ventilated desk. Ordinary macOS Sleep is an
  explicit operator action; native End mode and sleep is tested separately.
- Read-only root observation (`--observe 90`), launchd job status, the scoped
  recovery journal, and system sleep/wake evidence. Retain only feature evidence.
- Terminate only the newly started experiment driver's recorded PID; separately
  SIGKILL/SIGSTOP only a freshly verified PID and birth identity of these two
  newly installed launchd jobs. This tests helper crash, stalled lock-owner
  recovery, and watcher restart, including before listener startup. No process
  discovery/name-based kills, unrelated app termination, or security changes.
- Cleanup immediately after experiments, including any failure: run the installed
  helper's `--restore-for-uninstall`, confirm the kernel sleep flag is false, and
  run its restore-first uninstaller. If automatic restoration fails, the approved
  fallback is `sudo /usr/bin/pmset -a disablesleep 0`, followed by observation.
  Retain the root-only journal/configuration as failure evidence.

Cleanup commands:

```sh
sudo /Library/PrivilegedHelperTools/com.catcode.lid-closed --restore-for-uninstall
sudo /bin/bash '/Library/Application Support/Cat Code/LidClosed/uninstall.sh'
```

The operator must save unrelated interactive work before the sleep experiment.
The work must remain unqualified if battery lid closure, physical sleep evidence,
or the named failure scenarios cannot be observed. Recovery targets remain targets
until actual timestamps and observations replace the NOT RUN entries.

## Remaining product integration

Continuation now has a separate [remaining physical qualification packet](2026-10-14-lid-closed-physical-qualification.md), awaiting approval for its exact replacement hashes. The installation packet above and the results below remain historical evidence; they do not authorize the replacement payload.

After mechanism qualification: bind the real app parent, implement app-wide run
inventory and enrollment through handoffs/background descendants, temporary
model context with no replay authority, protective work admission/reduction,
app-wide lifecycle/IPC, first-use disclosure, numerals-only cup, shared-shell
notices, direct Stop/End mode and sleep, original-deadline Continue, and persistent
recovery. Run desktop/engine checks and authorized actual UI verification before
calling the integrated feature complete.

## Observed experiment results, 2026-10-14

Tested source: `168e3c7e`, using the exact installer/helper hashes in the approval
packet. Host: Mac16,8, macOS 26.6.2 (25G83). Root configuration/state permissions
were 0600/0700, both launchd jobs were observed running, and the installed helper
matched the approved digest and passed ordinary signature verification.

Ten leases were used, each with a 60-second maximum allowance. All were observed
on battery, with the lid open and nominal thermal readings. The operator approved
the first open-lid check, then answered **“Wait; do not start the lid test.”**
No lid test, intentional unplug/replug, ordinary Sleep action, or End mode and
sleep action was performed. Battery operation was observed directly, not inferred
from a requested physical step.

| Lease | Trigger/action | Observation |
| --- | --- | --- |
| 1 | Native driver stops pulses after ten seconds | Override enabled, then restoration started 5.829 seconds after last pulse; confirmed false at 6.062 seconds |
| 2–4 | Inject thermal, battery-reserve, and monitoring-unavailable end reasons | Real override restored in each case, no sleep request. These are simulated triggers, not real heat, low reserve, or missing readings |
| 5 | Kill the experiment client parent by verified PID/birth identity | Restoration confirmed by 5.170 seconds after signal; original deadline still had approximately 52 seconds left |
| 6 | Kill the verified installed helper after activation | launchd restarted it; reason interrupted; restoration confirmed by 1.044 seconds after signal |
| 7 | Stop the verified helper | Independent watcher restored by 5.153 seconds; same stopped helper subsequently resumed; no automatic reactivation |
| 8 | Kill the verified recovery watcher | New watcher observed by 4.035 seconds while helper remained active. Then killing only the owned driver caused supervision-loss restoration |
| 9 | Keep supervision through the original deadline | Ended as expired at 60.831 seconds in driver sampling; restoration began 0.411 seconds after the native deadline; flag confirmed false |
| 10 | Stop watcher while nonblocking lock probe confirms its held lock, then kill/relaunch helper | Restoration confirmed by 6.199 seconds after watcher stop; new watcher observed. Concurrent new-activation admission was not exercised |

Confirmation times are upper bounds from discrete observations, not exact kernel
transition times. Each failure case had one trial. Sampling used native continuous
time and read-only snapshots; signal targets matched root job markers, kernel
birth identity, UID, executable path, and the installed jobs. The stalled-watcher
case intentionally included a helper relaunch, so it is not evidence for every
possible single-job or dual-job failure. Supervision loss was exercised through
the native experiment client, not a running Electron app.

Feature-only raw observations are retained in
[the evidence artifact](2026-10-14-lid-closed-pmset-evidence.json). It includes
continuous clocks, sequence counts, native journal/safety snapshots, scoped
signals, and final verification. It contains no credentials or unrelated work.

### Final cleanup

At 2026-10-14 13:13:03 Asia/Bangkok, restore-first cleanup observed
`SleepDisabled=false`, `needsRestore=false`, `draining=true`, and no sleep request.
Uninstallation then completed. A separate subsequent check confirmed the kernel
flag still false, the helper and both launchd plist files absent, and both job
lookups failing specifically with “Could not find service”. The root-only recovery
journal/configuration were retained by the approved uninstaller. The fallback
`pmset -a disablesleep 0` command was not needed or used.

Cleanup waited for administrator authentication; during that wait, a separate
kernel check confirmed the override remained off. No active mode was left waiting
for operator coordination.

### Remaining qualification and source correction

Closed-lid progress, ordinary Sleep blockage, actual sleep after End mode and
sleep, lid-open continuation, reboot recovery, and interruption during a live
power command remain **UNQUALIFIED**. No physical sleep evidence was gathered.
Nominal thermal samples do not prove thermal monitoring support. The mechanism
must not be described as safe or ready based on these open-lid results.

After uninstalling the approved payload, source review identified one expiry
label edge case: a fresh pulse queued until the deadline restored correctly but
could report supervision-lost. A native regression failed on that exact reason
against the tested source, then passed after the pulse branch was corrected to
report expired. The full native helper compiled after the correction. This source
correction was not installed or power-tested; the evidence hashes identify the
earlier approved payload. No replacement payload or privileged change is implied.
