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
