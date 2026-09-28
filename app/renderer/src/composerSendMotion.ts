/**
 * Send-message motion helpers (docs/design-html/2026-09-28-send-message-motion.html):
 * the composer lift (every immediate send), the in-chat column slide (a fresh
 * user row landing live, pinned to bottom), and the Welcome→bubble flight (the
 * first send in an empty chat). Pure/imperative DOM helpers live here, not in
 * `SessionPane.tsx` or `ComposerInput.tsx`, because both are `.tsx` files
 * reserved for components.
 */

import { observePaneScroll } from './markdownScrollCoordinator.js'

/** Mirrors `--motion-fast` (theme.css): how long the placeholder stays hidden
 * after the field clears before it fades in with the existing `animate-arrive`. */
export const COMPOSER_LIFT_HOLD_MS = 120

/** Mirrors `--motion-value` (theme.css): the Welcome→bubble flight duration,
 * driven by the Web Animations API rather than a CSS class (see `playFlight`). */
export const WELCOME_FLIGHT_MS = 400

/** Long enough for `.animate-welcome-exit` (`--motion-panel`, 200ms) to finish
 * before `SessionPane` unmounts the exiting `WelcomeScreen` — the same
 * `animationend`-is-not-guaranteed buffer `entranceLatch.ts` uses. Only the
 * fallback (no-flight) exit needs this: the flight's own, longer WAAPI
 * duration already outlasts the CSS exit it runs alongside. */
export const WELCOME_EXIT_FALLBACK_MS = 260

/**
 * How long to wait for the engine's echo before an empty chat's first send
 * falls back to the plain composer lift instead of holding the draft in place.
 *
 * `AppSessionController.submit` emits `turn.status(active:true)` synchronously
 * BEFORE calling into the engine's turn (`src/app-runtime/AppSessionController.ts`
 * lines 201 vs. 221-234), so `generating` is already true by the time any
 * message — the echo included — can arrive. The echo itself still waits on the
 * engine's own `processUserInput` (`src/QueryEngine.ts` submitMessage), a real
 * async step (attachment/command handling) with no fixed bound and no network
 * call for a plain-text prompt. Keep the visual hold brief; a late echo uses
 * the plain lift rather than leaving the draft motionless.
 */
export const WELCOME_FLIGHT_ECHO_TIMEOUT_MS = 300

/** Whether the OS/app motion preference is reduced. Web Animations API motion
 * bypasses CSS entirely, so this must be checked wherever this module drives
 * one directly, not left to the `prefers-reduced-motion` stylesheet alone. */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

export type ComposerGhostSnapshot = {
  /** The field's live markup at capture time (collapsed-paste pills included),
   * cloned as a static copy — never re-rendered by React. */
  html: string
  /** Position relative to `.field-wrap` (`position: relative`), taken BEFORE
   * the field clears: an emptied field is ~10px shorter and the input row is
   * bottom-aligned, so the wrap itself moves down after the clear. Capturing
   * post-clear would place the ghost at the wrong height. */
  topPx: number
  widthPx: number
}

/**
 * Captures the composer field's current text at its exact pre-clear position,
 * for the lift (behavior 1) and Welcome flight (behavior 3). Null when there is
 * nothing to show (an image-only send, or the field failed to resolve).
 */
export function captureComposerGhost(
  field: HTMLElement | null,
  fieldWrap: HTMLElement | null,
): ComposerGhostSnapshot | null {
  if (!field || !fieldWrap) return null
  if ((field.textContent ?? '').trim().length === 0) return null
  const fieldRect = field.getBoundingClientRect()
  const wrapRect = fieldWrap.getBoundingClientRect()
  return {
    html: field.innerHTML,
    topPx: fieldRect.top - wrapRect.top,
    widthPx: fieldRect.width,
  }
}

export type FlightTransform = {
  originXPx: number
  originYPx: number
  scale: number
}

/**
 * The draft-to-bubble flight transform (mock `flyFromComposer`). The draft
 * renders at 15px with 6px of top padding (`ComposerInput`'s field:
 * `py-1.5 text-[15px]`); the landed bubble text renders at 14px inside a 1px
 * border plus `px-4 py-2.5` padding (`UserBubble`). Scaling by 15/14 and
 * offsetting by that padding difference keeps the WORDS aligned through the
 * flight, not just the two boxes.
 */
export function computeFlightTransform(
  fromRect: { top: number; left: number },
  toRect: { top: number; left: number },
): FlightTransform {
  const k = 15 / 14
  return {
    originXPx: fromRect.left - k * 17 - toRect.left,
    originYPx: fromRect.top + 6 - k * 11 - toRect.top,
    scale: k,
  }
}

/**
 * Plays the Welcome→bubble flight on `flightEl` (a fixed-position clone of the
 * landed bubble, already sized/positioned at the DESTINATION rect). Resolves
 * once the animation finishes or is cancelled.
 */
export function playFlight(
  flightEl: HTMLElement,
  transform: FlightTransform,
  settledBackground: string,
  settledBorderColor: string,
): Animation {
  return flightEl.animate(
    [
      {
        transform: `translate(${transform.originXPx}px, ${transform.originYPx}px) scale(${transform.scale})`,
        backgroundColor: 'transparent',
        borderColor: 'transparent',
      },
      { transform: 'none', backgroundColor: settledBackground, borderColor: settledBorderColor },
    ],
    { duration: WELCOME_FLIGHT_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  )
}

/**
 * Runs `onSettled` once, after the pane's next scroll-correction frame (the
 * shared `markdownScrollCoordinator` pump that also owns stick-to-bottom).
 * The in-chat slide (behavior 2) needs the scroller's position AFTER that
 * correction has applied for this commit, not the raw post-mutation position:
 * measuring earlier would apply the transform against an unsettled scrollTop
 * and the pane's own pin would then visibly fight it. Returns a cancel
 * function; safe to call after `onSettled` already ran.
 */
export function afterNextScrollCorrection(
  scroller: HTMLElement,
  onSettled: () => void,
): () => void {
  const unsubscribe = observePaneScroll(scroller, () => {
    unsubscribe()
    onSettled()
  })
  return unsubscribe
}

/**
 * Starts the in-chat column slide (behavior 2): the column is already at its
 * final (0) position, so it jumps to `+deltaPx` with no transition, then
 * transitions back to 0 over `--motion-panel`. `deltaPx` is
 * `scrollTopAfter - scrollTopBefore` — how far the scroller's own bottom-lock
 * pin just moved, which is exactly how far a reader's eye would otherwise see
 * the transcript jump.
 */
const activeSlides = new WeakMap<HTMLElement, {
  timeout: ReturnType<typeof setTimeout>
  finish: (event: Event) => void
}>()

export function playTranscriptColumnSlide(column: HTMLElement, deltaPx: number): void {
  finishTranscriptColumnSlide(column)
  column.classList.add('is-slide-primed')
  column.style.setProperty('--transcript-col-offset', `${deltaPx}px`)
  // Force layout so the jump above is committed before the transition below
  // starts, or the browser coalesces both writes and there is nothing to slide.
  void column.getBoundingClientRect()
  column.classList.remove('is-slide-primed')
  column.classList.add('is-sliding')
  column.style.setProperty('--transcript-col-offset', '0px')
  const finish = (event: Event): void => {
    if (event.target !== column) return
    finishTranscriptColumnSlide(column)
  }
  column.addEventListener('transitionend', finish)
  // Reduced motion (a live preference change mid-slide) leaves no
  // `transitionend` to fire; the fallback timeout below still lands it at 0.
  const timeout = setTimeout(() => finishTranscriptColumnSlide(column), 260)
  activeSlides.set(column, { timeout, finish })
}

/** Clears a slide's transition class and offset once it settles. */
export function finishTranscriptColumnSlide(column: HTMLElement): void {
  const active = activeSlides.get(column)
  if (active) {
    clearTimeout(active.timeout)
    column.removeEventListener('transitionend', active.finish)
    activeSlides.delete(column)
  }
  column.classList.remove('is-slide-primed')
  column.classList.remove('is-sliding')
  column.style.removeProperty('--transcript-col-offset')
}
