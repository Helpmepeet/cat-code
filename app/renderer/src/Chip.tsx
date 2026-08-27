/**
 * P4-1 shared primitive — `Chip` + `ChipStrip`.
 *
 * A tone-aware pill button (Surfaces.jsx:40-84 `Chip`): optional leading icon,
 * a label, an optional brighter `value`, and an optional count `badge`. Quiet
 * by default (transparent, muted text); the tone tint appears on hover and when
 * `active`. Presentation only — the caller owns behaviour via `onClick`.
 *
 * `ChipStrip` is the generic horizontal layout container the composer/byline
 * rails compose (the prototype's dotted-separator grammar, Surfaces.jsx:751).
 * NB: the prototype's `ChipStrip` (Surfaces.jsx:746) is the *composer-specific*
 * rail (RunChip/ReasoningChip/PermChip/AccountChip/…), which is P4-0 composer
 * territory, not a reusable primitive — the shared-kit `ChipStrip` here is the
 * generic separator-aware row those chips live in. Flagged in the report.
 */

import { Children, Fragment, type ReactNode } from 'react'
import { toneClasses, type Tone } from './tone.js'

export type { Tone } from './tone.js'

export function Chip({
  icon,
  label,
  value,
  tone = 'default',
  active = false,
  badge,
  title,
  onClick,
}: {
  icon?: ReactNode
  label: ReactNode
  /** A brighter trailing value (e.g. a model name); rendered after the label. */
  value?: ReactNode
  tone?: Tone
  /** Pinned-on styling (the tint stays without a hover). */
  active?: boolean
  /** A small count pill (inverse tone fill). `0` is shown; omit to hide. */
  badge?: number | string
  title?: string
  onClick?: () => void
}) {
  const t = toneClasses(tone)
  // The prototype's Chip paints `accent` text/badge-fill with a lighter pink
  // (`#f9a8d4`, Surfaces.jsx:43 `color`) than the shared tone.ts `accent` entry
  // (`#f472b6`), which Banner/Toast correctly use at full strength
  // (Surfaces.jsx:792) — only Chip substitutes the soft variant, and only for
  // text/badge; its active/hover background+border tint stays the saturated
  // accent (Surfaces.jsx:43 `bg`/`border` are still rgba(244,114,182,...)).
  const chipText = tone === 'accent' ? 'text-accent-soft' : t.text
  const chipBadge = tone === 'accent' ? 'bg-accent-soft text-on-fill' : t.badge
  const className =
    'inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-medium transition-colors ' +
    `${chipText} ` +
    (active
      ? `${t.softBg} ${t.softBorder}`
      : `border-white/[0.06] bg-transparent ${t.hoverTint}`)
  const body = (
    <>
      {icon ? <span className="flex">{icon}</span> : null}
      <span>{label}</span>
      {value != null ? (
        <span className="font-semibold text-text-primary">{value}</span>
      ) : null}
      {badge != null ? (
        <span
          className={
            'ml-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold ' +
            chipBadge
          }
        >
          {badge}
        </span>
      ) : null}
    </>
  )
  // A chip with no `onClick` is a display indicator, not a control — render a
  // <span> so it doesn't land in the tab order as an inert, actionless button.
  if (!onClick) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    )
  }
  return (
    <button type="button" onClick={onClick} title={title} className={className}>
      {body}
    </button>
  )
}

/**
 * A horizontal row of chips. With `separated`, the prototype's faint `·`
 * dividers are interleaved between children (Surfaces.jsx:751 `Sep`).
 */
export function ChipStrip({
  children,
  separated = false,
  className = '',
}: {
  children: ReactNode
  separated?: boolean
  className?: string
}) {
  // Children.toArray already drops null/undefined/boolean children and assigns
  // each a stable key — no extra filtering needed. Index keys are safe here: the
  // strip is a static, positional row of stateless chips (nothing to preserve
  // across a reorder).
  const items = Children.toArray(children)
  return (
    <div
      className={`flex min-w-0 items-center gap-[7px] ${className}`.trimEnd()}
      role="group"
    >
      {separated
        ? items.map((child, index) => (
            <Fragment key={index}>
              {index > 0 ? <Separator /> : null}
              {child}
            </Fragment>
          ))
        : items}
    </div>
  )
}

function Separator() {
  return (
    <span
      className="shrink-0 select-none text-[12px] text-text-subtle/60"
      aria-hidden="true"
    >
      ·
    </span>
  )
}
