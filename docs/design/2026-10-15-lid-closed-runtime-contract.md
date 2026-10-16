# Lid-closed runtime contract

Implements the [approved product specification](2026-10-13-lid-closed-mode-spec.md).
Qualification and limitations are tracked in the
[integration results](../research/2026-10-15-lid-closed-integration-results.md).

## Owners and transport

| Boundary | Authority and validation |
|---|---|
| Renderer → preload → main | Three fixed channels: read, command, changed. Main checks the owning window sender and closed command schema. Only preset integers 15/30/60/120 and named actions are accepted. No arbitrary executable, path, command or permission rule is supplied. |
| Main → supervisor → Unix socket → sidecar | `lid.work` carries a UUID request and optional bounded window. The sidecar receiving boundary validates keys, UUIDs, roots, booleans, deadline, byte size and request rate. No renderer bridge forwards this host control message to an engine. |
| Sidecar → main | Runtime observations contain generation, monotonic sequence and bounded root/child rows. Main correlates request ID, session identity, current generation and increasing sequence. These frames are consumed before renderer forwarding and are not replayed. |
| Main → native bridge → privileged XPC service | Fixed operations only. The helper checks UID, bridge signature/path, kernel parent identity, pinned app signature/path, regular app identity and sealed/hardened application policy. No caller-supplied shell strings reach pmset. |
| Helper → macOS | Durable root journal and tracked power-command child precede changes. Native deadline, battery/thermal readings, stale supervision and independent recovery do not depend on renderer timers. |

`lid.work` is additive to protocol version 4. Old sidecars cannot supply usable
work observations, so they time out rather than allow activation. It is not a
persisted or replayed event. Wire validators reject extra keys and malformed
values. The real socket and existing host/engine permission boundaries remain.

## Scope and lifecycle

Each actual controller turn has a fresh process-local root. Async descendants
retain that root. Completed roots can remain visible but do not keep a mode
active; unrelated later work and independently created peers are excluded.
Temporary context and protected admission use the same root identity. Work
observations expire after 2.5 seconds without a fresh host update; this withdraws
context and blocks further enrolled scheduling. This is an engine observation
TTL, not a measured promise about physical restoration latency.

Main polls work and supervises the helper without extending its native deadline.
It records local pending intent before admission. Startup restores an interrupted
native session rather than adopting it. Native journal errors or inaccessible
authority remain unresolved even if the local marker says false. The local
marker cannot authorize power or supersede the root journal. Closing/reopening
windows serializes old-owner cleanup before a new owner initializes; old-owner
notifications cannot replace the new view.

## Setup, signing and removal

The local package uses ad-hoc signing without an Apple-issued certificate or
Touch ID. The earlier Team-ID/library-validation build failed at launch; that
historical result is preserved in the integration report. The replacement uses
a sealed ASAR, startup fuses, hard/kill code flags and an exact signed kernel
library constraint for eight Electron libraries, with no exception entitlements.
Packaged renderer DevTools are disabled. Native admission also checks the live
valid/hard/kill flags, sticky debugger status and a closed startup-argument list
on every request. The native bridge uses hardened ad-hoc signing and the XPC
connection enforces its code requirement on every message.

Those checks alone cannot authenticate loaded JavaScript from a mutable app:
a local experiment ran substituted ASAR/Info.plist contents, restored them,
and passed a later static check. Therefore one administrator setup creates a
root-controlled snapshot at
`/Library/PrivilegedHelperTools/com.catcode.lid-closed-app/Cat Code.app`.
Only its fixed executable can activate, adjust, Continue or request Sleep.
Ancestor ownership, modes, write-granting ACLs, the entire snapshot tree and
symlink confinement are checked at connection admission. Setup checks protected
destinations using the digest-verified root-stage helper before executing old
or new installed helper code. The frozen snapshot must pass the pinned app
requirement and deep resource verification before jobs start.

The original source app has recovery-only access (`status` and `retry`). It
instructs the user to finish current work and choose Reopen Cat Code. Reopen
checks all observed work before quitting and launches only the fixed protected
path. It does not transfer active work. Subsequent starts need no administrator
prompt; a rebuilt app needs explicit repair/reauthorization. The ordinary
installed application is not replaced.

The initial administrator setup assumes a trusted, reviewed local build. Hashes
embedded in sealed JavaScript bind helper/install/uninstall assets before those
buffers are staged. They prevent external setup-resource substitution; they do
not make an already compromised source JavaScript process a trustworthy broker
for administrator consent.

Root configuration is now version 2, with `setupOnly` parent capability and an
optional restrictive qualification deadline. Older readers reject version 2,
rather than silently losing that capability restriction. Restore-first setup
runs the previous installed helper against its previous configuration before
publishing version 2. The recovery journal format is unchanged.

Removal retires admission and confirms restoration before unloading both jobs
and deleting the helper. Failure retains recovery authority and the warning.
A running protected snapshot is retained to avoid interrupting work; after it
quits, rerunning the retained root-owned removal script removes that copy too.
The root journal/configuration remain as evidence and cannot enable power
without an installed helper.

Qualification sets `CATCODE_LID_CLOSED_TRIAL=1` in the isolated app. This only
restricts the root configuration: normal caller, hardware and preset validation
remain. One lease is capped at 60 seconds from its original native start,
including adjustment and Continue, and retirement makes it terminal. The
independent guardian removes experimental authority after an unused 30-second
setup window or the bounded lease/cleanup window. Production exposes no short
preset and has no test command that grants broader authority.

Ordinary Sleep blockage, exclusive override ownership and measured-only recovery
bounds remain the approved tradeoffs. Hardware evidence is limited to
Mac16,8 / 25G83; actual app/helper and active UI qualification is recorded
separately in the integration results and remains required before completion.
