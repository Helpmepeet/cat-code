/**
 * IPC boundary limits (SECURITY-MINIMUM §2 R4 / T7, review findings F3/F4).
 *
 * Two DIRECTIONS with different trust and therefore different caps:
 *
 *  - INBOUND (renderer → sidecar) is hostile: a compromised renderer can flood
 *    or oversize frames. `MAX_FRAME_BYTES` bounds it (T7), matching the WS
 *    server's 128 KiB (AppSessionWebSocketServer.ts:29). The prompt cap is
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

/** Sliding-window rate cap: max inbound frames per window (T7). */
export const MAX_FRAMES_PER_WINDOW = 120

/** Rate-limit window length in milliseconds. */
export const RATE_WINDOW_MS = 1_000

/**
 * Max prompt size accepted by `app.submit`, in UTF-8 BYTES. Kept well under
 * MAX_FRAME_BYTES so a valid prompt always fits one inbound frame (F4). Measured
 * in bytes, not JS chars, so multibyte input cannot exceed the frame cap.
 */
export const MAX_PROMPT_BYTES = 96 * 1024

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
 * `DEFAULT_MAX_BUFFERED_BYTES` 8 MiB, app/main/replayBuffer.ts) — with headroom
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
