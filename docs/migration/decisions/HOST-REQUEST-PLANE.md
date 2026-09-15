# HOST-REQUEST-PLANE — the sidecar asks main to do something

**Status: RULED 2026-09-03 (operator approved the §9 amendment; SECURITY-MINIMUM
Addendum 2026-07-04 amended the same day). Implementation is NOT yet dispatched;
this document authorizes the design, not a build. v1 scope trimmed the same
evening; PEER-SESSIONS §0a lists the cuts, and cut mechanics below are marked
DEFERRED.** Branch `migration`. Companion to
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
| `peer.create` | in this order: allocate the name against the registry → spawn through the `createSessionInWorkspace` path (`host.ts:430`) with `name`, `createdBy` (id) and the creator's name in the child's spawn env → persist the row → await that row's `ready` → deliver the creation prompt as a `request` with `generateTitle` on and the text untagged (PEER-SESSIONS §5). Model and effort travel in the spawn env (`CATCODE_SIDECAR_MODEL`, `CATCODE_SIDECAR_EFFORT`, from the request args, which the requesting sidecar filled from its own state); permission mode is neither carried nor inherited (PEER-SESSIONS §0a). No idempotency cache: the sidecar client never auto-retries this verb, and a timeout result tells the model to check `ListPeers` before trying again, because the row is named and visible from the moment it is persisted (`host.ts:484` order). A prompt send rejected after `ready` (`supervisor.send`, `supervisor.ts:459`) keeps the row, since it is a real session the operator can see, and the result names the peer and the failed step so the caller can `SendToPeer` the prompt itself | the new row's name + appSessionId, plus a failed step when one failed |
| `peer.deliver` | resolve name → row; 🔁 check `expectCreatorId` against that row when the arg is present (§4 step 1a); live: forward `peer.deliver` inbound to that sidecar (the wake-block flag is irrelevant to a live row); parked/closed: refuse if the row's `peerWakeBlocked` is set (`refused:user_stopped`), else main's own restore-then-deliver (§4 step 5); mint `messageId` | outcome enum (§4) + `messageId` |
| `peer.ack` | release the pending message the RECIPIENT is acking and write its metadata-only operational-log line; the id is looked up in that session's own pending list, so a forged id can only drop the acking session's own message | the `messageId` |

**🔁 AMENDED 2026-09-03 during the build: four verbs, not three.** `peer.ack` was
added because §4 step 6's "ack = enqueued" is IN v1 scope (PEER-SESSIONS §0a keeps
it; only the `onInputPersisted` ack and its redelivery dedup were cut) and the
original text ruled the behaviour without naming a transport. The alternatives
were worse: a third outbound frame kind for one boolean is not on §5's change
list, and a third INBOUND kind at the sidecar is forbidden by the amended
SECURITY-MINIMUM addendum, which permits exactly `host.result` and `peer.deliver`.
A verb on the existing `host.request` frame adds neither a frame kind nor an
inbound surface, so the security baseline is untouched; only this closed
allowlist widens. `peer.ack` is not model-facing: no tool reaches it, and its
argument is an id main itself minted.

**🔁 AMENDED 2026-09-06 (operator ruling 11): `peer.deliver` gains one optional
arg, `expectCreatorId`.** The audit's F17
(`docs/prompts/2026-09-05-peer-sessions-instruction-surface-audit.md` §3.8)
showed the creator link can be routed to the wrong session. A peer learns its
creator's NAME once, at spawn (`CATCODE_SIDECAR_CREATED_BY_NAME`), names are
unique only among CURRENT registry rows and are released when a row is reaped
(`app/host/host.ts` `allocatePeerName`), reaping happens whenever the registry
passes `MAX_REGISTRY_SESSIONS` (256) and removes closed rows oldest-first
(`app/host/registry.ts` `enforceBound` / `isReapableForBound`), and a send
resolves `to` by name against current rows. So: Alex creates Bear, Alex closes,
the reap takes Alex's row, the pool reissues "Alex", and Bear's next message to
its creator reaches a stranger. The operator's registry held 224 rows on
2026-09-04, so the bound is reachable. The ruling: "Fix creator name reuse by
routing through its stable ID. If the original creator is gone, report that
clearly. Never silently redirect to whoever now owns its name. Keep names as the
conversational interface."

What that costs the plane, and why it does not widen it. The arg is the
`appSessionId` the SENDING sidecar remembers as its creator's, read from
`CATCODE_SIDECAR_CREATED_BY` in its own spawn env, which only main writes and
which is the same trust class as the cwd. It is sent only when the trimmed `to`
matches the remembered creator name under main's own case-insensitive
normalisation, so every other send crosses unchanged. HR2 is untouched: this is
not the sender's identity, which is still the connection. HC1/HR3 are untouched:
the model never sees an id, no tool argument reaches this field, and the NAME is
still what selects the row. And it can only narrow, never widen: the check runs
after resolution and its only effect is a refusal. `SendToPeer`'s `to` argument
does not change.

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
1a. **🔁 ADDED 2026-09-06 (ruling 11, F17).** If the request carries
   `expectCreatorId` and the row step 1 resolved does not have that
   `appSessionId`, main refuses `refused:creator_reissued` and delivers nothing.
   It does not redirect, does not fall back to the row the id names, and does not
   look for the creator anywhere else: a name released by a reap and handed out
   again means the remembered creator is gone, and delivering here would put one
   session's private context into a stranger's transcript. The refusal is typed
   and logged like every other (step 3), and it runs BEFORE the chain, the token
   bucket and the duplicate window, so a sender that met a reissued name keeps
   the allowance it needs for the conversations it can still have. Absent arg =
   this step does nothing, and the path is the one that shipped.

   The name-not-found case needs nothing here. A creator whose row is gone
   entirely fails step 1 and is already `session_not_found`; only the SENDER
   knows it was addressing its creator, so only the sender can word that
   specially, which `sendToPeerTool.ts` `describeError` does. Main gains one
   refusal reason, not two.
2. Main builds the inbound `peer.deliver` frame: `{ from: <requester name>,
   fromSessionId, messageId, text }`. 🔁 The frame carried a `hops` array until
   2026-09-03; it was required, validated at the sidecar and read by nothing, so
   the chain is now entirely main-side and the inbound surface is that much
   smaller (HR5). **The sidecar
   never sends a chain, and there is no `replyTo`:** main keeps an active request
   path per ordered pair for `PEER_CHAIN_WINDOW_MS` (PEER-SESSIONS §7). A send
   inherits the longest non-expired path delivered to the requester, with
   refusal paths visible only to their own pair. Sending to a new peer pushes
   the requester onto the path. Sending to the path's last entry returns to the
   caller and pops that entry. Every other send pushes the requester, including
   a send to an earlier participant. A revisit is allowed until the resulting
   path exceeds `MAX_PEER_HOPS`, then it is `hop_loop`; a path through distinct
   participants is not capped here. A separate per-pair count uses the same cap,
   so repeated two-party replies still stop as `hop_runaway` even while the
   active path unwinds. A self-send is a loop of one. Main derives both values,
   so a compromised sidecar cannot shorten either.

   **🔁 AMENDED AGAIN 2026-09-03: how the chain is KEYED, which the first
   amendment did not settle.** The chain was keyed by recipient alone, so a
   session had ONE chain shared across every conversation it was in. Two
   exploits followed, both demonstrated by execution rather than argued: any
   third peer sending one message reset an ongoing pair's hop counter, so
   `hop_runaway` was escapable on demand and forever; and a refused hop wrote
   its chain onto an uninvolved session's key, refusing that session's next
   send for the whole window, which a prompt-injected peer triggers with one
   message it never needs delivered.

   Strict ordered-pair keying was proposed as the fix and is WRONG, recorded
   here because it is the obvious repair and it silently removes ring
   detection. In a ring `A→B→C→A` no pair is ever bidirectional, so the record
   for the direction being sent is never populated, every hop inherits an empty
   chain, `hops` stays length one forever, and BOTH guards become unreachable
   — leaving only the token bucket, which is a rate limit and not a stop.

   What ships: records are kept per `(recipient, sender)` pair, and a send
   inherits the LONGEST non-expired chain among the records delivering to the
   requester, while a REFUSAL record is inherited only by its own pair. That
   split is the whole point. Cross-pair inheritance is what makes a ring
   visible; ambient cross-pair WRITES are what made the two exploits possible.
   A third party's short chain cannot beat a live long one because inheritance
   is longest rather than most recent, and a refusal is evidence about one pair
   only. Accepted cost: a ring is refused at the same edge on every lap rather
   than being killed outright, because the refusing record is pair-local.
   Killing it outright requires refusals to be visible across pairs, which is
   the second exploit. A throttled ring was taken over an uninvolved session
   being silenced by a message nobody delivered.

   **🔁 AMENDED 2026-09-03 during the build.** The original sentence read
   "rejects a send whose chain already contains the recipient", with no
   last-entry exception, and that cannot hold together with the rest of this
   step. A chain delivered to A by B always ENDS with B, so under the original
   test A's reply to B is refused as a loop, every reply is, on the first hop,
   and `MAX_PEER_HOPS` becomes unreachable dead code while §6 owes a test in
   which two sessions answering each other stop AT that cap. Two weaker repairs
   were tried against four traffic shapes and both failed: excluding the
   chain's last entry by index refuses a two-party exchange at hop 4 (by then A
   appears twice and the earlier occurrence trips the test), and refusing only
   when a third participant is present kills the feature's own workflow, since
   it refuses `A→B, B→C, C→B` — the report-back R2 is built on and the ladder
   R8 permits — and bounds a two-party sub-exchange below the root at three
   messages.

   **🔁 AMENDED 2026-09-11.** Allowing an immediate reply but appending it to the
   path handled `A→B→C→B` and then incorrectly refused the ordinary final
   report `B→A`. A reply now pops the caller, so `A→B→C→B→A` unwinds. A
   single `A→B→C→A` circuit is also allowed: revisiting a participant proves a
   circuit, not an infinite loop. Repeated circulation grows the active path
   until the existing cap mechanically refuses it as `hop_loop`. The separate
   pair count continues to bound repeated two-party replies.

   A refused hop still advances the pair's count and record. Without that, the
   two directions drift by one, so the peer under the cap keeps sending and the
   one over it keeps being refused, leaking one message every other attempt.
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
4a. **PARTLY DEFERRED. 🔁 Read this before filing `activity` as out of scope:**
   the `notify` kind and its held-notice machinery were cut (PEER-SESSIONS
   §0a) and the sketch below is kept only in case a turn-free kind is ever
   wanted, but the **`activity` frame described near the end of this step
   SURVIVED the cut and is built** — §0a keeps it in, and presence in
   `peers.list` depends on it. Everything about `notify` below is DEFERRED.** Recipient live, `kind:
   'notify'`: **the engine queue cannot carry a turn-free message.** The sidecar's boundary drains ignore priority and start
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
   without interpreting engine event vocabulary, the
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
   `session_not_found`, which HR3 reserves for a row the caller may not name.
6. The `host.result` reports what happened: `queued_live`, `queued_wake`,
   `refused:<reason>` (reasons include
   `user_stopped`, `hop_loop`, `hop_runaway`, `rate`, `duplicate`,
   `queue_full`, `wake_failed`, 🔁 `creator_reissued` (step 1a, ADDED
   2026-09-06), and 🔁 `delivery_failed`, ADDED 2026-09-03
   during the build: the recipient was already AWAKE and the hand-off to its
   process failed anyway, which `wake_failed` misreported as a peer that could
   not be brought back), plus the main-minted `messageId`. The sending
   model sees this in its tool result, so it never reasons from a false
   belief that a peer heard it. **Ack = consumed.** A busy recipient acks when
   the engine takes the queued command at a tool boundary; an idle recipient
   acks from `onInputPersisted`. Main holds the message until then and
   redelivers it after the recipient's next `ready` if the process exits
   unacked. The recipient recognises consumed `messageId` values from its
   transcript, suppresses a duplicate model delivery, and re-acks so main can
   release its copy. Transcript compaction or a crash before the consumed row
   reaches disk can degrade to one duplicate. On ack main writes the
   metadata-only operational-log line (PEER-SESSIONS §10) and forgets the
   message.

## 5. Per-plane change list (for the dispatch that builds it)

| plane | change |
|---|---|
| `app/shared/protocol.ts` | outbound: `HostRequestFrame`, `ActivityFrame` in `ServerFramePayload` (`activity` is `sticky` in `FRAME_RETENTION`, `replayBuffer.ts:146`); inbound: `HostResultFrame` + `PeerDeliverFrame` (🔁 built as
`HostResultMessage` / `PeerDeliverMessage`, which is the more correct name:
they are `SidecarClientMessage` variants, not frames, and the envelope is
added by `supervisor.send`); doc comments cite this file. No version bump (additive). |
| `app/supervisor/supervisor.ts` | decode `host.request` like any outbound frame; no routing change (identity by `record.sessionId`); five additive spawn-env keys `CATCODE_SIDECAR_NAME`, `CATCODE_SIDECAR_CREATED_BY` (id), `CATCODE_SIDECAR_CREATED_BY_NAME`, `CATCODE_SIDECAR_MODEL`, `CATCODE_SIDECAR_EFFORT` beside `CATCODE_SIDECAR_CWD` (`:355-359`), threaded through the per-spawn `SpawnConfig` (`:138`). |
| `app/main/main.ts` / `mainDecisions.ts` | Electron-free handler: verb allowlist + schema + size/rate (HR1) + HR3 scoping + channel guards, calling `Host` methods; result forwarded through the existing `forward(sessionId, …)`; per-row presence from `activity`; per-pair last chain inside the window; the pending store (messages not yet acked, delivered after the row's next `ready`); the deliver-after-ready state machine (§4 step 5). All in-memory: they die with the window like everything else (SESSION-LIFETIME L1) and are cleared on reap. |
| `app/host/host.ts`, `app/host/registry.ts`, new `app/host/peerNames.ts` | additive row fields `name`, `createdBy` (an `appSessionId`), `peerWakeBlocked` (boolean, default false, additive parse/merge like `forked`; survives close, park, restore and relaunch; disappears with the row on reap); the spawn path accepts `name`/`createdBy` and allocates `name` when a reused row lacks one; the churn rule (HR4); the name picker (PEER-SESSIONS §2). `SessionDescriptor` (`hostApi.ts:79`) gains `name` and `peerWakeBlocked` so the sidebar row and its menu render from state, not from a write-only toggle. |
| `app/sidecar/sidecarServer.ts` | request client (mint id, await result, timeout); inbound schemas + allowlist for `host.result` and `peer.deliver`; `peer.deliver` → task-notification enqueue with origin `peer`, then ack (title generation on for an untitled session's creation prompt; creation prompt untagged, later messages wrapped); `activity` at ready, on turn start/end and permission open/close; doctrine block from env incl. creator name; `CATCODE_SIDECAR_MODEL` / `CATCODE_SIDECAR_EFFORT` applied at boot beside `resumedModel` (`sessionController.ts:231`). |
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
- Delivery: a message to a busy live recipient is read between tool calls;
  to an idle recipient it starts one turn; to a parked row it
  restores it and the prompt arrives after `ready`; a `request` racing a
  user-initiated restore is delivered, not answered `session_not_found`.
- Size/rate: an oversized `host.request` and a request flood are refused with
  typed errors at main.
- Creation: the created session has a title after its first turn; its
  opening prompt is untagged and a later `request` is tagged with `id`;
  the peer's model, effort and mode equal the creator's at creation.
- Churn: create, park, create past 256 rows → `session_limit`, and the
  registry file stops growing.
- Loop: two real peers answering each other with varying bodies stop within
  `MAX_PEER_HOPS` with no help from the model.
- Durability: kill the recipient before it acks; after restore the message
  arrives.
- `peer.create`: prompt send rejected after ready → result names the failed
  step, row kept.
- Inheritance: a resumed creator (model from transcript, no `model.set`) makes
  a peer on the same model; every created peer starts at the settings-default
  permission mode.
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
