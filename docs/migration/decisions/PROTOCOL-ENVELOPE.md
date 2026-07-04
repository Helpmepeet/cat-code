# F3 — Protocol envelope: is the shipped v1 sufficient for Phase-3 multiplexing?

**Status: AUDITED + DECIDED 2026-07-03 (Phase-3 pre-work, parallel to Phases 1–2).**
⚠️ **Rescope:** the original F3 brief ("design the session-addressed envelope; it exists
nowhere") is **stale** — P1-0 shipped the envelope. `app/shared/protocol.ts:39-124` defines
`PROTOCOL_VERSION = 1` and a per-frame `sessionId: SessionId` on **every** frame type in both
directions (`ClientFrame:59-63`, `ReadyFrame:74-79`, `EventFrame:87-92`, `PongFrame:98-103`,
`ErrorFrame:109-122`), explicitly reserved for Phase-3 N-process routing (`:12-15,42-46`). This
document is therefore an **audit with a verdict**: what of the envelope is already load-bearing,
what is a dead slot, how the edges behave (unknown session, dead session, version mismatch,
attach/detach), and the additions Phase 3 must make. It deliberately does **not** redesign
anything; every addition below is additive under `PROTOCOL_VERSION = 1`. All behavior claims
were re-verified against the working tree 2026-07-03 (source wins over this doc).

**Overall verdict: SUFFICIENT for Phase-3 multiplexing, with a short list of additive gaps
(§6).** The
addressing spine — mint an id, key the process map with it, stamp it on every frame, self-check
it at the trust boundary — is real, running code, not a reserved field. Nothing requires a
version bump or a frame-shape change.

| # | Question | Verdict (as built) | Phase-3 action |
|---|---|---|---|
| **E-1** | Does the supervisor actually route by `sessionId`? | **Inbound: YES — live code.** `send(sessionId, message)` looks up `Map<SessionId, SidecarRecord>` and writes to that session's socket (`app/supervisor/supervisor.ts:81,207-218`); main passes the renderer-supplied id straight through (`app/main/main.ts:209-248,258-274`). **Outbound: identity is derived from the connection** — the supervisor stamps `record.sessionId` on the event it emits (`:308-312`) and never reads the frame's own slot. | Keep trust-by-connection (correct). Add the cheap invariant check: drop + log an outbound frame whose inner `sessionId` ≠ `record.sessionId` (§2). |
| **E-2** | Frame for an unknown/dead session? | **Two different behaviors.** At the sidecar: a mis-addressed frame is rejected fail-closed with a `bad_request` error frame (`app/sidecar/sidecarServer.ts:198-209`). At the supervisor/main: `send()` **throws one undifferentiated error** for every failure flavor — no record, record still spawning (no socket yet), disconnected, exited (`supervisor.ts:217-221`); main catches and logs to stderr — the renderer gets **nothing** (`main.ts:258-274`, a silent drop). | Add **typed outcomes** to the `ErrorFrame` code union — terminal `session_not_found` plus retryable `session_not_ready` / `session_disconnected`, mapped from the supervisor record's status — and have main synthesize the right one back to the renderer on a failed forward (§3). Additive. |
| **E-3** | N-sidecar attach/detach? | Spawn/kill/restart per session exist and are N-shaped (`supervisor.ts:128,221,231`); per-session status/exit events exist (`:75-78`); the replay buffer is already per-session with a ready-head + bounded ring (`app/main/replayBuffer.ts:33-53`). The **control plane** (create-with-cwd/list/close/restore) is direct host-API calls from main — nothing on the wire, per DR-4. | Fine for v1 (window = host client #1). Registry/host API owns the control surface (`REGISTRY.md` §6); wire frames only when a remote client exists (DR-4 watch-item). Add per-session buffer eviction on `killSession` (§4). |
| **E-4** | Version negotiation on `protocolVersion` mismatch? | **None — and it fails closed at exactly one point.** The sidecar rejects any inbound frame whose `protocolVersion !== 1` with `bad_request`, per frame, connection kept (`sidecarServer.ts:182-195`). Outbound frames are stamped (`:120-124,253-257`) but **no consumer checks them** — not the supervisor, not main, not the renderer (grep: zero non-test `protocolVersion` reads in `app/main`/`app/renderer`). | Acceptable for v1: sidecar + app ship from one repo in lockstep, and inbound (the trust boundary) is covered. Phase 3 adds a check at attach — but a **version-number check alone is insufficient** for additive-field skew: an old sidecar still announces `protocolVersion: 1` while lacking `engineSessionId`. The attach check must validate the ready frame's **schema** — the host-required fields are present — and mark the session `failed` otherwise (§5). Full negotiation is v2-remote territory — explicitly deferred. |
| **E-5** | Can the host learn the **engine** session id? | **NO — the one genuinely dead-end gap.** `ReadyFrame.payload` is the engine-owned `AppReadyPayload` (`src/web/appSessionProtocol.ts:157-165`) — no session identifier of either kind. The sidecar receives `CATCODE_SIDECAR_SESSION_ID` (`app/sidecar/index.ts:32-44`) but never bridges it to the engine's self-minted `STATE.sessionId`, and nothing reports the engine id back. Restore-by-resume is unimplementable without this (`REGISTRY.md` §2). | **Add `engineSessionId: string` to `ReadyFrame`** (an app-owned type — `app/shared/protocol.ts:74-79`), filled by the sidecar after `init()` from the engine's `getSessionId()`. Do NOT widen the engine's `AppReadyPayload` (PERMISSION-BOUNDARY R6 precedent). Additive; smallest item on this list; unblocks the registry. |
| **E-6** | Is the renderer N-session ready at the envelope level? | Partially. Every frame it receives carries `sessionId`, and the bridge API takes `sessionId` on every call (`app/shared/protocol.ts:136-160`) — but today's renderer state keys nothing by it (single-session assumption baked into P1-x state modules). | Phase-3 shell work (W2): key renderer stores by `frame.sessionId`. No protocol change needed — the slot already delivers everything required. |
| **E-7** | Anything on the wire the envelope *forgot*? | **Nothing structural; two already-decided vocabulary additions are in flight.** Framing is length-prefixed JSON with directional caps (inbound `MAX_FRAME_BYTES` at the sidecar, outbound `MAX_OUTBOUND_FRAME_BYTES` at the supervisor decoder — `supervisor.ts:162-165`), JSON-safety + secret-guard on the outbound path, allowlist vocabulary inbound — all orthogonal to addressing. But `PERMISSION-BOUNDARY.md` has **already decided** two new frame kinds this audit must not present as "nothing coming": inbound `permission.setMode` (C2) and outbound `permission.context` snapshot (C3), both spec'd for P2-4. Both are additive under v1 and per-session-addressed like everything else. | None for Phase-3 multiplexing itself; P2-4 lands C2/C3 per PERMISSION-BOUNDARY §3–§4 (sidecar-local allowlist + `checkStrictKeys` entries — the same additive pattern this audit blesses). |

---

## 1. What is already load-bearing (do not rebuild, do not "simplify")

The full inbound address path executes on every renderer action **today**, with one sidecar:
renderer supplies `sessionId` per bridge call → preload forwards on fixed channels → main
shape-checks and calls `forward(sessionId, message)` (`main.ts:209-248`) → supervisor routes by
registry map to the owning socket (`supervisor.ts:207-218`) → the sidecar verifies the frame is
addressed to *it* and otherwise rejects (`sidecarServer.ts:198-209`). Adding the Nth session
changes **zero** lines of this path — that was the point of PHASE0-REVIEW F3, and it held.
Two implications worth pinning so later phases respect them:

- **The sidecar's self-check is the security half of routing.** Even a confused/compromised
  supervisor cannot make session A's sidecar act on a frame addressed to session B; and because
  permission pendings are per-controller instance state (P0-4 probe row 2), a response routed to
  the wrong sidecar dies at that sidecar's pending lookup (T5a), not in engine state.
- **Outbound identity is the connection, not the payload** (`:308-312`). This is the right trust
  model — the supervisor knows which socket a frame arrived on; a frame cannot claim to be from
  another session. The inner `sessionId` slot on outbound frames is today *redundant with*
  connection identity, which is exactly why §2's invariant check is cheap.

## 2. Gap: the outbound slot is stamped but unverified (tiny hardening)

The sidecar stamps its own id on every outbound frame (`sidecarServer.ts:120-124,253-257`), the
supervisor emits with `record.sessionId` — and nobody compares the two. Today they cannot
diverge (one sidecar, self-stamped). In Phase 3 the renderer starts **keying state by the inner
`frame.sessionId`** (E-6) while delivery correctness rides on `record.sessionId` — a buggy
sidecar (or a future serializer refactor) stamping the wrong id would then corrupt renderer
state for a *different* session while every transport-layer check passes. One-line invariant at
the supervisor's decode loop (`supervisor.ts:300-314`): if `frame.sessionId !== record.sessionId`,
drop the frame and log. Not a security boundary (the sidecar is trusted output), a
bug-containment tripwire — same spirit as the F10 strict-keys check. **Phase-3 item, not done
here** (implementation of routing hardening is Phase-3 scope per this track's charter).

## 3. Gap: dead/unknown-session sends vanish silently

`forward()` catching the supervisor's throw and writing to stderr (`main.ts:258-274`) was the
right P1 call (the ready gate makes it unreachable in the one-session world). In Phase 3 it
becomes reachable in normal use: user submits into a tab whose sidecar just crashed
(`status: 'exited'`/`'disconnected'`, `supervisor.ts:56-62,320-331`). The renderer must be able
to distinguish "session is dead, offer restart" from "still starting, retry shortly" from
"frame lost, nothing happened" — and today `send()` cannot tell it, because one throw covers
all of: no record at all, record present but socket not yet connected (`spawning`), and
`disconnected`/`exited` (`supervisor.ts:217-221`). Decision: extend the `ErrorFrame` code union
(`app/shared/protocol.ts:114-119`) with **three typed outcomes**, chosen by main from the
supervisor record's status at failure time:

- `session_not_found` — no record in the map. Terminal (`retryable:false`); the id is bogus or
  the session was closed — the renderer drops the tab or offers registry restore.
- `session_not_ready` — record exists, status `spawning`/not yet connected. Retryable
  (`retryable:true`); the renderer queues or asks the user to retry — the ready frame will flip
  status shortly (or exit will).
- `session_disconnected` — record exists, status `disconnected`/`exited`. Retryable only via
  restart (`retryable:false` on the frame itself); the renderer offers the restart affordance
  (`restartSession`, `supervisor.ts:252`).

Main synthesizes `{kind:'error', sessionId, code, retryable}` back through the normal delivery
path when `forward()` fails; distinguishing requires either a typed supervisor error or a
`status(sessionId)` lookup — either is fine, the wire contract is the three codes. Note these
are **transport-plane** outcomes on the frame path, distinct from the **control-plane**
`HostErrorCode` (`REGISTRY.md` §6.1) which answers host-API calls — the same underlying state
(dead session) surfaces as `session_disconnected` on a frame send and `session_not_found` on a
`restoreSession` of a reaped row; do not merge the two unions. Additive (new enum members on an
app-owned type); the sidecar never emits them (it cannot know about other sessions); no engine
change.

## 4. Attach/detach mechanics under N (what exists vs what Phase 3 wires)

Per-session lifecycle exists end to end: spawn allocates a per-session socket under the
`sun_path`-safe dir (`supervisor.ts:99-107,136-146`), connect-when-ready polls and fails loudly
(F12, `:267-289`), `exit`/`status` events are per-session and stale-record-guarded (F11,
`:179-190,199-204`), kill/restart are per-session (`:221-243`), and `main`'s replay machinery
buffers **per session** with a permanent ready-head (`replayBuffer.ts:33-53`) so a late renderer
can catch up on every live session, not just the newest. Verified N-shaped; the gaps are
housekeeping, not architecture:

- `killSession` removes the supervisor record but nothing evicts that session's replay-buffer
  entry — after Phase 3's session churn, a reload would replay ready-frames of dead sessions.
  Add per-session eviction (`FrameReplayBuffer` needs a `drop(sessionId)`; the gate's `reset()`
  today only covers whole-window teardown, `attachmentGate.ts:60-63`, `main.ts:406`).
- `AttachmentGate.onRendererReady` replays **all** sessions' buffers (`attachmentGate.ts:48-52`)
  — correct for restore-everything, but Phase-3 shell should confirm ordering (per-session ready
  head first is already guaranteed by `snapshot()`).
- Spawn currently takes no per-session config; the control plane's `create(cwd, resume…)` rides
  the host API and env plumbing, not new wire frames (`REGISTRY.md` §7.2).

## 5. Version posture (decided)

- **Inbound (trust boundary): already fail-closed per frame** — wrong/missing `protocolVersion`
  → `bad_request`, frame dropped, connection survives (`sidecarServer.ts:182-195`). Correct and
  sufficient; per-frame (rather than per-connection) rejection is fine because the only writer is
  our own supervisor.
- **Attach handshake: add the missing check — and it is a SCHEMA check, not a version check.**
  The supervisor should validate the ready frame when a sidecar attaches and mark the session
  `failed` on failure — this is the moment a packaged-app/sidecar skew (Phase-5 auto-update
  replacing one but not the other) would surface, and today it would pass silently into
  undefined behavior. Crucially, comparing `protocolVersion === 1` catches only *breaking*
  reshapes; this program's changes are deliberately **additive under v1** (§6), so the realistic
  skew — an old sidecar that predates `engineSessionId` — announces a perfectly valid
  `protocolVersion: 1` and sails through a number comparison, then breaks registry restore
  downstream with a missing field. The attach check therefore asserts the ready frame carries
  every **host-required field** (today: well-formed `sessionId` matching the record,
  `engineSessionId` once E-5 lands) in addition to the version number. Fail closed, no
  negotiation.
- **Negotiation: explicitly deferred.** Version *negotiation* buys nothing while renderer, main,
  supervisor, and sidecar ship from one commit and speak over a local socket. It becomes a real
  concern exactly when a client can be older than the host (detached daemon / phone / remote) —
  a v2 concern by `SESSION-LIFETIME.md` §6. Bump `PROTOCOL_VERSION` only on a breaking frame
  reshape; everything in this audit is additive under v1.

## 6. What Phase 3 must ADD — consolidated (all additive, no version bump)

| Item | Where | Size | Unblocks |
|---|---|---|---|
| `ReadyFrame.engineSessionId` (sidecar fills post-`init()`) | `app/shared/protocol.ts:74-79`, `app/sidecar/sidecarServer.ts:120-124` | XS | Registry restore (R6) — **do first** |
| Typed forward-failure outcomes: `session_not_found` / `session_not_ready` / `session_disconnected` synthesized by main (§3) | `protocol.ts:114-119`, `main.ts:258-274`, `supervisor.ts:217-221` | S | Dead-tab UX; renderer can trust silence = nothing happened |
| Outbound `frame.sessionId === record.sessionId` tripwire | `supervisor.ts:300-314` | XS | N-session renderer state integrity |
| Ready-frame **schema** check at attach (host-required fields incl. `engineSessionId`, not just version — §5) | supervisor attach path | XS | Phase-5 update-skew containment |
| Per-session replay-buffer eviction on kill | `replayBuffer.ts` + gate + `killSession` | S | Session churn without ghost replays |
| Renderer state keyed by `frame.sessionId` | renderer stores (W2 shell work) | M | Actual multiplexed UI |
| Spawn-config (cwd, resume id) via host API + env | supervisor/sidecar/`REGISTRY.md` §7.2 | S | Registry restore; retires `P1_1_CWD` |

> **Addendum 2026-07-05 (post-host-plane-review):** one further additive-under-v1 item landed
> with its own owning decision — `EventFrame.replay?: true` + the
> `catcode.history-truncated` boundary id, the restored-history replay-on-attach
> (→ `decisions/RESTORE-HISTORY.md`, F2 of `reviews/2026-07-05-p3-host-plane-review.md`).
> Same pattern this audit blesses in E-7: app-owned vocabulary, no version bump, no new
> inbound frame types.

## 7. Rejected

- **R1 — Redesign/bump the envelope for Phase 3.** Nothing found requires a breaking change; the
  v1 shape (version + address + payload, per frame, both directions) is exactly the Phase-3
  requirement. Re-litigating it would be the anti-pattern DR-1 warned about in reverse.
- **R2 — Widen engine types (`AppReadyPayload`) to carry the engine session id.** Engine-owned,
  WS-server-shared type; the app-owned `ReadyFrame` is the sanctioned change site
  (PERMISSION-BOUNDARY R5/R6 precedent).
- **R3 — Supervisor-side session-id rewriting on outbound frames** (overwrite the inner slot
  with `record.sessionId` instead of §2's drop-and-log). Rewriting masks the bug it exists to
  catch; a mismatch means code is wrong somewhere — surface it.
- **R4 — Control-plane frames on the wire now.** No second client exists; frames minted without
  a consumer would be designed blind. The host API is the durable seam (DR-4); wire encoding can
  be added under it later without touching engine or sidecar vocabulary.
- **R5 — Version negotiation handshake.** Deferred with rationale in §5.

## 8. Adversarial self-review

- **A1 — Compromised renderer forges another tab's `sessionId`.** Pre-Phase-3 threat model
  already covers the payload (allowlist + sidecar validation); the *address* is not a
  capability: the worst a forged id does is deliver an allowlisted, schema-valid message to a
  session the same user owns in the same window — the same power the UI gives them. Permission
  responses stay safe cross-session because pendings are per-controller (T5a; P0-4 row 2).
- **A2 — Why trust the sidecar's self-check instead of centralizing at the supervisor?** Both
  exist for different failure classes: the supervisor map prevents *misdelivery*; the sidecar
  self-check catches *supervisor bugs* (and any future transport that bypasses the supervisor).
  Defense in depth at ~5 lines each; keep both.
- **A3 — Does the silent-drop fix (E-2/§3) leak information?** `session_not_found` reveals only
  that an id the renderer itself supplied has no live process — the renderer already learns this
  via status events; no new information class crosses the boundary.
- **A4 — Per-frame version stamping is wasteful.** ~24 bytes/frame against multi-KB SDK events;
  and per-frame stamping is what makes the sidecar's per-frame fail-closed check possible at all
  (there is no connection-establishment handshake to hang it on — the ready frame *is* data).
  Cost accepted knowingly.
- **A5 — Is the audit itself overclaiming? What was NOT verified live?** Everything cited was
  read + line-verified in source, and the routing path is exercised by `bun test app/` (P1-4:
  122 pass) — but **no two-sidecar process has ever run under one supervisor** (P1 runs one).
  The claims "adding the Nth session changes zero lines" and "replay is N-ready" are
  code-shape facts, not runtime-proven ones. Phase 3's first session should be a two-sidecar
  smoke of exactly this path before UI work stacks on it.

## 9. Carry-forwards

- DR-4's design half is now **executed on paper**: the typed control-plane contract lives in
  `REGISTRY.md` §6.1 and its trust zone in `SECURITY-MINIMUM.md` (Addendum 2026-07-04, T8 +
  HC1–HC4). What remains is the Phase-3 *implementation* — deliberately API-not-wire; wire
  encoding only when a remote client exists.
- The renderer's single-session assumptions (E-6) are Phase-3 W2 work; nothing in the protocol
  blocks them.
- `app/scripts/f2-attach-smoke.ts` exists for the attach path; extend (don't duplicate) it for
  the two-sidecar smoke in §8-A5.
