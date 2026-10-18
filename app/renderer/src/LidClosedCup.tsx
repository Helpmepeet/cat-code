import { useId, useRef, useState } from 'react'
import { LID_PRESETS } from '../../shared/lidClosed.js'
import { lidFill, lidReason, useLidClosed } from './lidClosedState.js'
import type { ComposerFaceProps } from './ComposerActionsBar.js'

const WAVE = 'M0 1q1.75-.9 3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0'

// The old value slides out while the new one slides in, up when the value rises and down when it falls.
function LidNumeral({ value, tone }: { value: number; tone: string }) {
  const [last, setLast] = useState({ value, from: value, dir: 0, n: 0 })
  if (last.value !== value) setLast({ value, from: last.value, dir: value > last.value ? 1 : -1, n: last.n + 1 })
  const moving = last.dir !== 0 && last.from !== value
  return <span className={`lid-digits ${tone}`} data-dir={last.dir > 0 ? 'up' : 'down'}>
    {moving ? <span key={`out${last.n}`} className="lid-digit lid-digit-out" aria-hidden="true">{last.from}</span> : null}
    <span key={`in${last.n}`} className={moving ? 'lid-digit lid-digit-in' : 'lid-digit'}>{value}</span>
  </span>
}

export function LidClosedCup({ faceProps }: { faceProps: ComposerFaceProps }) {
  const lid = useLidClosed()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [selectedUntil, setSelectedUntil] = useState(0)
  const [adjustDir, setAdjustDir] = useState(0)
  const [slosh, setSlosh] = useState(0)
  const wheelAt = useRef(0)
  if (!lid) return null
  const { view: v, command } = lid
  const active = v.phase === 'active'
  const pending = ['setup','starting','restoring'].includes(v.phase) || v.recovering === true
  const minute = Math.ceil(v.remainingSeconds / 60)
  const adjusting = Date.now() < selectedUntil
  const shown = adjusting || v.phase === 'starting' ? v.allowance : minute
  const unexpectedEnd = v.phase === 'ended' && (!['stopped', 'expired', 'sleep-requested'].includes(v.reason ?? '') || !!v.error)
  // Normal endings read as off; safety stops and errors keep the amber warning.
  const phase = v.phase === 'ended' && !unexpectedEnd ? 'off' : v.phase
  const showNumeral = active || v.phase === 'starting'
  const fill = active ? lidFill(v.remainingSeconds / 60) : 0
  const top = 27 - 17 * fill
  const shortcut = v.phase === 'unresolved' ? 'Retry restoration' : active ? 'Adjust duration' : `Start for ${LID_PRESETS[0]} minutes`
  // Without banners, the tooltip explains a refused start or an ending the user did not choose.
  const title = v.phase === 'unavailable' && v.error ? v.error
    : unexpectedEnd ? `${lidReason(v.reason)}${v.error && v.reason !== 'sleep-unconfirmed' ? ' Sleep could not be confirmed. Check your Mac.' : ''}`
    : 'Keep working with lid closed'
  const inspect = (value: boolean) => { setOpen(value); lid.inspect(value) }
  const adjust = (direction: number) => {
    // A refused start stays retryable; main rechecks the hardware on every start.
    if (pending || v.phase === 'unresolved') return
    if (!active) { if (direction > 0) command({ action: 'start', minutes: LID_PRESETS[0] }); return }
    const index = LID_PRESETS.indexOf(v.allowance as typeof LID_PRESETS[number]) + direction
    if (index < 0 || index >= LID_PRESETS.length) command({ action: 'stop' })
    else {
      command({ action: 'adjust', minutes: LID_PRESETS[index]! })
      setSelectedUntil(Date.now() + 1200); setAdjustDir(direction)
      if (direction > 0) setSlosh(count => count + 1)
    }
  }
  const clip = `${id}-clip`
  return <span className={`lid-cup-slot lid-${phase}${adjusting ? (adjustDir > 0 ? ' lid-adjust-up' : ' lid-adjust-down') : ''}`}>
    <button {...faceProps} type="button" className="lid-cup" title={title}
      aria-label={`Keep working with lid closed: ${phase}. ${shortcut}. Keeps the whole Mac awake.`}
      aria-describedby={open ? `${id}-time` : undefined} aria-disabled={pending}
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
      <svg width={14} height={18} viewBox="0 0 24 30" fill="none" aria-hidden="true">
        <defs><clipPath id={clip}><path d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" /></clipPath></defs>
        {active ? <g clipPath={`url(#${clip})`}>
          <rect x="3" y={top} width="14" height={17 * fill} className="lid-liquid" />
          <svg x="3" y={top - 1} width="14" height="2" className="lid-surface" overflow="hidden">
            <g key={slosh} className={slosh > 0 ? 'lid-wave lid-slosh' : 'lid-wave'}>
              <path className="lid-wave-fill" d={`${WAVE}V2H0z`} />
              <path className="lid-crest" d={WAVE} />
            </g>
          </svg>
        </g> : null}
        <path className="lid-outline" d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z M17 12h2a4 4 0 0 1 0 8h-2" />
        {LID_PRESETS.map((tick, i) => <path key={tick} className={v.allowance === tick && active ? 'lid-tick selected' : 'lid-tick'} d={`M4 ${27 - 17 * (i + 1) / LID_PRESETS.length}h3`} />)}
        {active ? <><path className="lid-steam" d="M7 7c-3-3 3-3 0-6" /><path className="lid-steam lid-steam-late" d="M12 7c-3-3 3-3 0-6" /></> : null}
        {v.phase === 'unresolved' || unexpectedEnd ? <path className="lid-mark" d="M10 13v6 M10 22v1" /> : null}
        {v.phase === 'unavailable' ? <path className="lid-mark" d="M3 26L17 11" /> : null}
        {v.phase === 'restoring' ? <path className="lid-mark" d="M13 22a4 4 0 1 1 1-5 M14 14v4h-4" /> : null}
      </svg>
      <span className={showNumeral ? 'lid-num lid-num-on' : 'lid-num'} aria-hidden="true"><span className="lid-num-clip">
        {showNumeral ? <LidNumeral value={shown} tone={v.phase === 'starting' ? 'starting' : active && minute <= 5 ? 'warn' : ''} /> : null}
      </span></span>
    </button>
    {open ? <span id={`${id}-time`} className="sr-only">{v.allowance} minutes total; {minute} minutes remaining.</span> : null}
  </span>
}
