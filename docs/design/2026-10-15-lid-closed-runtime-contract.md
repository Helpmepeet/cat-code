# Lid-closed runtime contract

Updated 2026-10-17 to add the five-minute preset to the user's manual, whole-Mac personal-use mode. This
implements the current [product specification](2026-10-13-lid-closed-mode-spec.md).
See [qualification results](../research/2026-10-16-systemwide-lid-mode.md) for
observed behavior and remaining hardware/installation limits.

## Owners and boundaries

| Boundary | Contract |
|---|---|
| Renderer → preload → main | Fixed read, command and changed channels. Owning-window checks and a closed command schema permit only five presets and named lifecycle actions. No paths, shell commands or permission rules. |
| Main owner | One manually activated lease across views. No session inventory or job enrollment. Direct pulses supervise native authority. Native menu makes activation available without a job; detaching the owner disables menu controls. |
| Main/native clients → root XPC | Any process in the configured account may launch the fixed root-owned bridge. The receiver authenticates kernel effective UID, exact installed bridge path and signature, with a per-message NSXPC code requirement. Parent app identity is deliberately not required. |
| Root helper → macOS | Fixed power operations only; root journal persists intent before changes. Deadline, reserve, thermal/monitoring checks, stale supervision and independent recovery remain native. |

Legacy `lid.work` shapes remain wire-compatible. Current main sends no work
windows or temporary instructions and consumes old observations without renderer
forwarding or replay. Legacy inbound sidecar controls are dormant compatibility
code; they are not used to admit or supervise this mode. Existing engine
permissions are unchanged.

## Grant, packaging and setup

Administrator setup grants this UID access to a narrow native power service.
It does not grant arbitrary root commands. Other apps benefit from the global
awake state and may use the fixed bridge. Removing the helper and launchd jobs
revokes this persistent capability. Cat Code rebuilds do not require app identity
reauthorization; replacing the native helper can require setup repair.
Before a manual start, main compares the installed helper with the sealed bundled
helper. A missing or different helper goes through administrator setup before
admission; initialization alone never prompts for an upgrade. An unchanged helper
does not prompt again, and declining an upgrade does not start a lease.

The Electron app uses ordinary ad-hoc signing plus existing ASAR/fuses. The
native helper uses hardened ad-hoc signing and system libraries. There is no
Apple-issued certificate, protected application copy, library-constraint SPI,
DYLD/debug exception, broad sudoers entry or repeated biometric requirement.

Sealed main embeds helper/install/removal hashes. Verified asset buffers and
in-memory configuration/plists define every expected payload digest before
administrator authentication. Root copies into protected staging, checks those
digests and secure destination paths, validates configuration, restores existing
authority, then publishes the fixed files. Same-account staging substitution
fails closed rather than authoring new root payload pins.

Root configuration v3 explicitly encodes `access: account` or the restrictive
`experiment` lane, configured UID and exact bridge requirement. Account grants
require `experimentUntil: 0`; experimental grants require a finite expiry and
cannot mix the application-trial field. v1/v2 readers reject v3. The root
journal format remains v1 so restore-first upgrade can settle old leases.
Legacy lid-open records remain readable for restoration only.

## Lease and restoration

Native Start checks initially open lid, exclusive global override, qualification
and monitoring before recording intent or changing power. Later lid transitions
do not end/reset the lease. Adjustments calculate the deadline from original
start, not the adjustment. Root allows fixed 300/900/1800/3600/7200-second presets.
A restrictive application trial accepts normal inputs but admits one activation
capped at 60 seconds, including activation delay; its independent guardian also
bounds stale/unused experimental authority.

Stop, expiry, missing supervision, low battery, unsafe thermal readings and
monitor failure restore normal sleep. Recovery intent is durable before power
changes; a separate native watcher handles daemon interruption. Status never
claims Off while restoration is unknown. End mode and sleep settles the override
before requesting Sleep; successful commands alone do not prove actual Sleep.
Observable external override conflicts end safely, but simultaneous writers
cannot be perfectly attributed.

Electron shutdown retains the `3e8992b4` deferred `setImmediate` resumed-quit
repair. Exit evidence must observe OS process disappearance, not a lifecycle
log named `process.exited`. The user's [quit investigation](../reports/2026-10-16-packaged-quit-regression.md)
records the original bug and repair.

## Qualification

Mocks and native controller tests prove their named contracts only. Root XPC,
administrator setup/removal, GUI controls, actual PID exit and physical lid/Sleep
behavior need their own evidence. Reuse the earlier [physical results](../research/2026-10-14-lid-closed-physical-results.md)
and [Sleep results](../research/2026-10-15-lid-closed-sleep-results.md) for unchanged
mechanisms; they do not qualify this new app/helper grant. Every live trial is
at most 60 seconds, and authority is removed before waiting for participation.
