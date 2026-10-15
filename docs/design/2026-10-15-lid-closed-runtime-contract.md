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

The default local package remains ad-hoc signed. It is not granted persistent
helper authority. A supplied `CATCODE_SIGNING_IDENTITY` enables a hardened build
with library validation; this branch is currently unverified because this Mac
has no suitable identity. No signing certificate, security exception or
notarization workflow is automatically created.

One administrator setup pins the exact app and helper code, installs the fixed
helper and watcher, and restores interrupted state before admitting work.
Subsequent app signature changes require explicit repair/reauthorization.
Removal uses the bundled fixed restore-first script, not a renderer-authored
command. Failed restoration retains recovery authority and a visible warning.

Ordinary Sleep blockage, exclusive global override ownership and measured-only
recovery bounds remain the approved tradeoffs. Current hardware qualification
is limited to the recorded Mac16,8 / 25G83 evidence; app qualification remains
separate and incomplete.
