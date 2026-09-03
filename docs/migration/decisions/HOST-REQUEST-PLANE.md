# HOST-REQUEST-PLANE — the sidecar asks main to do something

**Status: RULED 2026-09-03 (operator approved the §9 amendment; SECURITY-MINIMUM
Addendum 2026-07-04 amended the same day). Implementation is NOT yet dispatched;
this document authorizes the design, not a build.** Branch `migration`. Companion to
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
  environment." **This document amends that one sentence**; the operator
  approved the amendment on 2026-09-03 and it is applied (§9).
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
| `peers.list` | registry rows in the requester's workspace that carry a name | descriptors: name, appSessionId, engineSessionId (null until the row's first ready frame), status (live/parked/closed), presence (`running` \| `needs_user` \| `idle`, from the `activity` frame, §4 step 4a; absent for a row that is not live), createdBy (resolved to a name, or `gone`), lastActivity, title |
| `peer.create` | in this order: allocate the name against the registry → spawn through the `createSessionInWorkspace` path (`host.ts:430`) with `name`, `createdBy` (id) and the creator's name in the child's spawn env → persist the row → await that row's `ready` → replay to the new sidecar the last `model.set`, `effort.set` and `permission.setMode` main forwarded to the creator (existing inbound kinds, `protocol.ts:126,1816,1824`; main keeps a per-row copy of what it last forwarded; if it forwarded none, the settings default applies to both, so nothing is sent), then the `model`/`effort` overrides from the args; permission mode is not an arg (PEER-SESSIONS §4) → deliver the creation prompt as a `request` with `generateTitle` on and the text untagged (PEER-SESSIONS §5). **What main replays, precisely:** model and effort come from the creator's own latest `run-controls.snapshot` frame, which the sidecar emits on attach and on every change (`sidecarServer.ts:855,980`) and which main already sees; the forwarded-frame record is not enough, because a resumed creator derives its model from its transcript without any `model.set` (`sessionController.ts:225`). Permission mode comes ONLY from the last `permission.setMode` main forwarded for that row, never from a sidecar-authored snapshot (a compromised sidecar could claim `auto`), and that record is cleared when the row's process exits, because mode is process-scoped and a restore starts at the settings default (`sessionController.ts:144`); no record means nothing is sent. Both are snapshotted when the request is accepted, not when the child is ready. **Idempotency and commit:** the key is `(requester appSessionId, requestId)`; the commit point is the row persisted with its name (`host.ts:484` order); a retry with the same key after commit returns the cached result and never spawns twice; a failure after `ready` (replay or prompt send rejected by `supervisor.send`, `supervisor.ts:459`) keeps the row, since it is a real session the operator can see, and returns `created_partial` naming the step that failed, so the caller can `SendToPeer` the prompt itself | the new row's name + appSessionId, or `created_partial` + name + failed step |
| `peer.deliver` | resolve name → row; live: forward `peer.deliver` inbound to that sidecar (the wake-block flag is irrelevant to a live row); parked/closed: refuse if the row's `peerWakeBlocked` is set (`refused:user_stopped`), else main's own restore-then-deliver (§4 step 5); mint `messageId` | outcome enum (§4) + `messageId` |
| `peer.notifyWhenIdle` | one-shot: if the named row is not `running` now, answer with its current presence and subscribe nothing; else when its presence next leaves `running` deliver a `notify` to the requester saying `idle` or `needs_user`; if the row leaves live first, deliver `peer_gone` with the reason. If the REQUESTER is parked or closed when the result is due, main stores it as a non-waking notice for its next restore (`stored_for_restore`, never a wake); the notice is main-authored, `from` is the watched peer's name and the text states the presence, so it renders like any peer row | ack with `subscribed` \| `already_idle` \| `already_needs_user` |

On the wire, `host.result` and `peer.deliver` are two new variants of
`SidecarClientMessage` (`protocol.ts:576`), sent through the existing
`forward(sessionId, …)` (`main.ts:3250`); the `protocolVersion` and
`sessionId` shown in the shape above are the `ClientFrame` envelope that
`supervisor.send` adds (`supervisor.ts:460-480`), not fields the handler
authors twice.

`engineSessionId` is on the list result because `ReadPeer` opens
`<engineSessionId>.jsonl` (`src/utils/sessionStorage.ts:320`) and the sidecar
has no other way to map a name to a transcript key: the mapping lives only in
main's registry (`app/host/registry.ts:94-100`), which R2 forbids the sidecar
to read. A null value means "nothing to read yet", not "no such peer".

Not in v1: `session.close` (closing a tab is the operator's act), any verb that
takes a filesystem path, any verb that returns file contents.

## 3. Trust rules (the price of the inversion)

Numbered HR1–HR7 so tests and reviews can cite them, in the style of HC1–HC4.

- **HR1 — main validates fail-closed.** `host.request` is decoded by the
  supervisor and handled in main under a sidecar-local-style schema: closed
  verb allowlist, strict top-level keys (the `checkStrictKeys` idiom,
  `sidecarServer.ts:5448`), per-verb Zod args. Unknown verb or bad args →
  `host.result` with a typed error, never a throw into main, never a silent
  drop (E-2 precedent). **Size and rate are NOT inherited from the channel.**
  `host.request` rides the sidecar→main direction, whose decoder bound is
  `MAX_OUTBOUND_FRAME_BYTES` (32 MiB, "a sanity bound, not a policy gate",
  `app/shared/limits.ts:22-25`; `supervisor.ts:376`) and which has no
  per-window rate cap at all (`MAX_FRAMES_PER_WINDOW` is enforced only at the
  sidecar for renderer traffic, `limits.ts:32`). Under §8 A1's threat model
  the request payload is model-authored, so main applies its own
  `MAX_HOST_REQUEST_BYTES` (= `MAX_FRAME_BYTES`, 128 KiB) to the serialized
  request and a per-session `MAX_HOST_REQUESTS_PER_WINDOW`; breach → typed
  refusal, logged. The directional limits themselves are not swapped or
  unified; this is a third bound at the consumer.
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
- **HR4 — spawning stays bounded by HC4, and by nothing else.**
  `peer.create` passes through `Host.createSession`'s HC4 caps
  (`MAX_LIVE_SESSIONS` 32, `MAX_SPAWNS_PER_WINDOW` 8 / 10 s) unchanged; a
  breach is the existing `session_limit`. No per-creator, depth or root budget:
  the operator ruled "no budget, allow it to spawn as much as possible"
  (PEER-SESSIONS R8), so recursion (Bear creates Charlie creates Dave) may
  ladder to the global cap, which is the same cap a human opening tabs meets.
  `createdBy` is still recorded (listing, `gone` resolution), just not counted.
  One registry rule is added because HC4 alone does not bound churn: a
  parked row leaves `liveCount()` (`host.ts:802-810`) and is exempt from the
  reap (`registry.ts:615-620`), and `enforceBound` removes fewer rows than
  needed rather than refusing (`registry.ts:625-627`), so create-park-create
  at 8 per 10 s grows the registry, the tab bar and main's peer state without
  limit. `peer.create` is therefore refused with `session_limit` when the
  registry holds `MAX_REGISTRY_SESSIONS` rows and none is reappable. This is
  not a peer budget: it is the existing global ceiling, made real for the one
  caller that can reach it at machine speed.
  Account selection is untouched by this plane: no account field is a verb arg
  (HR6), and the new process picks its Codex account as every session does
  (PEER-SESSIONS R10).
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
   fromSessionId, kind: 'notify' | 'request', messageId, text,
   hops: [...appSessionIds] }`. **The sidecar never sends a chain.** Its
   request carries an optional `replyTo` (a `messageId` main minted and
   delivered to this requester). **Chain inheritance is automatic and outside
   the model's control:** main takes the chain of the most recent message it
   delivered to the requester FROM this recipient within `PEER_CHAIN_WINDOW_MS`
   (PEER-SESSIONS §7), and, if `replyTo` names a message delivered to this
   requester, the longer of the two; then appends the requester's id. A
   `replyTo` main did not deliver to this requester is ignored and logged.
   Only a send to a peer that has not written to the requester within the
   window starts a fresh chain of one. So two peers answering each other
   extend one chain whether or not either ever sets `replyTo`, which is what
   makes the stop mechanical rather than a prompt hope. Main rejects a send whose
   chain already contains the recipient (`hop_loop`) or exceeds
   `MAX_PEER_HOPS` (`hop_runaway`). With one trusted router deriving the chain
   there is no need for the upstream blinded-token variant, and a compromised
   sidecar cannot shorten a chain it never held.
3. Main applies the channel guards: per `(from, to)` token bucket, duplicate
   body within a short window, and `MAX_PENDING_PEER_MESSAGES` per recipient
   (a NEW main-side count of undelivered peer messages; the sidecar's
   `MAX_QUEUED_PROMPTS` bounds only renderer `app.submit` prompts arriving
   mid-turn, `sidecarServer.ts:2431-2436`, and never sees this plane). Breach →
   typed refusal; nothing is dropped silently.
4. Recipient live, `kind: 'request'`: forward the frame; the recipient sidecar
   enqueues it into the engine command queue at `next` priority **on the
   task-notification path** (`enqueuePendingNotification`, mode
   `task-notification`, with a `MessageOrigin` of kind `peer`), never on the
   prompt path: `enqueueMidTurnPrompt` stages a `mode:'prompt'` command into
   the renderer's waiting-messages strip (`sidecarServer.ts:1969-1978`), which
   would show a peer message as something the user typed and subject it to the
   user's recall controls. A busy recipient reads it between tool calls at the
   existing drain (`src/query.ts:1942`); an idle recipient starts a turn from
   the sidecar's boundary drain (`drainOneTaskNotification` → `startTurn`,
   `sidecarServer.ts:1676`). That drain passes `generateTitle: false`
   (`sidecarServer.ts:1704`), which is right for every peer message except the
   creation prompt: the sidecar passes `generateTitle: true` for a
   `peer`-origin request on a session whose title is unset, so a created peer
   gets a title from its first turn like any session.
4a. Recipient live, `kind: 'notify'`: **the engine queue cannot carry a
   turn-free message.** The sidecar's boundary drains ignore priority and start
   a turn for anything they dequeue (`isDeliverableParentPrompt` /
   `isDeliverableParentTaskNotification`, `sidecarServer.ts:5285-5296`; the
   only modes that become attachments are `prompt` and `task-notification`,
   `src/utils/attachments.ts:1054`), so a `later` command would simply be read
   at the next boundary and billed. A notify therefore does NOT enter the
   engine queue on arrival. The sidecar (a) holds it in an app-owned
   `pendingNotices` list, (b) emits an outbound app-owned `peer.notice` event
   `{ messageId, from, kind, text, at }` so the renderer shows the row now,
   and (c) at the next `startTurn` from ANY
   cause (user prompt, a `request`, a task notification) enqueues the held
   notices at `next` priority ahead of that turn's input so the drain attaches
   them. Main keeps the durable copy until the sidecar acks consumption, so a
   park or crash between (b) and (c) loses nothing. The same notice then
   reaches the renderer a second time inside the engine turn that consumed it,
   as a `peer`-origin user row carrying the same `messageId`; the projector
   keeps the earlier `peer.notice` row and drops the duplicate by id, so a
   notice renders once, at the moment it arrived, and a reload (see below
   for what it replays) renders it once. Every `ServerFrame` kind needs a
   retention tier in main's exhaustive `FRAME_RETENTION`
   (`app/main/replayBuffer.ts:146`), and `peer.notice` is `ring`, like
   `event`: a reload BEFORE consumption must still show the notice (no
   transcript row exists yet), and a reload after consumption sees both the
   replayed frame and the transcript row, which the same `messageId` dedup
   collapses. `activity` is `sticky` (point-in-time state). The earlier
   wording here, that a reload (which never
   sees the `peer.notice` frame again) renders it once from the transcript.
   This is the mechanism that makes `notify` cost the recipient no turn;
   without it the two kinds differ only in mid-turn timing.
   The sidecar also emits an outbound app-owned `activity` frame
   `{ presence: 'running' | 'needs_user' | 'idle' }` on turn start and end
   and when a permission prompt opens or closes. Main today knows only recency
   (`idleParkDriver.ts:151-157` `recencyOf`) and never reads the engine's
   `turn.status` events (zero non-test `activeTurn` reads outside
   `app/sidecar`); this frame is how main learns busy/idle for `peers.list`
   and `peer.notifyWhenIdle` without interpreting engine event vocabulary, the
   same app-owned-field pattern as `ReadyFrame.engineSessionId`. Its initial
   value is derived at `ready`, from the ready payload's active-turn state and
   pending-permission list (`sidecarServer.ts:930`), so a freshly ready idle
   session is `idle` at once, never absent. `needs_user` holds while the
   pending-permission set is non-empty (permissions are a map,
   `AppSessionController.ts:67`, so two prompts resolving out of order do not
   flip it early). Presence is cleared on every terminal lifecycle of the
   row; absence means not live, nothing else.
5. Recipient parked or closed: IDLE-PARK §3a's wake is a RENDERER path
   (`resolvePendingSubmit` → `bridge.restoreSession` → hold → forward); main's
   share of it is only `host.restoreSession`. So for a `request` main runs its
   own deliver-after-ready: call `restoreSession`; on `already restoring` /
   `already live` (both currently answered as `session_not_found`,
   `host.ts:331-333,365-384`) treat the row as pending rather than missing;
   wait for that row's `ready` frame (main already observes it, `main.ts:1818`)
   under a timeout; then forward. Failure → `refused:wake_failed`, never
   `session_not_found`, which HR3 reserves for a row the caller may not name. A
   `notify` to a parked or closed row is stored in main and delivered at the
   next restore; it does NOT wake.
6. The `host.result` reports what happened: `queued_live`, `held_notice`,
   `queued_wake`, `stored_for_restore`, `refused:<reason>` (reasons include
   `user_stopped`, `hop_loop`, `hop_runaway`, `rate`, `duplicate`,
   `queue_full`, `wake_failed`), plus the main-minted `messageId`. The sending
   model sees this in its tool result, so it never reasons from a false
   belief that a peer heard it. **Consumption is a defined point, not socket
   receipt or enqueue:** the recipient sidecar acks a `messageId` only when
   the turn that carried it has passed the engine's durable-input callback
   (`onInputPersisted`, `src/app-runtime/AppSessionController.ts`; fired
   after the transcript write in `QueryEngine.ts:516`). Until then main
   keeps the message and its outcome stays `queued_*`. If the recipient's
   process exits with unacked messages, main redelivers them after the next
   `ready` of that row (the same deliver-after-ready path as step 5), and the
   sidecar dedups redelivery by `messageId` against ids it has already
   enqueued, so a crash between persistence and ack yields at most one
   transcript row. Main then records `consumedAt` and writes the
   metadata-only operational-log line (PEER-SESSIONS §10).

## 5. Per-plane change list (for the dispatch that builds it)

| plane | change |
|---|---|
| `app/shared/protocol.ts` | outbound: `HostRequestFrame`, `ActivityFrame`, `PeerNoticeFrame` in `ServerFramePayload`; inbound: `HostResultFrame` + `PeerDeliverFrame`; doc comments cite this file. No version bump (additive). |
| `app/supervisor/supervisor.ts` | decode `host.request` like any outbound frame; no routing change (identity by `record.sessionId`); three additive spawn-env keys `CATCODE_SIDECAR_NAME`, `CATCODE_SIDECAR_CREATED_BY` (id), `CATCODE_SIDECAR_CREATED_BY_NAME` beside `CATCODE_SIDECAR_CWD` (`:355-359`), threaded through the per-spawn `SpawnConfig` (`:138`). |
| `app/main/main.ts` / `mainDecisions.ts` | Electron-free handler: verb allowlist + schema + size/rate (HR1) + HR3 scoping + channel guards, calling `Host` methods; result forwarded through the existing `forward(sessionId, …)`; per-row presence from `activity`; a per-row copy of the last `model.set` / `effort.set` / `permission.setMode` forwarded, for `peer.create` replay; the message table (`messageId` → chain, recipient, `consumedAt`) that `replyTo` resolves against; the deliver-after-ready state machine (§4 step 5); the durable pending-notice and notify-when-idle stores (in-memory: they die with the window like everything else, SESSION-LIFETIME L1, and a pending subscription also expires when either row is reaped or after 12 h, the upstream precedent). |
| `app/host/host.ts`, `app/host/registry.ts`, new `app/host/peerNames.ts` | additive row fields `name`, `createdBy` (an `appSessionId`), `peerWakeBlocked` (boolean, default false, additive parse/merge like `forked`; survives close, park, restore and relaunch; disappears with the row on reap); the spawn path accepts `name`/`createdBy` and allocates `name` when a reused row lacks one; the churn rule (HR4); the name picker (PEER-SESSIONS §2). `SessionDescriptor` (`hostApi.ts:79`) gains `name` and `peerWakeBlocked` so the sidebar row and its menu render from state, not from a write-only toggle. |
| `app/sidecar/sidecarServer.ts` | request client (mint id, await result, timeout); inbound schemas + allowlist for `host.result` and `peer.deliver`; `request` → task-notification enqueue with origin `peer` (title generation on for an untitled session's creation prompt; creation prompt untagged, later messages wrapped with `id`); `notify` → held notices + `peer.notice` event + enqueue-at-next-turn + ack; `activity` on turn start/end and permission open/close; doctrine block from env incl. creator name. |
| `app/host/hostApi.ts`, `app/preload/preload.ts` | one host method + one fixed preload sender to set/clear a row's `peerWakeBlocked` from the sidebar row menu (HC3 pattern, `closeSession` precedent); renderer-facing only, no sidecar surface. |
| `app/shared/operationalLog.ts` | one new closed event kind for routed peer messages (metadata only). |
| `app/main/idleParkDriver.ts` | none. A wake through restore is already a spawn the driver sees. |
| `app/shared/limits.ts` | the six peer constants, values in PEER-SESSIONS §7. |
| engine (`src/`) | `MessageOrigin` kind `peer` (`src/types/message.ts:10`) plus the matching case in `toSDKMessageOrigin` (`src/utils/messages/mappers.ts:243`, `never` tripwire); regenerate `coreTypes.generated.ts`; re-sync `app/shared/sdk-types.snapshot.d.ts`. Engine battery applies to this row (CLAUDE.md §3). |

## 6. Tests owed before ratification of the build

- Boundary: `host.result` and `peer.deliver` accepted when valid, rejected on
  unknown key, wrong type, missing `requestId`, mismatched `requestId`.
- Main: unknown verb → typed error; verb args failing schema → typed error;
  HR3: a `peer.deliver` naming a row in another cwd → `session_not_found`;
  HR4: the 33rd live session via `peer.create` → the existing `session_limit`,
  and no refusal below it for any creator count or depth.
- Loop: a chain containing the recipient is refused; a chain over the cap is
  refused; two sessions replying to each other stop within the cap without
  prompt help (run against the real queue, not a stub: CLAUDE.md §8 rule 1).
- Delivery: `request` to a busy live recipient is read between tool calls;
  `notify` to an idle recipient starts NO turn (assert against the real
  boundary drain, which is exactly where the naive design started one) and is
  attached at the next turn from another cause; `request` to a parked row
  restores it and the prompt arrives after `ready`; a `request` racing a
  user-initiated restore is delivered, not answered `session_not_found`.
- Size/rate: an oversized `host.request` and a request flood are refused with
  typed errors at main.
- `peer.notifyWhenIdle`: on an idle row answers `already_idle` and subscribes
  nothing; on a running row that is then closed, fires `peer_gone`; on a
  running row that opens a permission prompt, fires `needs_user`.
- `replyTo`: a reply inherits the delivered chain; a forged or foreign
  `replyTo` yields a fresh chain and a log line, never a refusal.
- Creation: the created session has a title after its first turn; its
  opening prompt is untagged and a later `request` is tagged with `id`;
  the peer's model, effort and mode equal the creator's at creation.
- Notice dedup: a `peer.notice` followed by the consuming turn renders one
  row; a reload before consumption shows the notice; a reload after shows one
  row.
- Churn: create, park, create past 256 rows → `session_limit`, and the
  registry file stops growing.
- Loop without `replyTo`: two real peers answering each other with varying
  bodies and no `replyTo` stop within `MAX_PEER_HOPS`.
- Durability: kill the recipient just before and just after
  `onInputPersisted`; after restore the message arrives exactly once.
- `peer.create`: timeout before ready then retry with the same key → one
  peer; prompt send rejected after ready → `created_partial`, row kept.
- Inheritance: a resumed creator (model from transcript, no `model.set`) makes
  a peer on the same model; a creator restored after park makes a peer at the
  settings-default mode, not its pre-park mode.
- Naming: restoring a pre-field row allocates a name; `peerWakeBlocked`
  survives relaunch and is gone after reap.
- Presence: idle at ready; two pending prompts resolved out of order stay
  `needs_user` until both close.
- Classifier: `SendToPeer` relaying a denied action is evaluated in auto
  mode, not skipped.
- Rendering: a `peer` origin row renders as an injected-turn row with the
  sender label, never as a user bubble, and never appears in the staged-prompt
  strip (extend `transcriptProjector.test.ts:1271`).
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
  HR4: HC4 caps bound it to 32 live sessions and 8 spawns per 10 s, plus the
  registry ceiling of 256 rows (HR4's churn rule; without it park-and-create
  is unbounded); there is no tighter peer budget by operator ruling, so a
  prompt-injected model CAN fill the window with tabs up to those caps.
  Each spawn is a real, visible tab the operator sees appear, and every one
  is an ordinary session the operator can close. Accepted cost of R8.
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
- **A6 — a compromised sidecar floods main with requests or a 30 MiB one.**
  HR1's own size and rate bounds at the consumer; the channel's 32 MiB sanity
  bound was never a policy gate and is not relied on.

## 9. Ruling requested

**RULED 2026-09-03: approved and applied to `SECURITY-MINIMUM.md`.** The ask was:
amend the Addendum 2026-07-04 by replacing "the control plane
never adds an inbound frame type to the socket protocol" with "the control plane
adds inbound frame types only as results of sidecar-originated requests and
as main-stamped peer deliveries, each validated at the sidecar under HR5". That
sentence is the whole ruling; everything else in this document follows from it
or from decisions already on record.
