# Observed Sleep qualification

Date: 2026-10-15 (Asia/Bangkok)

Status: The native mechanism has physical battery closed-lid progress,
ordinary Sleep blockage, and actual End mode and sleep evidence on Mac16,8,
macOS 26.6.2 (25G83). App integration and packaged/UI verification are still
unfinished. This is conditional qualification, not a general safety guarantee.

The [raw observations](2026-10-15-lid-closed-sleep-evidence.json) retain each
trial and operator report separately. The [earlier physical results](2026-10-14-lid-closed-physical-results.md)
and c9a8af09 recovery measurements are unchanged.

The first trial's ten-second cue expired while the operator read the chat.
The coordinator sent Cancel, not Sleep. Root metadata at 12:08:23.302893
confirmed restoration, no pending power child, helper/plist removal, missing
services, and guardian PID 30988 absent. The collector exited successfully.
The cue was increased to 30 seconds within the unchanged 60-second lease.

## Wake-source investigation

The next trial restored normal sleep and requested Sleep at 12:10:27.229980.
The operator reported sleep until Spacebar, but the kernel recorded a full-wake
request at 12:10:27.518, about 230 milliseconds after its Software Sleep event.
At that exact timestamp powerd attributed the UserIsActive assertion to
WindowServer and the Razer Viper V3 Pro, eventType 17. This trial does not prove
sustained sleep. It establishes an observable external input wake trigger,
not a failure to clear the override. Final root evidence confirmed removal,
guardian PID 31500 absent, no pending child, and SleepDisabled=false.

Apple's [root-domain source](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp)
routes user activity during dark wake to a full-wake policy event. Its
[assertion implementation](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmconfigd/PMAssertions.c)
also describes the activity tickle path. Those sources explain the kind of
transition; the named device and timing above come from this Mac's records.
No wake protections or input permissions were disabled.

## Mouse-disconnected trial

The operator explicitly confirmed switching off the mouse or disconnecting its
receiver. The lid stayed open and the observed power source was AC. Lease
46560C99-92FB-44CF-ACFD-0C1D26626ACD began at 12:13:51.175 approximately,
with 95-percent battery, nominal thermal state, and a fixed 60-second allowance.
The operator clicked End mode and sleep at 12:13:57.733757. After the two-second
settling delay, the coordinator sent Sleep at 12:13:59.735003.

The root controller confirmed a settled journal and SleepDisabled=false before
requesting Sleep. Its receipt was successful; no repeat request occurred.
Final root evidence at 12:14:01.279178 confirmed helper/plist removal, both
services missing, guardian PID 32939 absent, no pending power child, and
needsRestore=false. The independent kernel flag was false at 12:14:01.305
approximately. The collector exited before the unprivileged observation wait.
No fallback restoration was used.

The system then recorded:

- 12:14:00.304: Software Sleep, initially removing graphics capability.
- 12:14:05.325: ON_STATE to SLEEP_STATE, capabilities 9 to 0.
- 12:14:05.340: powerd Entering Sleep, Software Sleep pid 32971.
- 12:14:07.168: completed ON_STATE to SLEEP_STATE transition.
- 12:14:07.418: Wi-Fi/Bluetooth DarkWake from Deep Idle.
- 12:14:28.324: full wake requested by user activity.
- 12:14:28.330: internal keyboard activity, eventType 3.
- 12:14:28.366: SystemHasPoweredOn.

The operator reported that music stopped, the Mac fully slept, and Spacebar
woke it. This agrees with actual system Sleep followed by background DarkWake
and a later keyboard-triggered screen wake. It does not establish uninterrupted
CPU suspension: the clock witness measured about 69.4 milliseconds of additional
continuous-versus-awake time, and the system explicitly recorded DarkWake.
Do not describe the entire dark-screen interval as CPU-off sleep.

## Product consequences and remaining work

End mode and sleep can restore and request actual system Sleep in this tested
configuration. An input peripheral can immediately wake the Mac, and macOS can
perform background DarkWake. The feature must report a sleep request separately
from restored power settings and must not promise that the Mac remains asleep.
Do not suppress normal input wake or unrelated applications to manufacture a
passing result. Battery closed-lid progress remains established by the earlier
timestamped workload, not by this AC-powered Sleep trial.

The experimental installation is removed. App-wide run enrollment, temporary
agent context, shared recovery notices, cup interaction, actual UI behavior,
Electron supervision recovery, and the packaged helper/app boundary still need
implementation and verification before the feature can be called complete.
