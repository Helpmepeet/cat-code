import { pressureTone, type ContextUsage } from './contextUsage.js'
import { toneClasses } from './tone.js'

/**
 * The composer's context-window donut (P4-24 fidelity — the prototype's
 * `ContextChip`, `Surfaces.jsx:467-495`): a 16×16 ring (R=6.5, stroke 3) with a
 * faint white track and a tinted arc, followed by a 12.5px semibold `NN%`. Fed by
 * {@link selectContextUsage} — real result-frame usage, no invented data. The
 * pink brand hue while there is headroom, taking on warn/danger tone as the
 * window fills.
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

export function ContextGauge({ usage }: { usage: ContextUsage }) {
  const { percentUsed, usedTokens, contextWindow } = usage
  const tone = toneClasses(pressureTone(percentUsed)).text
  const arcLength = (percentUsed / 100) * CIRCUMFERENCE
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
          strokeWidth="3"
        />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${CIRCUMFERENCE}`}
        />
      </svg>
      <span className="text-[12.5px] font-semibold tabular-nums">{percentUsed}%</span>
    </span>
  )
}
