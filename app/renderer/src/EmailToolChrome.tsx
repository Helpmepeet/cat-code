import { Fragment, useContext, useId, type ReactNode } from 'react'
import { useToolCardExpanded } from './toolCardExpansion.js'
import type { EmailDiscoveryEntry } from './emailToolDiscovery.js'
import { AutoModeReviewMark, AutoModeReviewReason } from './AutoModeReviewMark.js'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { ToolCardStyleContext, TOOL_CARD_SHELL_CLASS } from './toolCardStyle.js'
import './emailTools.css'

export function EmailProviderIcon({ provider }: { provider: 'gmail' | 'outlook' }) {
  return provider === 'gmail' ? (
    <svg className="email-provider-icon" data-provider="gmail" viewBox="0 0 24 18" aria-hidden="true">
      <path fill="#4285f4" d="M1.5 18H5V7L0 3.2V16.5A1.5 1.5 0 0 0 1.5 18Z" />
      <path fill="#34a853" d="M19 18h3.5a1.5 1.5 0 0 0 1.5-1.5V3.2L19 7Z" />
      <path fill="#ea4335" d="M5 7V.8l7 5.25L19 .8V7l-7 5.25Z" />
      <path fill="#fbbc04" d="M19 .8V7l5-3.8V2a2 2 0 0 0-3.2-1.6Z" />
      <path fill="#c5221f" d="M0 2v1.2L5 7V.8L3.2.4A2 2 0 0 0 0 2Z" />
    </svg>
  ) : (
    <svg className="email-provider-icon" data-provider="outlook" viewBox="0 0 20 18" aria-hidden="true">
      <path fill="#1684d9" d="M7 2h11v13H7z" />
      <path fill="#47a5eb" d="m7 6 6 4 6-4v10H7z" />
      <path fill="#86ccf9" d="m7 6 6 4 6-4-6-4z" />
      <path fill="#0b65bb" d="M0 3h11v13H0z" />
      <path fill="none" stroke="#fff" strokeWidth="1.4" d="M7.7 9.5c0 2-1 3.2-2.2 3.2s-2.2-1.2-2.2-3.2 1-3.2 2.2-3.2 2.2 1.2 2.2 3.2Z" />
    </svg>
  )
}

export function EmailToolChevron() {
  return <svg className="email-tool-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
}

export function EmailToolDiscovery({ row, entries, defaultExpanded, originalOutput }: {
  row: NestedToolUseRow
  entries: readonly EmailDiscoveryEntry[]
  defaultExpanded: boolean
  originalOutput?: ReactNode
}) {
  const { style } = useContext(ToolCardStyleContext)
  const failed = row.status === 'error' || row.result?.isError === true
  const ready = row.status === 'success' && !failed
  const [expanded, setExpanded] = useToolCardExpanded(row.toolUseId, defaultExpanded || failed || row.status === 'cancelled')
  const bodyId = useId()
  const providers = [...new Set(entries.map(entry => entry.provider === 'gmail' ? 'Gmail' : 'Outlook'))]
  return (
    <div className={`${TOOL_CARD_SHELL_CLASS[style]} email-tool-discovery`} data-style={style}>
      <button type="button" className="email-discovery-head" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>
        <svg className="email-discovery-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><circle cx="6.5" cy="6.5" r="3.75" /><path d="m9.4 9.4 3.6 3.6" /></svg>
        <span>{ready ? 'Email tools ready' : row.status === 'cancelled' ? 'Email tool loading cancelled' : failed ? 'Email tools unavailable' : 'Loading email tools'}</span>
        <span className="email-discovery-providers">{providers.join(' · ')}</span>
        <AutoModeReviewMark review={row.autoModeReview} />
        <EmailToolChevron />
      </button>
      {expanded ? <div id={bodyId}><AutoModeReviewReason review={row.autoModeReview} />{ready ? <dl className="email-discovery-list">
        {entries.map((entry, index) => <Fragment key={`${entry.provider}:${entry.label}:${index}`}>
          <dt><EmailProviderIcon provider={entry.provider} />{entry.provider === 'gmail' ? 'Gmail' : 'Outlook'}</dt>
          <dd>{entry.label}</dd>
        </Fragment>)}
      </dl> : <div className="email-tool-body email-status">{originalOutput ?? (row.status === 'cancelled' ? 'Tool loading was stopped.' : failed ? 'Email tools couldn’t be loaded.' : 'Waiting for email tools.')}</div>}</div> : null}
    </div>
  )
}
