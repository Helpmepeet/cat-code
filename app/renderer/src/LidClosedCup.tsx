import { useEffect, useId, useState } from 'react'
import { LID_PRESETS } from '../../shared/lidClosed.js'
import { isNormalLidEnding, lidFill, lidReason, countLabel, lidTarget, nextLidTarget, useLidClosed } from './lidClosedState.js'
import type { ComposerFaceProps } from './ComposerActionsBar.js'

const WAVE = 'M0 1q1.75-.9 3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0'

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
  const flush = lid?.flush
  useEffect(() => () => flush?.(), [flush])
  if (!lid) return null
  const { view: v, command } = lid
  const active = v.phase === 'active'
  const blocked = v.phase === 'restoring' || v.recovering === true
  const unexpectedEnd = v.phase === 'ended' && (!isNormalLidEnding(v.reason) || !!v.error)
  // Normal endings read as off; safety stops and errors keep the amber warning.
  const phase = v.phase === 'ended' && !unexpectedEnd ? 'off' : v.phase
  const timed = v.mode === 'timed' && ['active', 'starting', 'setup'].includes(v.phase)
  const minute = Math.ceil(v.remainingSeconds / 60)
  const fill = active ? v.mode === 'timed' ? lidFill(v.remainingSeconds / 60) : 0.72 : 0
  const top = 27 - 17 * fill
  const next = nextLidTarget(v, 'click')
  const nextText = `Next: ${next === 'off' ? 'turn off' : next === 'work' ? 'until all work finishes' : `${next} minutes`}`
  const counts = `${countLabel(v.activeSessions, 'session')} and ${countLabel(v.activeSubagents, 'subagent')}`
  const title = !unexpectedEnd && (v.reason === 'no-work' || v.reason === 'work-finished' || v.reason === 'expired') ? lidReason(v.reason)
    : v.phase === 'unavailable' && v.error ? v.error
    : unexpectedEnd ? `${lidReason(v.reason)}${v.error && v.reason !== 'sleep-unconfirmed' ? ' Sleep could not be confirmed. Check your Mac.' : ''}`
    : active ? v.mode === 'timed' ? `Keeping awake for ${minute} more minutes. ${nextText}`
      : `Keeping awake until all work finishes. ${counts}${v.waitingForApproval ? '. Waiting for approval.' : '.'} ${nextText}`
    : v.phase === 'unresolved' ? 'Normal sleep has not been restored. Retry recovery.'
    : timed ? `${v.allowance} minutes. ${nextText}`
    : ['starting', 'setup'].includes(v.phase) && v.mode === 'work' ? `Until all work finishes. ${nextText}`
    : next === 'work' ? 'Keep awake until all work finishes' : `Keep awake for ${next} minutes`
  const inspect = (value: boolean) => { setOpen(value); lid.inspect(value) }
  const description = timed ? active ? `${minute} minutes remaining of ${v.allowance}.` : `${v.allowance} minutes.`
    : `${countLabel(v.activeSessions, 'session')} active; ${countLabel(v.activeSubagents, 'subagent')}${v.waitingForApproval ? '; waiting for approval' : ''}`
  const currentLabel = active ? timed ? `Keeping awake for ${minute} more minutes.`
    : `Keeping awake until all work finishes. ${description}.`
    : timed ? `Keep awake for ${v.allowance} minutes.`
    : ['starting', 'setup'].includes(v.phase) && v.mode === 'work' ? 'Keep awake until all work finishes.'
    : 'Keep awake.'
  const step = (direction: 'click' | 'up' | 'down') => {
    if (blocked) return
    if (v.phase === 'unresolved') { command({ action: 'retry' }); return }
    const target = nextLidTarget(v, direction)
    if (target !== lidTarget(v)) lid.select(target)
  }
  const clip = `${id}-clip`
  return <span className={`lid-cup-slot lid-${phase}`}>
    <button {...faceProps} type="button" className="lid-cup" title={title}
      aria-label={v.phase === 'unresolved' ? 'Retry restoration' : `${currentLabel} ${nextText}.`}
      aria-describedby={open ? `${id}-work` : undefined} aria-pressed={active || v.phase === 'starting'} aria-disabled={blocked}
      onFocus={() => { faceProps.onFocus(); inspect(true) }} onBlur={() => { inspect(false); lid.flush() }}
      onMouseEnter={() => inspect(true)} onMouseLeave={event => { if (event.currentTarget !== document.activeElement) inspect(false) }}
      onClick={() => step('click')}
      onKeyDown={event => {
        if (event.key === 'Escape') { inspect(false); return }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); event.stopPropagation()
          step(event.key === 'ArrowUp' ? 'up' : 'down')
        }
      }}>
      <svg width={14} height={18} viewBox="0 0 24 30" fill="none" aria-hidden="true">
        <defs><clipPath id={clip}><path d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" /></clipPath></defs>
        {active ? <g clipPath={`url(#${clip})`}>
          <rect x="3" y={top} width="14" height={17 * fill} className="lid-liquid" />
          <svg x="3" y={top - 1} width="14" height="2" className="lid-surface" overflow="hidden">
            <g className="lid-wave">
              <path className="lid-wave-fill" d={`${WAVE}V2H0z`} />
              <path className="lid-crest" d={WAVE} />
            </g>
          </svg>
        </g> : null}
        <path className="lid-outline" d="M3 10h14v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z M17 12h2a4 4 0 0 1 0 8h-2" />
        {timed ? LID_PRESETS.map((tick, index) => <path key={tick} className={active && v.allowance === tick ? 'lid-tick selected' : 'lid-tick'} d={`M4 ${27 - 17 * (index + 1) / LID_PRESETS.length}h3`} />) : null}
        {active ? <><path className="lid-steam" d="M7 7c-3-3 3-3 0-6" /><path className="lid-steam lid-steam-late" d="M12 7c-3-3 3-3 0-6" /></> : null}
        {v.phase === 'unresolved' || unexpectedEnd ? <path className="lid-mark" d="M10 13v6 M10 22v1" /> : null}
        {v.phase === 'unavailable' ? <path className="lid-mark" d="M3 26L17 11" /> : null}
        {v.phase === 'restoring' ? <path className="lid-mark" d="M13 22a4 4 0 1 1 1-5 M14 14v4h-4" /> : null}
      </svg>
      <span className={timed ? 'lid-num lid-num-on' : 'lid-num'} aria-hidden="true"><span className="lid-num-clip">
        {timed ? <LidNumeral value={active ? minute : v.allowance} tone={!active ? 'starting' : minute <= 5 ? 'warn' : ''} /> : null}
      </span></span>
    </button>
    {open ? <span id={`${id}-work`} className="sr-only">{description}</span> : null}
  </span>
}
