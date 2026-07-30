# FILE-SINK — the renderer may ask for a file, never name one (operator ruling)

**Status: DECIDED 2026-07-30 (operator). Built the same day (P4-35).** Branch `migration`.

## The question, and the ruling

P4-30 built the `ExportDialog` and had to ship its **Download button disabled**:
no renderer-reachable file-write path existed anywhere in `app/` (no
`showSaveDialog`, no `createObjectURL`, no `<a download>`), so saving a transcript
to a file was unreachable from the desktop app. Adding one widens the control
plane, which is repo mistake #5 and a worker cannot self-authorize.

The operator ruled: **build the save channel.**

## The shape

A `CH_HOST_SAVE_TEXT` control-plane channel, deliberately built as the **mirror of
`CH_HOST_PICK_DIR`** (`app/main/main.ts`) rather than as a new kind of thing:

| | `pickDirectory` (HC1, P3-3) | `saveTextToFile` (this) |
|---|---|---|
| Renderer supplies | nothing but a session id hint | `{ text, suggestedName }` |
| Renderer can name a path | no | no |
| Who chooses the location | the USER, in main's native dialog | the USER, in main's native dialog |
| Renderer learns the path | no (it gets a one-time token) | no (it gets `saved: true`) |

The invariant both share, and the reason the shape was copied: **the renderer may
REQUEST a native dialog it cannot answer.** The directory picker exists so a
compromised renderer cannot scope a new session's tools at a directory it chose;
this exists so it cannot choose where bytes land, or discover paths by probing
write failures.

Concretely (`app/main/mainDecisions.ts`, `app/main/main.ts`, `app/preload/preload.ts`):

1. `SaveTextInput` has **no path field**, so no destination is expressible on the
   channel. This is the primary control; everything below is defense in depth.
2. `sanitizeSaveFileName` reduces `suggestedName` to a bare name by a **whitelist**:
   everything up to the last `/` or `\` is discarded (so `../../etc/passwd`,
   `/etc/passwd` and `C:\Windows\x` reduce to their last segment), every character
   outside `[A-Za-z0-9._-]` becomes `-` (which removes NUL bytes, newlines, control
   characters and shell metacharacters as a class), and a name with no usable stem
   (`.`, `..`, `''`) is rejected. The result cannot contain a separator, so main can
   never be induced to join a path fragment.
3. The name is a **suggestion**: it becomes the save dialog's default, which the
   user renames and relocates freely. Rejecting is therefore cheap.
4. `validateSaveTextRequest` runs at **main**, the trust boundary, before any
   dialog opens. The preload checks the same bounds only for a fast local failure;
   the preload runs in the renderer's process and is never treated as a boundary.
5. **HC3** — a fixed per-method sender on a fixed channel, pinned by
   `preloadSource.test.ts` (channel constant, the invoke allowlist, the guard
   count) and by the hardening smoke's exact `bridgeKeys` list.
6. The result type carries **no path**: `{ ok: true, saved: boolean }` or a typed
   error. `saved: false` is a dismissed dialog, which is a normal outcome, not a
   failure.

## What this is NOT

- **Not a host method.** It names no session, reads no registry row and spawns
  nothing, so it is not in `HostApi` and adds **zero inbound wire vocabulary**: it
  never reaches a sidecar. Like the picker, it is a main-owned capability.
- **Not on the `HostErrorCode` union.** `SaveTextErrorCode` is a third, separate
  union for the same reason `HostErrorCode` and `ErrorFrame['code']` are separate
  (SECURITY-MINIMUM F3 §3): a file-sink outcome in the vocabulary a
  `createSession` caller pattern-matches would erase which plane failed.
- **Not a change to either directional frame cap.** `MAX_FRAME_BYTES` (128 KiB
  inbound) and `MAX_OUTBOUND_FRAME_BYTES` (32 MiB outbound) are unchanged and
  un-unified. This channel gets its OWN bound, `MAX_SAVE_TEXT_BYTES` (8 MiB),
  sitting strictly between them, pinned by a test.

  Why it needs one: the payload is a transcript the ENGINE rendered, handed back
  so main can write it, and a long session exceeds 128 KiB routinely — reusing the
  inbound cap would mean the feature silently fails on the sessions most worth
  saving. What keeps T7's flood posture intact is that the inbound **rate** cap
  still applies to this channel unchanged, and that no write can happen without
  the user answering a native dialog.

## Verification owed and paid (P4-35)

- Traversal / absolute-path / NUL-byte / control-character / no-stem / non-string
  and byte-oversize cases: `app/main/mainDecisions.test.ts`.
- Path never crosses back to the renderer: `app/main/mainSourceGuards.test.ts`
  pins the dialog answer to exactly two uses (the cancel check and the write).
- Preload stays default-deny and filesystem-free in both directions, and the save
  region names no destination: `app/preload/preloadSource.test.ts`.
- `bun run --cwd app test:hardening` **19/19**, including the exact-bridge-keys
  check with `saveTextToFile` present.

## Consequences

Export finally reaches a file. `ExportDialog`'s Download is live
(`app/renderer/src/SessionActionDialogs.tsx`), and the Sessions page's **bulk
Export** became meaningful for the first time: ten transcripts cannot go to the
clipboard, so the bulk path folds one real `session.export` per live row into a
single file through the same dialog.
