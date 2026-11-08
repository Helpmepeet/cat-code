import { BrowserGlobe } from './BrowserPane.js'
import { ComputerScreenIcon } from './ComputerPane.js'
import type { ScreenKind } from './screenActivityState.js'
import './screenActivity.css'

export function ScreenActivityChip({ kind, label, imageUrl, running, onClick }: {
  kind: ScreenKind
  label: string
  imageUrl?: string | null
  running: boolean
  onClick: () => void
}) {
  return <button type="button" className="screen-activity-chip" aria-label={`Show ${kind === 'computer' ? 'Computer' : label}`} onClick={onClick}>
    <span className="screen-activity-thumb">
      <span>{imageUrl ? <img src={imageUrl} alt="" /> : kind === 'computer' ? <ComputerScreenIcon /> : <BrowserGlobe />}</span>
      {running ? <i className="screen-activity-badge" aria-label="Running" /> : null}
    </span>
    <span className="screen-activity-label">{label}</span>
  </button>
}
