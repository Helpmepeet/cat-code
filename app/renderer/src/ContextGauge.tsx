import {
  pressureTone,
  selectContextReferenceFraction,
  type ContextUsage,
} from './contextUsage.js'
import { toneClasses } from './tone.js'

/**
 * The composer's context-window donut (P4-24 fidelity — the prototype's
 * `ContextChip`, `Surfaces.jsx:467-495`): a 16×16 ring (R=6.5, stroke 3) with a
 * faint white track and a tinted arc, followed by a 12.5px semibold `NN%`. Fed by
 * {@link selectContextUsage} — real result-frame usage, no invented data. The
 * pink brand hue while there is headroom, taking on warn/danger tone as the
 * window fills.
 *
 * A DEVIATION from the prototype, added deliberately (operator call,
 * 2026-08-17): the white reference tick at
 * {@link CONTEXT_REFERENCE_TOKENS}, on windows large enough for it to mean
 * something. It is a scale mark and nothing more — the tone ladder, the warning
 * glyph beside it and the compaction threshold are all unchanged, so crossing it
 * changes exactly one thing on screen. Do not "restore parity" by removing it,
 * and do not grow it into a second warning.
 *
 * Tailwind discipline: the tone is a STATIC class map (no interpolated
 * `text-[${…}]` — the v4 dynamic-class trap); the arc rides `stroke="currentColor"`
 * off that tone class. The faint track and the arc geometry are computed SVG
 * presentation attributes, not `style={{}}` objects or classNames.
 *
 * The arc is `arcLength CIRCUMFERENCE`, the prototype's exact dash form, and NOT
 * the equivalent-looking `strokeDasharray={CIRCUMFERENCE}` +
 * `strokeDashoffset={…}` pair. The two agree at every percentage except 0: a
 * zero-length dash under `strokeLinecap="round"` renders a DOT at 12 o'clock,
 * which is the prototype's empty state, whereas the offset form starts mid-dash
 * and renders nothing at all. Verified by difference-blending both against the
 * running prototype.
 */
const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const STROKE_WIDTH = 3
/** The tick overhangs the band by this much at each end, so it reads as a mark
 * ACROSS the ring rather than a chip out of it. */
const REFERENCE_TICK_OVERHANG = 0.4

/**
 * The two endpoints of the reference tick, in the gauge's own unrotated frame.
 * The `-rotate-90` on the svg is what puts fraction 0 at 12 o'clock, exactly as
 * it does for the arc, so this measures the angle from the +x axis and lets the
 * shared rotation place both.
 */
function referenceTick(fraction: number) {
  const angle = fraction * 2 * Math.PI
  const inner = RADIUS - STROKE_WIDTH / 2 - REFERENCE_TICK_OVERHANG
  const outer = RADIUS + STROKE_WIDTH / 2 + REFERENCE_TICK_OVERHANG
  return {
    x1: 8 + inner * Math.cos(angle),
    y1: 8 + inner * Math.sin(angle),
    x2: 8 + outer * Math.cos(angle),
    y2: 8 + outer * Math.sin(angle),
  }
}

export function ContextGauge({ usage }: { usage: ContextUsage }) {
  const { percentUsed, usedTokens, contextWindow } = usage
  const tone = toneClasses(pressureTone(percentUsed)).text
  const arcLength = (percentUsed / 100) * CIRCUMFERENCE
  // Drawn AFTER the arc, and in white rather than `currentColor`, so it stays
  // legible on both sides of itself: over the tinted arc once the session has
  // passed it, and over the faint track while it has not.
  const referenceFraction = selectContextReferenceFraction(usage)
  const tick = referenceFraction == null ? null : referenceTick(referenceFraction)
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 self-center ${tone}`}
      title={`Context: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${percentUsed}% used)`}
      aria-label={`Context ${percentUsed}% used`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90" aria-hidden>
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={STROKE_WIDTH}
        />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${CIRCUMFERENCE}`}
        />
        {tick ? (
          <line
            x1={tick.x1}
            y1={tick.y1}
            x2={tick.x2}
            y2={tick.y2}
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
      <span className="text-[12.5px] font-semibold tabular-nums">{percentUsed}%</span>
    </span>
  )
}
