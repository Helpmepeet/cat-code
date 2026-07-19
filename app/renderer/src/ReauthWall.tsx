/**
 * P4-15 revision — the MERGED all-dead reauth wall (operator findings #1/#2/#8;
 * revises `decisions/STARTUP-GATES.md §3` + its 2026-07-12 P4-24 note).
 *
 * When EVERY Codex account is token-dead the pool is process-global, so all
 * sessions re-derive the identical wall. Instead of one banner per dead account
 * (five identical pool-level sentences) this renders ONE consolidated surface:
 * the pool-level "new turns are blocked" sentence stated ONCE, then a row per
 * dead account carrying its OWN real reason + a per-account re-authenticate
 * action. Acknowledging COLLAPSES it to a persistent compact chip — turns are
 * genuinely still blocked, so it is never fully hidden, only minimized, and the
 * reason stays one click away (`onExpand`). The caller persists the acknowledge
 * keyed to the pool-dead state, so switching sessions does not re-nag. Submit
 * stays blocked at zero-healthy regardless (`selectAuthSubmitBlocked`).
 *
 * Presentation only; reuses the P4-1 `BannerStack` danger visual grammar
 * (`tone.ts`). `title` / `summary` / reasons / labels are untrusted pool status
 * and render as text nodes (React escapes them) — never as HTML.
 */

import type { ReactNode } from 'react'
import { toneClasses } from './tone.js'
import type { ReauthWall as ReauthWallModel } from './reauthBannerState.js'

/**
 * The softer danger tint `BannerStack` paints titles/labels with (its private
 * `BANNER_SOFT_TEXT` map) — a literal, JIT-safe class (interpolated
 * arbitrary-value classes are forbidden; Tailwind v4 silently drops them).
 */
const DANGER_SOFT_TEXT = 'text-[#fca5a5]'

/** Outline-button classes shared by the Collapse / Show-details controls. */
const OUTLINE_BUTTON =
  'shrink-0 rounded-md border border-white/12 bg-transparent px-[11px] py-1 text-[11.5px] font-semibold text-text-muted transition-colors hover:bg-white/5'

export function ReauthWall({
  wall,
  collapsed,
  onReauth,
  onAcknowledge,
  onExpand,
}: {
  wall: ReauthWallModel
  /** The acknowledged (persisted) state → render the minimal collapsed chip. */
  collapsed: boolean
  /** Launch the shared OAuth reauth flow. The pool is global, so re-linking any
   *  account revives it; the id is passed for honest per-row structure and
   *  future scoping, but the caller may ignore it. */
  onReauth: (accountId: string) => void
  /** Acknowledge → collapse to the minimal indicator (persisted by the caller). */
  onAcknowledge: () => void
  /** Re-expand the collapsed indicator back to the full wall. */
  onExpand: () => void
}): ReactNode {
  const t = toneClasses('danger')

  if (collapsed) {
    return (
      <div
        className={`flex items-center gap-3 border-b px-[18px] py-[7px] text-[12px] ${t.softBg} ${t.softBorder}`}
        role="status"
      >
        <span className={`flex shrink-0 ${t.text}`} aria-hidden="true">
          <AlertIcon />
        </span>
        <span className={`min-w-0 flex-1 font-semibold ${DANGER_SOFT_TEXT}`}>
          {wall.collapsedLabel}
        </span>
        <button
          type="button"
          onClick={() => onReauth(wall.accounts[0]?.id ?? '')}
          className={`shrink-0 rounded-md px-[11px] py-1 text-[11.5px] font-semibold transition-colors ${t.badge}`}
        >
          Re-authenticate
        </button>
        <button
          type="button"
          onClick={onExpand}
          aria-label="Show which accounts are blocked"
          className={OUTLINE_BUTTON}
        >
          Show details
        </button>
      </div>
    )
  }

  return (
    <div
      className={`border-b px-[18px] py-[10px] text-[12.5px] ${t.softBg} ${t.softBorder}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className={`mt-[2px] flex shrink-0 ${t.text}`} aria-hidden="true">
          <AlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className={`font-semibold ${DANGER_SOFT_TEXT}`}>{wall.title}</div>
          <div className="mt-0.5 text-text-muted">{wall.summary}</div>
        </div>
        <button
          type="button"
          onClick={onAcknowledge}
          title="Collapse"
          aria-label="Collapse to a minimal blocked indicator"
          className={OUTLINE_BUTTON}
        >
          Collapse
        </button>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5 pl-[25px]">
        {wall.accounts.map(account => (
          <li key={account.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <span className={`font-semibold ${DANGER_SOFT_TEXT}`}>
                {account.label}
              </span>
              <span className="ml-2 text-text-muted">{account.reason}</span>
            </div>
            <button
              type="button"
              onClick={() => onReauth(account.id)}
              className={`shrink-0 rounded-md px-[11px] py-1 text-[11.5px] font-semibold transition-colors ${t.badge}`}
            >
              Re-authenticate
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Same triangle-alert glyph `BannerStack` paints for danger/warn tones. */
function AlertIcon(): ReactNode {
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
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
