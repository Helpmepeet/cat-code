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
 * replay-buffer budgets (`DEFAULT_MAX_BUFFERED_FRAMES` 512 /
 * `DEFAULT_MAX_BUFFERED_BYTES` 8 MiB, app/main/replayBuffer.ts) — with headroom
 * for the ready head, permission.context snapshots, and early live frames — so
 * a renderer RELOAD right after a restore replays the SAME history from main's
 * buffer instead of silently losing its head. Enforced by test
 * (historyReplay.test.ts); byte accounting matches the buffer's (serialized
 * UTF-8 JSON of the whole frame).
 */
export const MAX_HISTORY_REPLAY_FRAMES = 400
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
