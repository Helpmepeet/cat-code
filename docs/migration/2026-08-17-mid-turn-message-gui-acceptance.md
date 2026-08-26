# Mid-turn message: operator GUI acceptance

**Date:** 2026-08-17
**Covers:** CC-62, CC-63, CC-65, CC-67, CC-69
**Why this exists:** the acceptance steps for this work were spread across five
STATUS rows. This is the deduplicated single pass.

Nothing below can be closed headlessly. The renderer suite renders to static
markup with no effects, no frame delivery, no clicks and no toasts, so it proves
reducers and markup and nothing else. Every step here is a claim only a person
in front of the app can settle.

Launch from a **fresh** start. A dev app left open across these commits is
showing HMR state, and `app.isPackaged` is derived from the executable name, so
a renamed dev binary silently serves a stale `dist` instead.

```bash
bun run --cwd app dev
```

## A. Staging — a message you send mid-response is not "sent" yet

1. Start a turn that will run several tools. While it runs, type a message and
   press Enter. It must appear at the **end of the transcript** as `Queued`,
   below the last delivered message and scrolling with it, and must NOT appear
   as a transcript message. Scroll up: there must be no dead band above the
   composer where the block used to sit (moved out of the dock 2026-08-26,
   `63c34935`).
2. Watch it move into the transcript at the moment the model picks it up. That
   is the engine consuming it; before that moment the model has not seen it.
3. Repeat with a turn that answers with text only and calls no tools. The message
   must stay staged until the turn ends, then appear in the transcript exactly
   once as its own turn starts. Not twice.
4. With a message staged, reload the window. The staged row must come back.
5. Attach an image with no text and send it mid-turn. The row must read
   `Image attachment`, and it must deliver like any other.

## B. Take back

6. With one message staged, the row group shows `Take back`. Click it: the text
   returns to the composer, the row disappears, and there is no toast. The text
   itself is the confirmation.
7. Repeat, but type a draft while the message is waiting. The recalled text must
   land **above** your draft, with the draft intact underneath.
8. Repeat with an image attached to the staged message. The image must come back
   attached, not silently dropped.
9. Stage two messages. The control must read `Take back all`, and one click must
   return both, joined by a newline.
10. From the composer, Shift+Tab must reach the control, and Enter must fire it.
    Since the block moved into the transcript it is no longer the last stop
    before the composer: the jump-to-bottom pill, when showing, comes between
    them. `↑` on an empty draft is the unchanged fast path.
11. **The race.** Click `Take back` at the instant a tool round completes. Expect
    a warn-tone toast saying the message already went to the model, and expect
    the message to appear in the transcript rather than vanish. This is the one
    step where the honest-reporting design shows itself, and the residual is
    real: inside a narrow window you are told it came back while it goes through
    anyway. Judge whether that reads acceptably.

## C. Refusal and recovery

12. Send 33 messages into one running response (`MAX_QUEUED_PROMPTS` is 32), with
    an image attached to the 33rd. The 33rd must be refused, must leave nothing
    staged, and must land back in the composer **with its image**.
13. While that refusal is in flight, confirm the messages that were accepted are
    NOT handed back. Only the refused one returns.

## D. Accessibility

14. With three messages waiting, confirm a screen reader announces the group
    once rather than once per row.

## What a failure here means

A, B and C failing are user-visible defects in shipped behavior. Step 11 is the
one where the correct outcome is a judgment call rather than a pass or fail:
report what you see and it becomes the decision record.
