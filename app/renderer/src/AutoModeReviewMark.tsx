import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'
import { AUTO_MODE_DECISION_LABELS, summarizeAutoModeReviews, visibleAutoModeReason, type ReviewSummary } from './autoModeReview.js'
import './autoModeReview.css'

function useReviewTooltip<T extends HTMLElement>(visible: boolean, text: string | undefined, hide: () => void) {
  const anchor = useRef<T>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    if (!visible || !anchor.current || !tooltip.current) return
    const rect = anchor.current.getBoundingClientRect()
    const box = tooltip.current.getBoundingClientRect()
    const y = rect.bottom + 2 + box.height > window.innerHeight - 8 ? rect.top - box.height - 2 : rect.bottom + 2
    tooltip.current.style.setProperty('--review-tip-x', `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`)
    tooltip.current.style.setProperty('--review-tip-y', `${Math.max(8, y)}px`)
  }, [visible, text])
  useEffect(() => {
    if (!visible) return
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide) }
  }, [visible, hide])
  return { anchor, tooltip, id }
}

function ReviewShield({ outcome, size = 13 }: { outcome?: ReviewSummary['outcome']; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 7.8-7 10-4-2.2-7-5.5-7-10V6z" />
      {outcome === 'allowed' ? <path d="m9 12 2 2 4-4" /> : outcome === 'blocked' ? <path d="m10 10 4 4m0-4-4 4" /> : null}
    </svg>
  )
}

export function AutoModeReviewMark({ review, summary = review ? summarizeAutoModeReviews([review]) : null }: { review?: AutoModeReview; summary?: ReviewSummary | null }) {
  const [visible, setVisible] = useState(false)
  const hide = useCallback(() => setVisible(false), [])
  const { anchor, tooltip, id } = useReviewTooltip<HTMLSpanElement>(visible, summary?.text, hide)
  if (!summary) return null
  return <>
    <span ref={anchor} className="auto-mode-review" data-outcome={summary.outcome} role="img" aria-label={summary.text}
      aria-describedby={visible ? id : undefined} tabIndex={0}
      onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} onKeyDown={event => { if (event.key === 'Escape') setVisible(false) }}>
      <ReviewShield outcome={summary.outcome} />
      {summary.count > 1 ? summary.count : null}
    </span>
    {visible && typeof document !== 'undefined' ? createPortal(<span ref={tooltip} id={id} role="tooltip" className="auto-mode-review-tooltip">{summary.text}</span>, document.body) : null}
  </>
}

export function PermissionReasonMark({ heading, reason }: { heading: string; reason: string }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const hide = useCallback(() => {
    setHovered(false)
    setFocused(false)
    setPinned(false)
  }, [])
  const visible = hovered || focused || pinned
  const { anchor, tooltip, id } = useReviewTooltip<HTMLButtonElement>(visible, heading + reason, hide)
  useEffect(() => {
    if (!visible) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A hover can open the tip while another control in the card has focus.
      const card = anchor.current?.closest('[role="alertdialog"]')
      if (event.target instanceof Node && card?.contains(event.target)) {
        event.preventDefault()
        event.stopPropagation()
      }
      hide()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [visible, anchor, hide])

  return <>
    <button
      ref={anchor}
      type="button"
      className="auto-mode-review permission-reason-mark"
      aria-label={heading}
      aria-expanded={visible}
      aria-describedby={visible ? id : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setPinned(false) }}
      onClick={() => { if (pinned) hide(); else setPinned(true) }}
    >
      <ReviewShield />
    </button>
    {visible && typeof document !== 'undefined' ? createPortal(
      <span ref={tooltip} id={id} role="tooltip" className="auto-mode-review-tooltip permission-reason-tooltip">
        <span>{heading}</span>
        <span className="permission-reason-text">{reason}</span>
      </span>,
      document.body,
    ) : null}
  </>
}

function ReviewVerdict({ outcome }: { outcome: keyof typeof AUTO_MODE_DECISION_LABELS }) {
  return <span className="auto-mode-review-verdict">
    <ReviewShield outcome={outcome} size={12} />
    <span className="auto-mode-review-label">{AUTO_MODE_DECISION_LABELS[outcome]}</span>
  </span>
}

export function AutoModeReviewReason({ review }: { review?: AutoModeReview }) {
  if (!review || review.outcome === 'allowed' || review.outcome === 'reviewing' || !review.reason) return null
  return <div className="auto-mode-review-field" data-outcome={review.outcome}>
    <ReviewVerdict outcome={review.outcome} />
    <div className="auto-mode-review-value">{review.reason}</div>
  </div>
}

function AllowedReviewFooter({ reason, fullWidth }: { reason: string; fullWidth: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const value = useRef<HTMLSpanElement>(null)
  return <button
    type="button"
    className={`auto-mode-review-footer${fullWidth ? ' auto-mode-review-footer-full' : ''}`}
    aria-expanded={expanded}
    onClick={() => {
      if (expanded) setExpanded(false)
      else if (value.current && value.current.scrollWidth > value.current.clientWidth) setExpanded(true)
    }}
  >
    <ReviewVerdict outcome="allowed" />
    <span className="auto-mode-review-value" ref={value}>{reason}</span>
  </button>
}

export function AutoModeReviewFooter({ review, fullWidth = false }: { review?: AutoModeReview; fullWidth?: boolean }) {
  const reason = visibleAutoModeReason(review)
  return review?.outcome === 'allowed' && reason
    ? <AllowedReviewFooter key={review.attemptId} reason={reason} fullWidth={fullWidth} />
    : null
}
