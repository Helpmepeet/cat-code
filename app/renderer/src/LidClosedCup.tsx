import { useId, useRef, useState } from 'react'
import { LID_PRESETS } from '../../shared/lidClosed.js'
import { lidFill, lidReason, useLidClosed } from './lidClosedState.js'
import type { ComposerFaceProps } from './ComposerActionsBar.js'

export function LidClosedCup({ faceProps }: { faceProps: ComposerFaceProps }) {
  const lid = useLidClosed()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [selectedUntil, setSelectedUntil] = useState(0)
  const wheelAt = useRef(0)
  if (!lid) return null
  const { view: v, command } = lid
  const active = v.phase === 'active'
  const pending = ['setup','starting','restoring'].includes(v.phase) || v.recovering === true
  const minute = Math.ceil(v.remainingSeconds / 60)
  const shown = Date.now() < selectedUntil || v.phase === 'starting' ? v.allowance : minute
  const fill = active ? lidFill(v.remainingSeconds / 60) : 0
  const shortcut = v.phase === 'unresolved' ? 'Retry restoration' : active ? 'Adjust duration' : 'Start for 15 minutes'
  const unexpectedEnd = v.phase === 'ended' && (v.reason !== 'stopped' || !!v.error)
  // Without banners, the tooltip explains a refused start or an ending the user did not choose.
  const title = v.phase === 'unavailable' && v.error ? v.error
    : unexpectedEnd ? `${lidReason(v.reason)}${v.error ? ' Sleep could not be confirmed. Check your Mac.' : ''}`
    : 'Keep working with lid closed'
  const inspect = (value: boolean) => { setOpen(value); lid.inspect(value) }
  const adjust = (direction: number) => {
    if (pending || v.phase === 'unavailable' || v.phase === 'unresolved') return
    if (!active) { if (direction > 0) command({ action: 'start', minutes: 15 }); return }
    const index = LID_PRESETS.indexOf(v.allowance as typeof LID_PRESETS[number]) + direction
    if (index < 0 || index >= LID_PRESETS.length) command({ action: 'stop' })
    else { command({ action: 'adjust', minutes: LID_PRESETS[index]! }); setSelectedUntil(Date.now() + 1200) }
  }
  const drawing = (raised: boolean) => (
      <svg width={raised ? 34 : 14} height={raised ? 25 : 18} viewBox="0 0 24 30" fill="none" aria-hidden="true">
        <defs><clipPath id={`${id}-${raised ? 'raised' : 'rest'}-clip`}><path d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" /></clipPath></defs>
        <rect x="3" y={27 - 17 * fill} width="14" height={17 * fill} className="lid-liquid" clipPath={`url(#${id}-${raised ? 'raised' : 'rest'}-clip)`} />
        <path className="lid-outline" d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z M17 12h2a4 4 0 0 1 0 8h-2" />
        {LID_PRESETS.map((tick, i) => <path key={tick} className={v.allowance === tick && active ? 'lid-tick selected' : 'lid-tick'} d={`M4 ${23 - i * 4}h3`} />)}
        {active ? <path className="lid-steam" d="M7 7c-3-3 3-3 0-6 M12 7c-3-3 3-3 0-6" /> : null}
        {v.phase === 'unresolved' || unexpectedEnd ? <path className="lid-mark" d="M10 13v6 M10 22v1" /> : null}
        {v.phase === 'unavailable' ? <path className="lid-mark" d="M3 26L17 11" /> : null}
        {v.phase === 'restoring' ? <path className="lid-mark" d="M13 22a4 4 0 1 1 1-5 M14 14v4h-4" /> : null}
      </svg>
  )
  return <span className={`lid-cup-slot lid-${v.phase}`}>
    <button {...faceProps} type="button" className="lid-cup" title={title}
      aria-label={`Keep working with lid closed: ${v.phase}. ${shortcut}. Keeps the whole Mac awake.`}
      aria-describedby={open ? `${id}-time` : undefined} aria-disabled={pending || v.phase === 'unavailable'}
      onFocus={() => { faceProps.onFocus(); inspect(true) }} onBlur={() => inspect(false)}
      onMouseEnter={() => inspect(true)} onMouseLeave={event => { if (event.currentTarget !== document.activeElement) inspect(false) }}
      onClick={() => {
        if (pending) return
        if (v.phase === 'unresolved') command({ action: 'retry' })
        else adjust(1)
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') { inspect(false); return }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); adjust(event.key === 'ArrowUp' ? 1 : -1) }
      }}
      onWheel={event => {
        // Wheel requires keyboard/click focus and an active mode. Incidental
        // scrolling can neither activate a dormant cup nor race through presets.
        if (!active || document.activeElement !== event.currentTarget || performance.now() - wheelAt.current < 650 || Math.abs(event.deltaY) < 12) return
        event.preventDefault(); wheelAt.current = performance.now(); adjust(event.deltaY < 0 ? 1 : -1)
      }}>
      {drawing(false)}
    </button>
    {open ? <span className="lid-number" aria-hidden="true">{drawing(true)}<span>{shown}<small>min</small></span></span> : null}
    {open ? <span id={`${id}-time`} className="sr-only">{v.allowance} minutes total; {minute} minutes remaining.</span> : null}
  </span>
}
