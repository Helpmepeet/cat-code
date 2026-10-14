# Lid-closed physical qualification results

Date: 2026-10-14 (Asia/Bangkok)

Status: Battery closed-lid progress observed. Ordinary Sleep blockage observed by
the operator. End mode and sleep remains pending. The integrated app feature is
not qualified or implemented yet.

## Authorization and retained evidence

The user authorized required helper installation, live power changes, routine
repairs and bounded retries, Sleep tests, and restore-first cleanup. That approval
supersedes the earlier per-hash approvals and installation-attempt caps. It does
not supersede the 60-second physical lease limit, safety protections, separate
coordination of physical actions, or removal before waiting for participation.
No macOS security settings, sudoers rules, or private entitlements were changed.

The [earlier recovery measurements](2026-10-14-lid-closed-pmset-experiment.md)
and their immutable evidence from c9a8af09 remain unchanged. The repaired idle
cleanup and missed-cue trial remain in the
[retry report](2026-10-14-lid-closed-qualification-retry.md). A missed cue does
not establish a physical lid trial.

The new [raw evidence](2026-10-14-lid-closed-physical-results.json) preserves
timestamped native samples, installation and cleanup receipts, root recovery
records, and operator reports separately. Times below are UTC. These observations
apply to this Mac16,8 on macOS 26.6.2 (25G83), in the tested configuration.

## Battery closed-lid progress

Lease FFD1714F-AAA5-4F26-BA13-6DFF12AD5337 began at 10:16:27.596744 with a
fixed 60-second allowance. The operator acknowledged the visible “Closing now”
cue at 10:16:36.414588. Nineteen SHA workload samples, from 10:16:37 through
10:16:55, observed lidClosed=true, onBattery=true, 98-percent battery, nominal
thermal state, active phase, and SleepDisabled=true. Their continuous-clock
span was 18.2564 seconds; 1,245,184 bytes were hashed during those samples.
The progress counters advanced and digests changed.

The operator confirmed clicking the cue and physically closing the lid, estimated
about 15 seconds, and reported that music continued playing. This supports the
timestamped work evidence; music alone would not qualify work progress.

The first observed-open sample occurred at continuous time 544327.5089300417.
Restoration began 0.333038 seconds later. The guardian's confirmed restored
snapshot occurred 0.609839 seconds after that first observed-open sample.
These are observation-relative bounds, not the exact physical lid-open instant.
The final root observation at 10:17:49.578429 confirmed needsRestore=false,
SleepDisabled=false, no pending power child, removal of the helper and both
plists, missing launchd services, and guardian PID 15803 absent. No fallback
restoration command was used.

The diagnostic driver reported experiment-restoration-unresolved after guardian
removal made its XPC status unavailable. Independent root and kernel evidence
confirmed restoration. The driver now distinguishes unavailable status from
unresolved restoration and requires both the journal and kernel flag before
claiming restored. This diagnostic repair does not change the power mechanism.

## Ordinary Sleep

Lease 5F006B21-98D6-4890-A6CF-11A4B1E5BEDA began at 10:31:21.058790 on
battery with the lid open, 95-percent battery, and nominal thermal state. The
operator acknowledged “Trying Sleep” at 10:31:26.974923 and reported following
the instructions, except Apple menu Sleep was greyed out and could not be
clicked. That establishes the disclosed ordinary Sleep limitation in this
trial; it is not a physical sleep/wake result.

The fixed deadline was 545251.5568215833. Restoration began at
545252.031757375, 0.474936 seconds after expiry. Final root metadata at
10:32:25.366431 confirmed needsRestore=false, no pending power child, helper
and plist removal, both services missing, and guardian PID 16882 absent.
The independent kernel read at 10:32:25.399768 showed SleepDisabled=false.
No fallback was used. The repaired diagnostic ended with
experiment-status-unavailable as the guardian removed its status endpoint.

The post-cleanup pmset power-log query exceeded its 15-second observation
budget. A narrow powerd unified-log query for this interval returned no matching
Sleep/Wake rows. Neither an unavailable log nor absence of rows proves physical
sleep. The qualification coordinator now records the bounded log timeout
without turning verified cleanup into a failed cleanup claim.

## Remaining qualification

End mode and sleep must separately demonstrate observed sleep and wake after
confirmed restoration. A successful command or a cleared override alone is
insufficient. App lifecycle, original-run enrollment, temporary instructions,
cup/shared notice UX, actual UI interaction, and the packaged app/helper
authentication boundary remain unfinished. Display/backlight and screen-lock
behavior are not established by the SHA samples or music report.

## End mode and sleep attempt, 2026-10-14

Lease C4120DD3-47BE-4594-92EF-CDECB94F4B27 started at 10:38:28.040021.
The operator acknowledged the Sleep action at 10:38:30.019369. The native
response reported a restored journal, SleepDisabled=false, and a successful
Sleep request. The operator reported “It slept; Spacebar woke it.” Preserve
that report independently from the system evidence.

Kernel records show Software Sleep at 17:38:30.111 Bangkok time, followed by
user activity and a full-wake request at 17:38:30.133, just 22 milliseconds
later. The capability transitions were ON_STATE to ON_STATE, f to 9 and back
to f, with SystemHasPoweredOn notifications at 17:38:30.466. They do not establish
the requested sustained physical sleep interval. The immediate input activity
may relate to dismissing the dialog; this is an inference, not an established
cause. This trial is unqualified despite the successful command and operator
report. No automatic repeat Sleep request was made.

Final metadata at 10:38:54.898137 confirmed restoration, removal of the helper
and plists, both missing services, no pending power child, and guardian PID
17535 absent. Independent kernel observation also showed SleepDisabled=false.
No fallback was used.

A coordinated retry with a two-second cue-settling delay failed during
installation with transition-pending. It started no lease and showed no Sleep
cue. Failure cleanup confirmed the flag false, removal, and guardian exit at
10:42:29.135012. The installer attempted to clear its admission gate after
launching both jobs, which could concurrently hold the recovery lock. The repair
moves that gate reset before either job is launched. The user then stopped work;
no further physical action was assumed.
