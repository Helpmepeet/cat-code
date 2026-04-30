# Fullscreen streaming scroll UX findings

## Problem explored

With `CLAUDE_CODE_NO_FLICKER=1`, the fullscreen UI follows assistant output while text is streaming. That keeps the latest output visible, but it also means the beginning of the answer moves upward while generation continues.

The user wanted to be able to start reading from top to bottom without the viewport constantly pushing text away.

## Code path investigated

Relevant files:

- `src/utils/fullscreen.ts`
- `src/components/FullscreenLayout.tsx`
- `src/ink/components/ScrollBox.tsx`
- `src/screens/REPL.tsx`
- `src/components/Messages.tsx`

Key behavior:

- `FullscreenLayout` renders the transcript in a `ScrollBox` with `stickyScroll={true}`.
- `ScrollBox` uses imperative sticky state: manual `scrollTo()` / `scrollBy()` break sticky; `scrollToBottom()` restores it.
- REPL computes `visibleStreamingText` from `streamingText` and passes it to `Messages`.
- `Messages` renders the streaming text as appended transcript content.
- Result: while pinned to bottom, the viewport follows the growing streamed row.

## Important observed behavior

The user found that the app already has a useful built-in distinction:

- if the user is at the bottom, the viewport follows streamed output
- if the user scrolls up even a little, the viewport stops following

So the system does already support a non-follow reading mode. The UX problem is the transition into that mode, not the total absence of that mode.

## Experiments tried

We tried a REPL-only heuristic that automatically broke sticky scroll once during streaming.

Approach:

- keep the current layout
- when `visibleStreamingText` first appeared, call `scrollRef.current.scrollBy(-1)` once
- later variations delayed that trigger until the visible streamed text crossed a newline threshold

Thresholds tried:

- first visible streamed line
- 2 visible newlines
- 10 visible newlines

## Outcome

These heuristics were reverted.

They produced worse UX than the original behavior:

- in practice, the first generated line could be hidden or partially missed
- threshold tuning did not produce a stable result that felt correct
- the fix felt like a half-working heuristic rather than a robust UX improvement

The user preferred reverting to the original behavior rather than keeping the partial fix.

## Takeaways

1. A simple threshold-based auto-unfollow heuristic is probably the wrong solution.
2. The existing follow/non-follow mechanics are already useful and should be respected.
3. A future fix should likely be more explicit or more structurally grounded than "break sticky after N lines".
4. If revisiting this, do not assume the smallest imperative scroll tweak will produce acceptable UX.

## Better future directions

Possible directions worth exploring later:

- an explicit follow/lock mode instead of an implicit threshold
- a better transition rule grounded in viewport geometry rather than newline counts
- changing where streaming text is rendered, if that can preserve readability without introducing new confusion

Any revisit should start by validating real terminal behavior, not just reasoning from the code.
