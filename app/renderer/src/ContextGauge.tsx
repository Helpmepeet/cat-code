import type { ContextUsage } from './contextUsage.js'

/**
 * The composer's context-window donut (P4-24 fidelity — `Chat.jsx:239` "Donut
 * context gauge (inline with input)"), the desktop analog of the terminal's
 * `ctx: NN%` indicator. Fed by {@link selectContextUsage} — real result-frame
 * usage, no invented data. Quiet while there is headroom; it takes on warn/
 * danger tone as the window fills (AccountsPage's pressure-tone pattern,
 * `AccountsPage.tsx:81`).
 *
 * Tailwind discipline: the tone is a STATIC class map (no interpolated
 * `text-[${…}]` — the v4 dynamic-class trap); the ring color rides
 * `stroke="currentColor"` off that tone class; only the arc geometry
 * (`strokeDasharray`/`strokeDashoffset`) is a computed SVG presentation
 * attribute, which is not a `style={{}}` object and not a className.
 */
const RADIUS = 9
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function contextToneClass(percentUsed: number): string {
  if (percentUsed >= 90) return 'text-tone-danger'
  if (percentUsed >= 65) return 'text-tone-warn'
  return 'text-text-muted'
}

export function ContextGauge({ usage }: { usage: ContextUsage }) {
  const { percentUsed, usedTokens, contextWindow } = usage
  const tone = contextToneClass(percentUsed)
  const offset = CIRCUMFERENCE * (1 - percentUsed / 100)
  return (
    <span
      className={`flex shrink-0 self-center items-center gap-1.5 ${tone}`}
      title={`Context: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${percentUsed}% used)`}
      aria-label={`Context ${percentUsed}% used`}
    >
      <svg width="20" height="20" viewBox="0 0 22 22" className="-rotate-90" aria-hidden>
        <circle
          cx="11"
          cy="11"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="opacity-20"
        />
        <circle
          cx="11"
          cy="11"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="font-mono text-[10.5px] tabular-nums">{percentUsed}%</span>
    </span>
  )
}
