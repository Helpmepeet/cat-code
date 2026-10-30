import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AutoModeReview } from '../../../src/app-runtime/autoModeReviewContract.js'
import { summarizeAutoModeReviews, type ReviewSummary } from './autoModeReview.js'
import './autoModeReview.css'

export function AutoModeReviewMark({ review, summary = review ? summarizeAutoModeReviews([review]) : null }: { review?: AutoModeReview; summary?: ReviewSummary | null }) {
  const [visible, setVisible] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLSpanElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    if (!visible || !anchor.current || !tooltip.current) return
    const rect = anchor.current.getBoundingClientRect()
    const box = tooltip.current.getBoundingClientRect()
    const y = rect.bottom + 2 + box.height > window.innerHeight - 8 ? rect.top - box.height - 2 : rect.bottom + 2
    tooltip.current.style.setProperty('--review-tip-x', `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`)
    tooltip.current.style.setProperty('--review-tip-y', `${Math.max(8, y)}px`)
  }, [visible, summary?.text])
  useEffect(() => {
    if (!visible) return
    const hide = () => setVisible(false)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide) }
  }, [visible])
  if (!summary) return null
  return <>
    <span ref={anchor} className="auto-mode-review" data-outcome={summary.outcome} role="img" aria-label={summary.text}
      aria-describedby={visible ? id : undefined} tabIndex={0}
      onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)} onBlur={() => setVisible(false)} onKeyDown={event => { if (event.key === 'Escape') setVisible(false) }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l7 3v5c0 4.5-3 7.8-7 10-4-2.2-7-5.5-7-10V6z" />
        {summary.outcome === 'allowed' ? <path d="m9 12 2 2 4-4" /> : summary.outcome === 'blocked' ? <path d="m10 10 4 4m0-4-4 4" /> : null}
      </svg>
      {summary.count > 1 ? summary.count : null}
    </span>
    {visible && typeof document !== 'undefined' ? createPortal(<span ref={tooltip} id={id} role="tooltip" className="auto-mode-review-tooltip">{summary.text}</span>, document.body) : null}
  </>
}

export function AutoModeReviewReason({ review }: { review?: AutoModeReview }) {
  if (!review?.reason) return null
  return <div className="auto-mode-review-field"><div className="auto-mode-review-label">Auto mode</div><div className="auto-mode-review-value">{review.reason}</div></div>
}
