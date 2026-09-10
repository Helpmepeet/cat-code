/**
 * IPC boundary limits (SECURITY-MINIMUM §2 R4 / T7, review findings F3/F4).
 *
 * Two DIRECTIONS with different trust and therefore different caps:
 *
 *  - INBOUND (renderer → sidecar) is hostile: a compromised renderer can flood
 *    or oversize frames. `MAX_FRAME_BYTES` bounds it (T7). The prompt cap is
 *    expressed in BYTES (not JS chars) so it is consistent with the frame cap —
 *    a multibyte prompt cannot advertise a size the frame cannot carry (F4).
 *
 *  - OUTBOUND (sidecar → supervisor/renderer) is TRUSTED engine output. A raw
 *    SDK event (a large tool result, a base64 image block) can legitimately
 *    exceed 128 KiB — dropping it would break the raw-fidelity guarantee this
 *    transport was chosen for (F3). It gets its own, much larger cap that exists
 *    only as a sanity bound against a runaway, never to reject normal output.
 */

/** Max serialized INBOUND frame size (hostile renderer traffic). */
export const MAX_FRAME_BYTES = 128 * 1024

/**
 * Max serialized OUTBOUND frame size (trusted engine output). Large enough to
 * carry base64 images and big tool results; a sanity bound, not a policy gate.
 */
export const MAX_OUTBOUND_FRAME_BYTES = 32 * 1024 * 1024

/**
 * Largest generated-image file the sidecar will read back for an inline preview.
 * Base64 expansion keeps this below the outbound frame sanity bound.
 */
export const MAX_GENERATED_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024

/** Sliding-window rate cap: max inbound frames per window (T7). */
export const MAX_FRAMES_PER_WINDOW = 120

/**
 * How much of `MAX_FRAMES_PER_WINDOW` the DIAGNOSTICS class may occupy, leaving
 * the remainder always available to control traffic (a submit, a permission
 * response). A sub-cap INSIDE the total, never a second budget beside it: the
 * total inbound ceiling stays 120, so T7's flood surface does not move.
 * See `docs/migration/decisions/IPC-RATE-BUDGET.md`.
 */
export const MAX_DIAGNOSTIC_FRAMES_PER_WINDOW = 80

/** Rate-limit window length in milliseconds. */
export const RATE_WINDOW_MS = 1_000

/**
 * Max prompt size accepted by `app.submit`, in UTF-8 BYTES. Kept well under
 * MAX_FRAME_BYTES so a valid prompt always fits one inbound frame (F4). Measured
 * in bytes, not JS chars, so multibyte input cannot exceed the frame cap.
 */
export const MAX_PROMPT_BYTES = 96 * 1024

/**
 * Max prompts that may be waiting for the RUNNING turn at once (T7).
 *
 * A submit arriving mid-turn is handed to the engine's command queue instead of
 * being refused, so the per-frame and per-window caps above no longer bound what
 * ACCUMULATES: they bound arrival rate, and the refusal used to bound depth. A
 * flooding renderer could otherwise pile unbounded prompt text into a queue the
 * next tool round injects into the turn's context wholesale. This is the depth
 * bound. Well above anything a person types during one response (the terminal's
 * own queue is unbounded because its only writer is a keyboard), and combined
 * with `MAX_PROMPT_BYTES` it caps the accumulation at ~3 MiB.
 */
export const MAX_QUEUED_PROMPTS = 32

/**
 * How much of a waiting message's text the staged-prompt snapshot carries.
 *
 * That snapshot is re-sent on every queue change and each waiting message may be
 * `MAX_PROMPT_BYTES` (96 KiB) on its own, so the whole depth would otherwise be
 * ~3 MiB re-broadcast per keystroke-sized event. The renderer draws one
 * truncated line per waiting message, so nothing past this is ever readable; the
 * message itself is untouched and reaches the model in full.
 */
export const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 500

/** Max length for free-text fields (abort reason, ping nonce), in chars. */
export const MAX_TEXT_FIELD_CHARS = 4_096

/**
 * P4-35 — the `saveTextToFile` control-plane channel's own two bounds.
 *
 * This channel is the one place where renderer→main traffic legitimately carries
 * a large body: the payload is a transcript the ENGINE rendered, handed straight
 * back so main can write it to a file the user names in a native dialog. It
 * therefore gets its OWN cap rather than riding either existing one, and neither
 * existing cap moves:
 *
 *  - `MAX_FRAME_BYTES` (128 KiB) stays exactly what it is and still bounds every
 *    other inbound payload. A long session's transcript exceeds it routinely, so
 *    reusing it here would mean the feature silently fails on the sessions most
 *    worth saving.
 *  - `MAX_OUTBOUND_FRAME_BYTES` (32 MiB) is the TRUSTED direction's sanity bound
 *    and must never be applied to renderer input.
 *
 * So this sits deliberately between them: far above a frame, far below the
 * outbound bound. It is still a hostile-input bound — the renderer is untrusted
 * and enforcement is at MAIN (`validateSaveTextRequest`), the preload check being
 * only a fast local failure. What keeps the flood posture intact is that a write
 * cannot happen without the user answering a native save dialog, and the
 * inbound RATE cap (`MAX_FRAMES_PER_WINDOW`) applies to this channel unchanged.
 */
export const MAX_SAVE_TEXT_BYTES = 8 * 1024 * 1024

/**
 * Max length of the renderer's SUGGESTED file name, in chars. A suggestion only:
 * main sanitizes it to a basename and the user renames freely in the dialog.
 */
export const MAX_SAVE_NAME_CHARS = 120

/**
 * Max entries in a permission-response `applySuggestions` selection (C1,
 * decisions/PERMISSION-BOUNDARY.md). Engine suggestion lists are tiny (1–3
 * entries in practice); this is a structural bound on hostile input, not a
 * policy gate.
 */
export const MAX_SUGGESTION_SELECTIONS = 16

/**
 * C5 (P4-20, decisions/ASK-USER-QUESTION-ANSWER.md) — structural bounds on an
 * `askUserQuestion.answer` frame. `MAX_ANSWER_QUESTIONS` mirrors the tool's 1–4
 * `questions` schema bound (`AskUserQuestionTool.tsx`) so an oversized `answers`
 * array is rejected before the per-question checks; `MAX_QUESTION_ANSWER_CHARS`
 * caps the built-in "Other…" freeform string. Both are hostile-input bounds, not
 * policy gates; the whole frame is additionally bounded by `MAX_FRAME_BYTES`.
 */
export const MAX_ANSWER_QUESTIONS = 4
export const MAX_QUESTION_ANSWER_CHARS = 4_096

/**
 * Restored-history replay caps (F2 — decisions/RESTORE-HISTORY.md). On attach,
 * a resumed sidecar replays its restored transcript as `replay: true` event
 * frames; the NEWEST tail is kept under BOTH caps and any omission is signalled
 * with the truncation-boundary error frame (never a silent gap).
 *
 * ALIGNMENT INVARIANT: both caps are deliberately BELOW main's per-session
 * replay-buffer budgets (`DEFAULT_MAX_BUFFERED_FRAMES` 8,000 /
 * `DEFAULT_MAX_BUFFERED_BYTES` 16 MiB, app/main/replayBuffer.ts) — with headroom
 * for early live frames — so a renderer RELOAD right after a restore replays
 * the SAME history from main's buffer instead of silently losing its head.
 * Enforced by test (historyReplay.test.ts); byte accounting matches the
 * buffer's (serialized UTF-8 JSON of the whole frame).
 *
 * The ready head and the once-per-attach snapshots no longer consume any of
 * that headroom: they are `head`/`sticky` in the buffer's retention table and
 * sit outside its budgets entirely.
 *
 * The FRAME count is sized so the BYTE budget is what binds, the same reasoning
 * `DEFAULT_MAX_BUFFERED_FRAMES` was re-sized under (replayBuffer.ts). 400 dated
 * from 2026-07-05, when the buffer was still 512 and 400 was simply "below it
 * with headroom"; raising the buffer to 8,000 on 2026-07-27 left this one
 * behind. Measured over the 142 conversation-bearing transcripts in this repo's
 * store, 400 truncated 18 of them and the frame cap bound EVERY time while the
 * byte cap bound none: the worst case dropped 645 of 1,045 messages (62%) while
 * holding 2.1 MiB against a 4 MiB budget. Truncation reaches zero at ~2,000
 * frames, above which per-message size (p50 1.9 KB, p90 3.7 KB) makes 4 MiB the
 * binding cap at roughly 1,100-2,200 messages. 4,000 clears that crossover with
 * margin and still leaves half of main's ring free for early live frames.
 *
 * The BYTE cap stays at 4 MiB: no measured session exceeded 2.7 MiB, and memory
 * is the thing worth bounding.
 */
export const MAX_HISTORY_REPLAY_FRAMES = 4_000
export const MAX_HISTORY_REPLAY_BYTES = 4 * 1024 * 1024

/**
 * Load-earlier read ceiling (decisions/HISTORY-LOAD-EARLIER.md §Bounds).
 *
 * The caps above are what a session replays on ATTACH, every time, for every
 * session. This one is what a single user-initiated "load earlier messages"
 * request is allowed to re-read from the transcript file, so it is sized for the
 * whole conversation rather than for a per-attach budget. Nothing else uses it,
 * and no cap above moves for its sake. Its sizing corpus is
 * `docs/reports/2026-08-19-transcript-retention-cap-measurement.md`; that
 * report's §3 verdict on the RING caps has since been voided (2026-09-02 — the
 * ring now compacts streamed partials out and `DEFAULT_MAX_BUFFERED_BYTES` is
 * 16 MiB), but the §2 transcript distribution this number comes from stands.
 *
 * SIZING, from that report's 1,849-transcript corpus. Bytes per session: p50
 * 326 KiB, p90 1.34 MiB, p99 4.32 MiB, max 18.1 MiB. 16 MiB clears p99 by
 * roughly 3.7x, so an ordinary session is read whole in one bounded read, and
 * sits just under the largest transcript that corpus contained — deliberately,
 * because the ceiling has to bound a hostile-adjacent read too: every recovered
 * message stays mounted for the life of the pane (no virtualization; CC-59
 * Stage Two is deferred), so the ceiling is also the renderer's memory bound.
 * A session past it recovers a prefix and reports that more remains, which is
 * the honest outcome, not a failure.
 *
 * NO MESSAGE-COUNT CAP. Records per session in the same corpus: p50 82, p90
 * 332, p99 1,075, max 2,988 — no session came within 25% of any count cap in
 * this file, so a count here would never bind and could only truncate a session
 * the byte budget already fits. `loadDisplayTranscriptFromJsonlPath` REQUIRES a
 * `maxMessages`, so the disabling value is spelled out rather than left implicit:
 * `chain.length > MAX_SAFE_INTEGER` is false for any real chain, which keeps the
 * loader's `capped` flag off and leaves its `truncated` reporting purely about
 * the byte ceiling above.
 *
 * Raising either of these re-opens the CC-59 memory gate (same decision doc,
 * §Known cost). Do not raise them without it.
 */
export const MAX_HISTORY_LOAD_EARLIER_BYTES = 16 * 1024 * 1024
export const MAX_HISTORY_LOAD_EARLIER_MESSAGES = Number.MAX_SAFE_INTEGER

/**
 * IDLE-PARK (decisions/IDLE-PARK.md §2) — the sidecar's dedicated non-zero exit
 * code for a host-initiated park (alongside `RESUME_FAILED_EXIT_CODE` below). A
 * parked engine self-exits with THIS code; the host
 * classifies the exit purely from the code (`markParked` vs `markCrashed`,
 * `app/host/host.ts`), which keeps the host plane free of socket frames — no ack
 * frame, no host↔main coordination. Defined ONCE here so `app/sidecar/index.ts`
 * (the exiter) and `app/host/host.ts` (the classifier) import one source and can
 * never drift to two literals.
 */
export const PARKED_EXIT_CODE = 5

/**
 * The sidecar's dedicated non-zero exit code for an UNRESUMABLE engine session
 * id: `resumeEngineSession` threw `SidecarResumeError` because the transcript is
 * missing or carries no loadable conversation (`app/sidecar/sessionResume.ts`),
 * so the sidecar dies loudly instead of silently minting a fresh session (D6
 * anti-Potemkin). Re-homed here from `app/sidecar/index.ts` for the same reason
 * `PARKED_EXIT_CODE` lives here: the host classifies this exit
 * (`app/host/host.ts` — an unresumable row stops being offered) and the two
 * sides must never drift to two literals.
 */
export const RESUME_FAILED_EXIT_CODE = 4

/** Sidecar resume was refused because another process owns the transcript. */
export const RESUME_BUSY_EXIT_CODE = 6

/* ------------------------------------------------------------------------- *
 * Peer sessions + the host request plane
 * (decisions/PEER-SESSIONS.md §7, decisions/HOST-REQUEST-PLANE.md HR1/§4).
 *
 * These bound a THIRD traffic class that neither direction above describes: a
 * request authored by a MODEL inside a sidecar, travelling sidecar → main. It
 * rides the outbound direction, whose only decoder bound is
 * `MAX_OUTBOUND_FRAME_BYTES` — "a sanity bound, not a policy gate" — and which
 * has no per-window rate cap at all. So the consumer applies its own two bounds
 * below. Neither directional limit above moves, and they are never unified:
 * this is a third bound at the consumer, not a re-reading of either.
 * ------------------------------------------------------------------------- */

/**
 * HR1 — main's own size cap on one serialized `host.request`, applied at MAIN.
 *
 * Deliberately equal to `MAX_FRAME_BYTES` rather than derived from the outbound
 * sanity bound: the payload is model-authored under the §8 A1 threat model, so
 * it belongs on the hostile-input scale, not the trusted-engine-output one. It
 * is written as an alias so the two can never drift apart by a stale literal.
 */
export const MAX_HOST_REQUEST_BYTES = MAX_FRAME_BYTES

/**
 * HR1 — main's own per-session rate cap on the MODEL'S host requests, all
 * model-facing verbs together. A sliding window like `MAX_FRAMES_PER_WINDOW`,
 * but a far longer one: these are deliberate model actions (list, create, send),
 * not UI traffic, so the honest bound is "a minute's worth of tool calls", not a
 * per-second burst.
 *
 * `peer.ack` is deliberately NOT counted here. An ack is main-induced
 * bookkeeping — main routes a message, the recipient must ack it — so charging
 * it to the recipient's allowance lets senders spend a session's budget for it:
 * one sender at the pair bucket's sustained rate eats roughly two thirds of this
 * window, and a handful of senders starve the target off the plane entirely,
 * unable to list, create or send on its own behalf. Acks ride
 * `MAX_HOST_REQUEST_FRAMES_PER_WINDOW` below, which bounds them as FRAMES
 * without letting anyone else spend the model's allowance.
 */
export const MAX_HOST_REQUESTS_PER_WINDOW = 60
/** The window both host-request rate caps are counted over. */
export const HOST_REQUEST_WINDOW_MS = 60_000

/**
 * HR1 / A6 — the flood bound on host-request FRAMES, charged before anything is
 * parsed or serialized.
 *
 * `MAX_HOST_REQUESTS_PER_WINDOW` above bounds only what survives validation, so
 * on its own it bounds nothing that matters: an invalid or unknown-verb request
 * is answered and returns before any budget is touched, and each one costs main
 * a `JSON.stringify` on a payload the channel bounds only at its 32 MiB sanity
 * cap. A6 is precisely "a compromised sidecar floods main with requests", and
 * the flood shape that reaches main cheapest is the one that never validates.
 *
 * So this is charged FIRST, on every frame, valid or not, ack or not. Sized to
 * clear legitimate traffic with room to spare: the model's own 60, plus the acks
 * for a full `MAX_PENDING_PEER_MESSAGES` backlog, plus redelivery after a
 * restore, is comfortably under it.
 */
export const MAX_HOST_REQUEST_FRAMES_PER_WINDOW = 240

/**
 * Max chars of any single free-form host-request ARG that is not a message body
 * (a peer name, a model id, an effort, a correlation id). Bodies are bounded by
 * `MAX_PEER_TEXT_BYTES` instead.
 *
 * Here rather than in the handler because PEER-SESSIONS §7 asks for every new
 * constant to live in this file, "named here so a later change is a visible
 * diff" — a bound that sits inside the module it bounds is exactly the one that
 * moves without anyone noticing.
 */
export const MAX_HOST_REQUEST_ARG_CHARS = 256

/**
 * How many times main will re-send one held peer message before giving up on it.
 *
 * The redelivery in `onReady` exists for a recipient that died before acking
 * (§4 step 6), and it had no counter: a message the recipient REJECTS rather
 * than drops is re-sent on every subsequent ready, forever, holding one of the
 * `MAX_PENDING_PEER_MESSAGES` slots for the life of the window. A rejection is
 * not supposed to be reachable — the frame is main-built and schema-valid by
 * construction — which is exactly why the loop needs a bound: an unreachable
 * state that becomes reachable must degrade to a logged drop, not to a
 * permanent retry against a recipient that has already refused it twice.
 *
 * What one attempt MEANS changed when the ack moved to consumption
 * (2026-09-04): a wake that ends unacked is now the ordinary shape of a process
 * that died before its turn reached the message, not evidence of a rejection.
 * So `handlePeerAck` clears the count on every ack the row sends, and this
 * bounds wakes during which the row consumed NOTHING. The number stays 3
 * because that is still the shape of a recipient that refuses everything.
 */
export const MAX_PEER_DELIVERY_ATTEMPTS = 3

/** Maximum repeated route length and per-pair back-and-forth before refusal. */
export const MAX_PEER_HOPS = 16

/**
 * Per RECIPIENT, how many routed peer messages main may be holding undelivered
 * or unacked at once (`queue_full`). Main-side and new: the sidecar's
 * `MAX_QUEUED_PROMPTS` bounds only renderer `app.submit` prompts arriving
 * mid-turn and never sees this plane at all.
 */
export const MAX_PENDING_PEER_MESSAGES = 50

/**
 * Per `(from, to)` token bucket on peer sends: `PEER_SEND_BURST` tokens, one
 * refilled every `PEER_SEND_REFILL_MS`. Upstream's reference was 30 / 2 s; the
 * burst is lowered because a burst here is a burst of BILLED TURNS at the
 * recipient, not of frames.
 */
export const PEER_SEND_BURST = 10
export const PEER_SEND_REFILL_MS = 2_000

/** An identical body to the same recipient inside this window is `duplicate`. */
export const PEER_DEDUP_WINDOW_MS = 30_000

/**
 * How long main keeps a delivered chain available for inheritance. Past it a
 * send starts a fresh chain of one, so an exchange resumed hours later is a new
 * conversation rather than a continuation that is already near the hop cap.
 */
export const PEER_CHAIN_WINDOW_MS = 10 * 60_000

/**
 * Max UTF-8 BYTES of one peer message body (a send's text, a creation prompt).
 *
 * The same headroom rule as `MAX_PROMPT_BYTES` above, for the same reason and
 * against a different frame: main REBUILDS the inbound `peer.deliver` frame
 * around this text, adding the sender identity, a message id and the
 * `ClientFrame` envelope, and the supervisor rejects the whole ENCODED frame
 * against `MAX_FRAME_BYTES` (128 KiB). Measured in bytes, not JS chars, so
 * multibyte text cannot advertise a size the frame cannot carry.
 */
export const MAX_PEER_TEXT_BYTES = 64 * 1024

/**
 * `ReadPeer`'s own byte budget for what it hands back (PEER-SESSIONS §7, §8).
 *
 * A THIRD bound again, and for the same reason the two above are separate: this
 * one does not protect a frame or a queue, it protects the READER'S CONTEXT. The
 * whole design premise of §8 is that reading a peer's transcript whole is the
 * failure mode, so the tool always answers within a budget and says so rather
 * than returning everything it found.
 *
 * The default is what an unparameterised call gets; the max is the ceiling on
 * what the model may ask for. Both are measured on the FINAL text, after
 * redaction and control-text escaping, so the number bounds what is actually
 * spent. `maxBytes` outside the range is CLAMPED into it and never an error
 * (§7 table: "the tool clamps, never errors"), because a model that guesses a
 * bound should get a bounded read, not a refusal it has to learn to avoid.
 *
 * RAISED 2026-09-05, when the read's unit became a TURN and `limit` was
 * removed, leaving this the only count bound there is. A median peer session is
 * 5 turns, and the proposed shape built against two real peers measured 24,089
 * and 17,272 bytes for exactly that: 16 KiB returned a median peer in pieces.
 * Cost is not what bounds this. A peer runs at 372,000 tokens (Codex) or
 * 1,000,000 (a frontier Claude model) of context (`src/utils/context.ts`), so
 * 32 KiB is roughly 2.5% of the smaller window, and half an answer costs a
 * second call plus the wrong conclusion drawn from the first.
 */
export const PEER_READ_DEFAULT_BYTES = 32 * 1024
export const MAX_PEER_READ_BYTES = 128 * 1024

/**
 * Max UTF-8 BYTES of a `ReadPeer` search query. Small on purpose: it is a
 * substring to look for inside one named peer's transcript, not a document. It
 * bounds the only free text this read-only tool accepts.
 */
export const MAX_PEER_QUERY_BYTES = 512

/**
 * How long main waits for a woken row's `ready` frame before answering
 * `refused:wake_failed` (HOST-REQUEST-PLANE §4 step 5).
 *
 * NOT in the §7 constants table — that table names the guards, and the wake has
 * none. It needs one all the same: without it a `peer.deliver` to a row whose
 * spawn never completes leaves the requesting model's tool call pending for the
 * life of the window. Sized above a cold sidecar spawn plus a transcript resume,
 * and it MUST stay below the sidecar's own request timeout so the caller learns
 * `wake_failed` rather than `timeout`.
 */
export const PEER_WAKE_TIMEOUT_MS = 30_000

/**
 * How long a sidecar waits for the `host.result` answering its `host.request`
 * before resolving the caller with a typed timeout failure. Strictly greater
 * than `PEER_WAKE_TIMEOUT_MS`, which is the longest main can legitimately take.
 */
export const HOST_REQUEST_TIMEOUT_MS = 45_000
