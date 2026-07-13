import type { ContextUsage } from './contextUsage.js'

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
 * off that tone class. The faint track and the arc geometry
 * (`strokeDasharray`/`strokeDashoffset`) are computed SVG presentation attributes,
 * not `style={{}}` objects or classNames.
 */
const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function contextToneClass(percentUsed: number): string {
  if (percentUsed >= 90) return 'text-tone-danger'
  if (percentUsed >= 65) return 'text-tone-warn'
  // The prototype's donut is the pink brand hue while there is headroom
  // (`ContextChip`, Surfaces.jsx:474 `#f472b6`), not a neutral grey.
  return 'text-accent'
}

export function ContextGauge({ usage }: { usage: ContextUsage }) {
  const { percentUsed, usedTokens, contextWindow } = usage
  const tone = contextToneClass(percentUsed)
  const offset = CIRCUMFERENCE * (1 - percentUsed / 100)
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
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="text-[12.5px] font-semibold tabular-nums">{percentUsed}%</span>
    </span>
  )
}
