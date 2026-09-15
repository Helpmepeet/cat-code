/**
 * P4-1 shared primitive — `BannerStack` (Surfaces.jsx:786-833).
 *
 * Anchored, dismissable notices stacked as full-width bars (disconnect,
 * rate-limited, the P4-15 non-blocking reauth banner, …). Presentation +
 * a tiny stacking model only; the caller owns what a banner MEANS and what its
 * actions DO. P4-15's reauth banner is derived from P4-5 pool status and mounts
 * here — it is not pushed imperatively.
 *
 * Security: `title`/`detail`/action labels are untrusted model/status text and
 * render as text nodes (React escapes them) — never as HTML.
 */

import type { ReactNode } from 'react'
import { ActionWarningIcon } from './SessionActionIcons.js'
import { toneClasses, type Tone } from './tone.js'

/** The banner tones the prototype paints (Surfaces.jsx:788-793). */
export type BannerTone = 'danger' | 'warn' | 'info' | 'accent'

export type BannerAction = {
  /** Stable identity the caller switches on in `onAction`. */
  key: string
  label: string
  /** A filled call-to-action (e.g. "Re-authenticate"); else an outline button. */
  primary?: boolean
}

export type BannerNotice = {
  /** Stable identity — dedupe key for the stacking model and React key. */
  id: string
  tone: BannerTone
  title: string
  detail?: string
  actions?: BannerAction[]
  /** Defaults to true; a `false` banner (e.g. a hard gate) hides the ×. */
  dismissable?: boolean
}

/* ── presentation ─────────────────────────────────────────────────────────── */

const BANNER_TONE: Record<BannerTone, Tone> = {
  danger: 'danger',
  warn: 'warn',
  info: 'info',
  accent: 'accent',
}

/**
 * The prototype's Banner paints its icon with a saturated `accent` shade but
 * its title + non-primary action text with a distinctly lighter tint one step
 * up (Surfaces.jsx:789-793 `color` vs `accent`, title at :805, button at :814)
 * — `t.text` alone (shared with the icon) reads too saturated for those two.
 * No shared-token equivalent exists yet, so this is a literal per-tone map.
 */
const BANNER_SOFT_TEXT: Record<BannerTone, string> = {
  danger: 'text-[light-dark(#dc2626,#fca5a5)]',
  warn: 'text-[light-dark(#834a00,#fde68a)]',
  info: 'text-[light-dark(#1d4ed8,#bfdbfe)]',
  accent: 'text-[light-dark(#9d174d,#fbcfe8)]',
}

export function BannerStack({
  banners,
  onAction,
  onDismiss,
}: {
  banners: readonly BannerNotice[]
  onAction?: (banner: BannerNotice, action: BannerAction) => void
  onDismiss?: (banner: BannerNotice) => void
}) {
  if (banners.length === 0) return null
  return (
    <div className="shrink-0" role="region" aria-label="Notices">
      {banners.map(banner => (
        <BannerRow
          key={banner.id}
          banner={banner}
          onAction={onAction}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  )
}

function BannerRow({
  banner,
  onAction,
  onDismiss,
}: {
  banner: BannerNotice
  onAction?: (banner: BannerNotice, action: BannerAction) => void
  onDismiss?: (banner: BannerNotice) => void
}) {
  const t = toneClasses(BANNER_TONE[banner.tone])
  const softText = BANNER_SOFT_TEXT[banner.tone]
  const dismissable = banner.dismissable !== false
  return (
    <div
      className={`flex items-center gap-3 border-b px-[18px] py-[9px] text-[12.5px] ${t.softBg} ${t.softBorder}`}
      role="status"
    >
      <span className={`flex shrink-0 ${t.text}`} aria-hidden="true">
        {banner.tone === 'info' || banner.tone === 'accent' ? (
          <InfoIcon />
        ) : (
          <ActionWarningIcon size={13} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className={`font-semibold ${softText}`}>{banner.title}</span>
        {banner.detail ? (
          <span className="ml-2 text-text-muted">{banner.detail}</span>
        ) : null}
      </div>
      {(banner.actions ?? []).map(action => (
        <button
          key={action.key}
          type="button"
          onClick={() => onAction?.(banner, action)}
          className={
            'rounded-md px-[11px] py-1 text-[11.5px] font-semibold transition-colors ' +
            (action.primary
              ? t.badge
              : `border border-white/12 bg-transparent ${softText} hover:bg-white/5`)
          }
        >
          {action.label}
        </button>
      ))}
      {dismissable ? (
        <button
          type="button"
          onClick={() => onDismiss?.(banner)}
          title="Dismiss"
          aria-label={`Dismiss: ${banner.title}`}
          className="flex h-[22px] w-[22px] items-center justify-center rounded text-sm leading-none text-text-subtle transition-colors hover:text-text-primary"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

function InfoIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}
