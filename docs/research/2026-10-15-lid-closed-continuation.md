# Lid-closed continuation after stopped qualification

Date: 2026-10-15 (Asia/Bangkok)

Status: Physical Sleep qualification pending. App integration remains unfinished.

The [physical results](2026-10-14-lid-closed-physical-results.md) preserve battery
closed-lid progress, ordinary Sleep blockage, the immediately awakened Sleep
attempt, and the later installation failure. The c9a8af09 recovery evidence is
unchanged. The user stopped work, then explicitly asked to continue. A fresh
readiness answer is required before another physical trial.

The installer now resets its admission gate before launching the daemon and
watcher. The real installation-only check at 02:11 Bangkok time succeeded in
installation. Its idle guardian removed the helper and both jobs. The final
administrator metadata read was cancelled; it was not repeated. Independent
kernel, file, launchd, and process observations subsequently confirmed
SleepDisabled=false, both plist files and helper absent, both services missing,
and guardian PID 21289 absent. The root journal and pending-child ledger were
not collected at that final observation. No work lease or Sleep request started.

The requested review-impl pass found a diagnostic false-success case: a corrupt
journal snapshot with a cleared kernel flag was considered restored. The fix
uses one restoration predicate requiring a valid, settled journal state,
no snapshot error, no restoration obligation, and a cleared kernel flag.
Both diagnostic exits use it. The real native Core suite passes. A mutant
restoring the previous predicate fails the corrupt-journal assertion for the
intended reason. The predicate adds no encoded or persisted field, permission,
dependency, or power command. Independent review confirmed the finding fixed.

Current pinned preparation is /private/tmp/cat-lid-install-dH63BV:

- Installer SHA256: 50990c2d21db8dd4b6775083c117d3610167245363bb17d6adf6017ace5ba05b
- Helper SHA256: 35333d3ebd90072b2f9824c9e8523132719dff3a1d34729069c2d89355fe2e64

Expanded user authorization covers this routine repair and bounded retry;
the earlier per-hash caps are superseded. The physical lease remains 60 seconds.
The coordinator waits two seconds after the explicit Sleep cue, retains the
independent cleanup guardian, and records an unprivileged clock witness using
mach continuous and absolute time. Clock observations supplement system
transitions and operator reports; they do not substitute for either.

Normal setup and final metadata collection now share a single administrator
authorization. The temporary root collector reads only the scoped recovery
metadata, publishes initial and final observations in a newly created root-owned
read-only temporary directory, and exits after removal or its 105-second bound.
It adds no launchd job or power operation. Its exit, guardian exit, removal,
and kernel state must be checked before waiting. Explicit cleanup and the
documented fallback remain available if automatic cleanup fails.

Automated checks and source review do not qualify hardware Sleep, packaged
authentication, original-run enrollment, temporary agent instructions, or UI
interaction. No feature-complete claim is made.
