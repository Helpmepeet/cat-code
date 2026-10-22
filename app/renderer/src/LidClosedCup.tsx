import { useId, useState } from 'react'
import { isNormalLidEnding, lidReason, countLabel, useLidClosed } from './lidClosedState.js'
import type { ComposerFaceProps } from './ComposerActionsBar.js'

const WAVE = 'M0 1q1.75-.9 3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0t3.5 0'

export function LidClosedCup({ faceProps }: { faceProps: ComposerFaceProps }) {
  const lid = useLidClosed()
  const id = useId()
  const [open, setOpen] = useState(false)
  if (!lid) return null
  const { view: v, command } = lid
  const active = v.phase === 'active'
  const pending = ['setup','starting','restoring'].includes(v.phase) || v.recovering === true
  const unexpectedEnd = v.phase === 'ended' && (!isNormalLidEnding(v.reason) || !!v.error)
  // Normal endings read as off; safety stops and errors keep the amber warning.
  const phase = v.phase === 'ended' && !unexpectedEnd ? 'off' : v.phase
  const fill = active ? 0.72 : 0
  const top = 27 - 17 * fill
  const shortcut = v.phase === 'unresolved' ? 'Retry restoration' : active ? 'Turn off' : 'Keep awake until all work finishes'
  const title = v.reason === 'no-work' || v.reason === 'work-finished' ? lidReason(v.reason)
    : v.phase === 'unavailable' && v.error ? v.error
    : unexpectedEnd ? `${lidReason(v.reason)}${v.error && v.reason !== 'sleep-unconfirmed' ? ' Sleep could not be confirmed. Check your Mac.' : ''}`
    : active ? `Keeping awake until all work finishes. ${countLabel(v.activeSessions, 'session')} and ${countLabel(v.activeSubagents, 'subagent')}${v.waitingForApproval ? '. Waiting for approval.' : ''}`
    : 'Keep awake until all work finishes'
  const inspect = (value: boolean) => { setOpen(value); lid.inspect(value) }
  const description = `${countLabel(v.activeSessions, 'session')} active; ${countLabel(v.activeSubagents, 'subagent')}${v.waitingForApproval ? '; waiting for approval' : ''}`
  const clip = `${id}-clip`
  return <span className={`lid-cup-slot lid-${phase}`}>
    <button {...faceProps} type="button" className="lid-cup" title={title}
      aria-label={active ? `Keeping awake until all work finishes. ${description}. Turn off.` : `${shortcut}. ${phase === 'ended' && v.reason === 'work-finished' ? lidReason(v.reason) : ''}`}
      aria-describedby={open ? `${id}-work` : undefined} aria-pressed={active} aria-disabled={pending}
      onFocus={() => { faceProps.onFocus(); inspect(true) }} onBlur={() => inspect(false)}
      onMouseEnter={() => inspect(true)} onMouseLeave={event => { if (event.currentTarget !== document.activeElement) inspect(false) }}
      onClick={() => {
        if (pending) return
        if (v.phase === 'unresolved') command({ action: 'retry' })
        else if (active) command({ action: 'stop' })
        else command({ action: 'start' })
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') { inspect(false); return }
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
        {active ? <><path className="lid-steam" d="M7 7c-3-3 3-3 0-6" /><path className="lid-steam lid-steam-late" d="M12 7c-3-3 3-3 0-6" /></> : null}
        {v.phase === 'unresolved' || unexpectedEnd ? <path className="lid-mark" d="M10 13v6 M10 22v1" /> : null}
        {v.phase === 'unavailable' ? <path className="lid-mark" d="M3 26L17 11" /> : null}
        {v.phase === 'restoring' ? <path className="lid-mark" d="M13 22a4 4 0 1 1 1-5 M14 14v4h-4" /> : null}
      </svg>
    </button>
    {open ? <span id={`${id}-work`} className="sr-only">{description}</span> : null}
  </span>
}
