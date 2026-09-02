# HOST-REQUEST-PLANE — the sidecar asks main to do something

**Status: PROPOSED 2026-09-03 — operator ruling required. No implementation is
authorized by this document.** Branch `migration`. Companion to
`PEER-SESSIONS.md`, which is the first consumer; this document is kept separate
because it changes WHO MAY ASK WHOM FOR WHAT, and that rule outlives any one
feature. Anchors verified against the working tree on 2026-09-03; where this
document and source disagree, source wins.

## 0. What this is

Today every request on the desktop wire flows TOWARD the sidecar: renderer →
preload → main → supervisor → sidecar, validated fail-closed at the sidecar. The
sidecar answers with events and snapshots only. `ServerFramePayload`
(`app/shared/protocol.ts:3326`) has no request variant; the host control plane
(`createSession` / `restoreSession` / `closeSession` / `listSessions`,
`app/host/host.ts:278-474`, typed in `app/shared/hostApi.ts:338`) runs in
Electron main and is reachable from the renderer alone.

An agent that creates, lists and messages other sessions runs INSIDE a sidecar.
Everything it needs main to DO (spawn a process, resolve a name, deliver to
another process, restore a parked one) has no path. This document adds that
path as a bounded request/result pair and states the trust rules that make the
inversion safe.

## 1. Is this the anticipated extension, or a reopened decision?

`PROTOCOL-ENVELOPE.md` R4 rejected "control-plane frames on the wire now" with
one reason: *no second client exists; frames minted without a consumer would be
designed blind.* E-3 says wire frames come "only when a remote client exists
(DR-4 watch-item)".

- **Encoding: anticipated.** The consumer now exists and its verbs are the
  existing host methods. R4 said the wire encoding "can be added under [the
  host API] later without touching engine or sidecar vocabulary". The engine
  vocabulary is untouched. The sidecar vocabulary gains two app-owned kinds,
  which is the same additive pattern PERMISSION-BOUNDARY C2/C3 used.
- **Direction: NOT anticipated.** DR-4 imagined a remote client calling the
  host API from outside main, a peer of the window. This is the sidecar, a
  child main supervises and the process that runs model-driven code, asking
  main to spawn processes. `SECURITY-MINIMUM.md` Addendum 2026-07-04 states
  the opposite as an invariant: "the control plane never adds an inbound frame
  type to the socket protocol; its only contact with a sidecar is the spawn
  environment." **This document amends that one sentence**, and that amendment
  is the ruling the operator is asked for (§9).
- **Locked decisions (CLAUDE.md §5): none moved.** Transport stays the
  Unix-domain socket. N-process stays; there are more processes, not fewer.
  Raw `AppSessionEvent` stays raw; the new kinds sit beside events, no mapper.
  Die-with-window is unchanged. The two-id model is unchanged: a peer NAME is
  an alias main resolves to an `appSessionId`, never a third identity.

## 2. Shape

Two app-owned frame kinds, versioned under `PROTOCOL_VERSION` 1, additive.

```
sidecar → main   host.request  { protocolVersion, sessionId, requestId, verb, args }
main → sidecar   host.result   { protocolVersion, sessionId, requestId, ok, value | error }
```

- `requestId` is minted by the sidecar per request and echoed on the result,
  the T5a analog already used by `history.loadEarlier.result`
  (`protocol.ts:3305`). A result whose id matches no pending request is dropped
  and logged at the sidecar.
- `verb` is a **closed allowlist**. v1 verbs, all scoped to the requester's own
  registry row:

| verb | what main does | returns |
|---|---|---|
| `peers.list` | registry rows in the requester's workspace that carry a name | descriptors: name, appSessionId, status (live/parked/closed), createdBy, lastActivity, title |
| `peer.create` | `createSessionInWorkspace(requesterId)` (`host.ts:430`) then stamp `createdBy` + deliver the creation prompt | the new row's name + appSessionId |
| `peer.deliver` | resolve name → row; live: forward `peer.deliver` inbound to that sidecar; parked/closed: restore via the existing restore path, then forward | outcome enum (§4) |
| `peer.notifyWhenIdle` | one-shot: when the named row next leaves `busy`, deliver a notice to the requester | ack |

Not in v1: `session.close` (closing a tab is the operator's act), any verb that
takes a filesystem path, any verb that returns file contents.

## 3. Trust rules (the price of the inversion)

Numbered HR1–HR7 so tests and reviews can cite them, in the style of HC1–HC4.

- **HR1 — main validates fail-closed.** `host.request` is decoded by the
  supervisor and handled in main under a sidecar-local-style schema: closed
  verb allowlist, strict top-level keys (the `checkStrictKeys` idiom,
  `sidecarServer.ts:5448`), per-verb Zod args, `MAX_OUTBOUND_FRAME_BYTES`
  already bounding the frame. Unknown verb or bad args → `host.result` with a
  typed error, never a throw into main, never a silent drop (E-2 precedent).
- **HR2 — identity is the connection, never the frame.** The requester is
  `record.sessionId` from the supervisor map (PROTOCOL-ENVELOPE E-1), and main
  stamps `from` on every delivered message from that. A `from` field inside
  the request is not read; the outbound self-check that drops a frame whose
  inner `sessionId` ≠ `record.sessionId` already covers forgery.
- **HR3 — scope is the requester's registry row.** `peer.create` sources its
  cwd from the requester's row exactly as `createSessionInWorkspace` does for
  the renderer; `peers.list` and `peer.deliver` resolve only rows whose cwd
  equals the requester's. HC1 is preserved in full: no path is ever authored
  by the model. A `peer.deliver` to a row outside the workspace is
  `session_not_found`, the HC2 answer for an id the caller may not name.
- **HR4 — spawning stays bounded, and gains a per-requester budget.**
  `peer.create` passes through `Host.createSession`'s HC4 caps
  (`MAX_LIVE_SESSIONS` 32, `MAX_SPAWNS_PER_WINDOW` 8 / 10 s) unchanged, plus
  `MAX_PEERS_PER_CREATOR` (proposed 4 live peers whose `createdBy` is this
  row) so recursion (Bear creates Charlie creates Dave) cannot ladder to the
  global cap. Either breach → `session_limit`.
- **HR5 — the result is a new INBOUND kind, treated as such.** `host.result`
  and `peer.deliver` arrive at a sidecar over the socket, so each gets what
  every inbound kind gets (CLAUDE.md §5/§6): a sidecar-local schema, an
  allowlist entry, `checkStrictKeys`, a boundary test accepting a valid frame
  and rejecting an invalid one, and a doc comment citing this decision.
  `peer.deliver` additionally carries main-stamped `from` and a hop chain (§4)
  that the sidecar treats as data.
- **HR6 — no file contents cross this plane, in either direction.** Main never
  returns transcript text; the sidecar reads transcripts itself from the
  unified store (SESSIONS-UNIFICATION) using ids the result gave it. Main never
  receives a path.
- **HR7 — the existing guards still apply, and only them.** `secretGuard` runs
  on `host.request` as on every outbound frame; it is a KEY-NAME guard
  (SECURITY-MINIMUM scope note), so a verb arg carrying a credential-shaped
  key is rejected, and values are not scanned. Nothing here relies on value
  scanning.

## 4. `peer.deliver` mechanics

1. Main resolves `to` (a name) against the registry, HR3-scoped. No row →
   `session_not_found`.
2. Main builds the inbound `peer.deliver` frame: `{ from: <requester name>,
   fromSessionId, kind: 'notify' | 'request', text, hops: [...appSessionIds] }`.
   `hops` is the requester's incoming chain (if this send is a reply) plus the
   requester's own id. Main rejects a send whose chain already contains the
   recipient (`hop_loop`) or exceeds `MAX_PEER_HOPS` (`hop_runaway`). With one
   trusted router there is no need for the upstream blinded-token variant.
3. Main applies the channel guards: per `(from, to)` token bucket, duplicate
   body within a short window, queue depth at the recipient. Breach → typed
   refusal; nothing is dropped silently.
4. Recipient live: forward the frame; the recipient sidecar enqueues it into
   the engine command queue (`app/sidecar/sidecarServer.ts` already calls
   `enqueue` / `enqueuePendingNotification` from
   `src/utils/messageQueueManager.ts`). A `request` uses the `next` priority,
   so a busy recipient reads it between tool calls at the existing drain
   (`src/query.ts:1942`), and an idle recipient starts a turn. A `notify` uses
   the `later` priority: it lands in the transcript and the model sees it on
   its next turn; it starts none.
5. Recipient parked or closed: a `request` restores through the same path a
   user submit takes (IDLE-PARK §3a, REGISTRY R3), then forwards. A `notify`
   to a parked or closed row is persisted for delivery on the next restore and
   does NOT wake it.
6. The `host.result` reports what happened: `queued_live`, `queued_wake`,
   `stored_for_restore`, `refused:<reason>`. The sending model sees this in its
   tool result, so it never reasons from a false belief that a peer heard it.

## 5. Per-plane change list (for the dispatch that builds it)

| plane | change |
|---|---|
| `app/shared/protocol.ts` | `HostRequestFrame` in `ServerFramePayload`; `HostResultFrame` + `PeerDeliverFrame` in the inbound union; doc comments cite this file. No version bump (additive). |
| `app/supervisor/supervisor.ts` | decode `host.request` like any outbound frame; no routing change (identity by `record.sessionId`). |
| `app/main/main.ts` / `mainDecisions.ts` | Electron-free handler: verb allowlist + schema + HR3 scoping + guards, calling `Host` methods; result forwarded through the existing `forward(sessionId, …)`. |
| `app/host/host.ts`, `app/host/registry.ts` | additive row fields `name`, `createdBy`; `createSessionInWorkspace` gains an internal caller that stamps them; per-creator count. |
| `app/sidecar/sidecarServer.ts` | request client (mint id, await result, timeout); inbound schemas + allowlist for `host.result` and `peer.deliver`; enqueue with priority by kind. |
| `app/main/idleParkDriver.ts` | none. A wake through restore is already a spawn the driver sees. |

## 6. Tests owed before ratification of the build

- Boundary: `host.result` and `peer.deliver` accepted when valid, rejected on
  unknown key, wrong type, missing `requestId`, mismatched `requestId`.
- Main: unknown verb → typed error; verb args failing schema → typed error;
  HR3: a `peer.deliver` naming a row in another cwd → `session_not_found`;
  HR4: fifth live peer for one creator → `session_limit`.
- Loop: a chain containing the recipient is refused; a chain over the cap is
  refused; two sessions replying to each other stop within the cap without
  prompt help (run against the real queue, not a stub: CLAUDE.md §8 rule 1).
- Delivery: `request` to a busy live recipient is read between tool calls;
  `notify` to an idle recipient starts no turn; `request` to a parked row
  restores it and the prompt arrives (the IDLE-PARK §9 path).
- `bun run --cwd app test:hardening` green.

## 7. Rejected

- **R1 — the file mailbox (`src/utils/teammateMailbox.ts`) as transport.** It
  is polled on the recipient's own schedule and cannot wake a parked or closed
  session; only main can. Its envelope and the classifier doctrine are reused
  (PEER-SESSIONS §5); its transport is not. This is the §8-rule-10 verdict.
- **R2 — the sidecar reads the registry file directly.** Main owns that file
  and its locking; a second reader races the writer, and CATALOG-OWNERSHIP
  moved enumeration off sidecars for a reason.
- **R3 — relay through the renderer.** Would route a model-originated spawn
  through the least trusted zone.
- **R4 — a generic `host.invoke(method, args)`.** The HC3 objection to a
  generic invoke applies to the sidecar as much as to the preload.

## 8. Adversarial self-review

- **A1 — a compromised sidecar (prompt-injected model) forks the machine.**
  HR4: HC4 caps plus the per-creator budget bound it to a handful of
  processes; each spawn is also a real, visible tab the operator sees appear.
- **A2 — a compromised sidecar reaches another workspace.** HR3 answers with
  `session_not_found`; the only cwd it can spawn into is its own.
- **A3 — a peer message impersonates the user.** `from` is main-stamped (HR2)
  and the engine wraps it in the cross-session tag the auto-mode classifier
  already treats as not-user-intent
  (`src/utils/permissions/yolo-classifier-prompts/upstream/system_prompt.txt:77`).
- **A4 — two peers loop.** §4 steps 2–3, mechanical, prompt-independent.
- **A5 — a `request` wakes a parked session the operator wanted parked.** It
  is the same wake the operator's own next message performs (IDLE-PARK §3a),
  bounded by the caps; the park driver re-parks on its next sweep.

## 9. Ruling requested

**Amend `SECURITY-MINIMUM.md` Addendum 2026-07-04:** replace "the control plane
never adds an inbound frame type to the socket protocol" with "the control plane
adds inbound frame types only as results of sidecar-originated requests and
as main-stamped peer deliveries, each validated at the sidecar under HR5". That
sentence is the whole ruling; everything else in this document follows from it
or from decisions already on record.
