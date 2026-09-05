/**
 * How newly streamed assistant prose arrives on screen — a RENDERER-LOCAL view
 * preference.
 *
 * ALL THREE OPTIONS ARE CHUNK-TIMED. Text becomes visible the frame its
 * delivered batch is applied: never buffered, never held back, never lagging the
 * wire. They differ only in the arrival ANIMATION of the text a batch appended.
 * Cadences that alter timing (a buffered word-by-word reveal, a sentence or
 * boundary settle) were designed, played, and rejected on 2026-08-25, because
 * display must stay honest to delivery. Do not reintroduce one.
 *
 * NOT an engine setting. Nothing in `app/shared/settingsEditable.ts` decides how
 * a transcript row is drawn, so this persists exactly like `toolCardStyle`,
 * `toolsExpanded`, the reasoning layout and the code theme: versioned JSON in
 * the renderer's own storage, best-effort.
 *
 * Timings are the operator-approved reference's, not invented here:
 * `docs/design-html/2026-08-25-streaming-prose-arrival.html` (untracked),
 * variants A / B / E.
 *
 * Every class NAME here is a whole literal. Tailwind resolves classes at build
 * time from literal source text, so a composed name produces no rule at all.
 */

import { createContext } from 'react'
import {
  readViewPreference,
  writeViewPreference,
  type ViewPreferenceStorage,
} from './viewPreference.js'

export const PROSE_ARRIVAL_STORAGE_KEY = 'catcode.proseArrival.v1'

export const PROSE_ARRIVALS = ['instant', 'smooth', 'flowing'] as const

export type ProseArrival = (typeof PROSE_ARRIVALS)[number]

/**
 * `smooth`, not `instant`. This is the one view preference whose shipped default
 * is NOT today's behavior: the operator picked it off the playable reference,
 * and today's behavior is what `instant` preserves for anyone who wants it back.
 */
export const DEFAULT_PROSE_ARRIVAL: ProseArrival = 'smooth'

export const PROSE_ARRIVAL_LABELS: Readonly<Record<ProseArrival, string>> = {
  instant: 'Instant',
  smooth: 'Smooth',
  flowing: 'Flowing',
}

export function isProseArrival(value: unknown): value is ProseArrival {
  return (PROSE_ARRIVALS as readonly unknown[]).includes(value)
}

/**
 * The class carried by a span of text a batch just appended.
 *
 * One mechanism for all three, which is what the approved reference does: its
 * `smooth` and `flowing` variants are both word spans and differ only in
 * duration and in whether a per-word delay is applied. Splitting `smooth` into
 * a single per-batch region instead would be less DOM but a second code path,
 * and would not match what was approved.
 *
 * `instant` has no class: settled text and arriving text are indistinguishable,
 * which is precisely today's behavior.
 */
export const PROSE_ARRIVAL_WORD_CLASS: Readonly<
  Record<ProseArrival, string | null>
> = {
  instant: null,
  smooth: 'prose-arrive-smooth',
  flowing: 'prose-arrive-flowing',
}

/**
 * Milliseconds of delay added per word within ONE batch, so a batch's words fade
 * in sequence rather than together. Zero means the whole batch fades as one.
 *
 * This is a delay only. It never postpones when text becomes VISIBLE beyond its
 * own fade, and it never reorders or holds back delivery.
 */
export const PROSE_ARRIVAL_WORD_STAGGER_MS: Readonly<
  Record<ProseArrival, number>
> = {
  instant: 0,
  smooth: 0,
  flowing: 25,
}

/**
 * Upper bound on the stagger a single batch may accumulate.
 *
 * A batch is normally a handful of words, but a resumed or replayed transcript
 * can append a very large one. Without a ceiling, `flowing` would schedule the
 * last word of a 4,000-word batch a hundred seconds out, which is both a lie
 * about delivery and a long-lived animation set. Past the cap the remaining
 * words share the final delay.
 */
export const MAX_PROSE_ARRIVAL_STAGGER_MS = 400

export type ProseArrivalContextValue = {
  arrival: ProseArrival
  setArrival: (next: ProseArrival) => void
}

export const ProseArrivalContext = createContext<ProseArrivalContextValue>({
  arrival: DEFAULT_PROSE_ARRIVAL,
  setArrival: () => {},
})

export function readProseArrivalFromStorage(
  storage: ViewPreferenceStorage | null,
): ProseArrival | null {
  return readViewPreference(
    storage,
    PROSE_ARRIVAL_STORAGE_KEY,
    'arrival',
    value => (isProseArrival(value) ? value : null),
  )
}

export function writeProseArrivalToStorage(
  storage: ViewPreferenceStorage | null,
  arrival: ProseArrival,
): void {
  writeViewPreference(storage, PROSE_ARRIVAL_STORAGE_KEY, 'arrival', arrival)
}
