import { Fragment, useContext, useId, useMemo, type ReactNode } from 'react'
import type { NestedToolUseRow } from './transcriptProjector.js'
import { parseEmailToolPresentation, type EmailMessage, type EmailToolIdentity, type EmailToolPresentation } from './emailToolPresentation.js'
import { useToolCardExpanded } from './toolCardExpansion.js'
import { ToolCardStyleContext, TOOL_CARD_SHELL_CLASS } from './toolCardStyle.js'
import { AutoModeReviewMark, AutoModeReviewReason } from './AutoModeReviewMark.js'
import { EmailProviderIcon, EmailToolChevron } from './EmailToolChrome.js'
import './emailTools.css'

type PresentationProps = {
  row: NestedToolUseRow
  identity: EmailToolIdentity
  defaultExpanded: boolean
  originalOutput: ReactNode
}

function readableSender(value: string | undefined): string {
  if (!value?.trim()) return 'Unknown sender'
  const name = /^\s*(.*?)\s*<[^<>\r\n]+>\s*$/.exec(value)?.[1]?.trim()
  return name ? name.replace(/^"(.*)"$/, '$1') : value
}

function labelName(label: string): string {
  const names: Readonly<Record<string, string>> = {
    INBOX: 'Inbox', SENT: 'Sent', UNREAD: 'Unread', DRAFT: 'Drafts', SPAM: 'Spam', TRASH: 'Trash',
    STARRED: 'Starred', IMPORTANT: 'Important', CATEGORY_PERSONAL: 'Personal', CATEGORY_SOCIAL: 'Social',
    CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_UPDATES: 'Updates', CATEGORY_FORUMS: 'Forums',
  }
  return Object.hasOwn(names, label) ? names[label]! : label
}

function headerName(name: string): string {
  const names: Readonly<Record<string, string>> = { reply_to: 'Reply to', message_id: 'Message ID', in_reply_to: 'In reply to', references: 'References' }
  const key = name.toLowerCase().replaceAll('-', '_')
  return Object.hasOwn(names, key) ? names[key]! : name
}

function attachmentType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const names: Readonly<Record<string, string>> = {
    'application/pdf': 'PDF', 'text/plain': 'Text', 'text/csv': 'CSV', 'image/png': 'PNG', 'image/jpeg': 'JPEG',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document',
  }
  return Object.hasOwn(names, value) ? names[value]! : value
}

function messageDate(message: EmailMessage): { day?: string; time?: string; full?: string } {
  for (const value of [message.internalDateIso, message.date]) {
    if (!value) continue
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value)
    if (match && Number.isFinite(Date.parse(`${match[1]}T${match[2]}:00Z`))) {
      return { day: match[1], time: match[2], full: `${match[1]}, ${match[2]}` }
    }
  }
  const timestamp = message.internalDate ?? (message.date ? Date.parse(message.date) : NaN)
  if (!Number.isFinite(timestamp)) return {}
  const date = new Date(timestamp)
  const year = date.getFullYear(), month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0')
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return { day: `${year}-${month}-${day}`, time, full: `${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}, ${time}` }
}

function sharedDate(messages: readonly EmailMessage[]): string | undefined {
  const days = messages.map(message => messageDate(message).day)
  if (!days[0] || days.some(day => day !== days[0])) return undefined
  return new Date(`${days[0]}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function htmlText(value: string): string | undefined {
  if (typeof document === 'undefined' || value.length > 200_000 || (value.match(/</g)?.length ?? 0) > 10_000) return undefined
  // Template contents never enter the document: no scripts, images or custom
  // elements become active while making a plain-text preview.
  const template = document.createElement('template')
  template.innerHTML = value
  const nodes = template.content.querySelectorAll('*')
  if (nodes.length > 10_000) return undefined
  for (const node of template.content.querySelectorAll('script,style,iframe,object,embed,svg,math,template')) node.remove()
  for (const node of template.content.querySelectorAll('br')) node.replaceWith(document.createTextNode('\n'))
  for (const node of template.content.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote')) node.append(document.createTextNode('\n'))
  return template.content.textContent?.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function EmailFields({ values }: { values: readonly (readonly [string, string | undefined])[] }) {
  return <dl className="email-fields">{values.filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}</dl>
}

function EmailStatus({ title, detail, failed = false }: { title: string; detail?: string; failed?: boolean }) {
  return <div className="email-status" data-tone={failed ? 'error' : undefined}><p>{title}</p>{detail ? <p className="email-secondary">{detail}</p> : null}</div>
}

function MessageBody({ message }: { message: EmailMessage }) {
  const body = useMemo(() => message.bodyFormat === 'html' && message.body ? htmlText(message.body) : message.body, [message.body, message.bodyFormat])
  const standard = new Set(['from', 'to', 'cc', 'bcc', 'date', 'subject'])
  const additionalHeaders = Object.entries(message.headers).filter(([name, value]) => value && !standard.has(name.toLowerCase().replaceAll('-', '_'))).map(([name, value]) => [headerName(name), value] as const)
  return <>
    <EmailFields values={[
      ['From', message.from], ['To', message.to], ['Cc', message.cc], ['Bcc', message.bcc],
      ['Date', messageDate(message).full ?? message.date],
      ['Labels', message.labels?.map(labelName).join(' · ')],
      ...additionalHeaders,
    ]} />
    {body ? <div className="email-body">{body}</div> : message.bodyFormat === 'html' && body === undefined ? <EmailStatus title="HTML message preview isn’t available." detail="Original output is available below." /> : message.body !== undefined || !message.snippet ? <EmailStatus title="No readable message body returned." /> : <div className="email-body">{message.snippet}<p className="email-secondary">Message excerpt</p></div>}
    {message.attachments.length ? <ul className="email-attachments">{message.attachments.map((attachment, index) => {
      const filename = typeof attachment.filename === 'string' && attachment.filename ? attachment.filename : 'Unnamed attachment'
      const size = typeof attachment.sizeHuman === 'string' ? attachment.sizeHuman : undefined
      const type = attachmentType(attachment.mimeType)
      return <li key={index}><span>{filename}</span><small>{[size, type].filter(Boolean).join(' · ')}</small></li>
    })}</ul> : null}
  </>
}

function EmailMessageRow({ message, toolUseId, index, thread = false, defaultExpanded = false }: {
  message: EmailMessage; toolUseId: string; index: number; thread?: boolean; defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useToolCardExpanded(`${toolUseId}:email-message:${message.id ?? index}:${index}`, defaultExpanded)
  const id = useId()
  const sender = readableSender(message.from)
  const subject = message.subject || '(No subject)'
  const time = messageDate(message).time
  return <div className="email-message">
    <button type="button" className="email-message-head" data-read={message.unread === undefined ? undefined : String(!message.unread)} aria-expanded={expanded} aria-controls={id}
      aria-label={`${message.unread ? 'Unread · ' : ''}${sender} · ${subject} · ${time ?? 'Time unavailable'}`} onClick={() => setExpanded(!expanded)}>
      <span className="email-message-sender" title={message.from ?? sender}>{sender}</span>
      <time className="email-message-time" dateTime={message.internalDateIso}>{time}</time>
      <span className="email-message-subject" title={subject}>{thread && !message.subject ? 'Message' : subject}</span>
    </button>
    {expanded ? <div className="email-message-detail" id={id}><MessageBody message={message} /></div> : null}
  </div>
}

function EmailMessages({ messages, toolUseId, thread = false }: { messages: readonly EmailMessage[]; toolUseId: string; thread?: boolean }) {
  return <div className="email-message-list">{messages.map((message, index) => <EmailMessageRow key={`${message.id ?? index}:${index}`} message={message} toolUseId={toolUseId} index={index} thread={thread} />)}</div>
}

function resultSummary(model: EmailToolPresentation): string {
  switch (model.kind) {
    case 'search': return `${model.messages.length} ${model.messages.length === 1 ? 'email' : 'emails'}${model.hasMore || model.nextPageToken ? ' · more available' : ''}`
    case 'message': return 'Email'
    case 'thread': return `${model.messages.length} ${model.messages.length === 1 ? 'message' : 'messages'}`
    case 'labels': return `${model.labels.length} ${model.labels.length === 1 ? 'label' : 'labels'}`
    case 'send': return 'Email sent'
    case 'accounts': return 'No connected accounts'
    case 'dry-run': return 'Dry run'
    case 'failure': return model.timedOut ? 'Request timed out' : 'Request failed'
    case 'unknown': return model.reason === 'Truncated output' ? 'Incomplete output' : model.originalContent ? 'Tool output' : 'No output'
  }
}

function ResultBody({ model, row }: { model: EmailToolPresentation; row: NestedToolUseRow }) {
  switch (model.kind) {
    case 'search': {
      if (!model.messages.length) return <EmailStatus title="No emails match this search." />
      const unreadKnown = model.messages.every(message => message.unread !== undefined)
      const unread = model.messages.filter(message => message.unread).length
      return <>
        <div className="email-tool-meta"><span>{sharedDate(model.messages) ?? `${model.messages.length} emails`}</span>{unreadKnown ? <span>{unread} unread</span> : null}</div>
        <EmailMessages messages={model.messages} toolUseId={row.toolUseId} />
        {model.hasMore || model.nextPageToken ? <p className="email-tool-more">{model.messages.length} emails shown · More results available</p> : null}
      </>
    }
    case 'message': return <><h3 className="email-title">{model.message.subject || '(No subject)'}</h3><MessageBody message={model.message} /></>
    case 'thread': return model.messages.length ? <><h3 className="email-title">{model.messages.find(message => message.subject)?.subject || '(No subject)'}</h3><EmailMessages messages={model.messages} toolUseId={row.toolUseId} thread /></> : <EmailStatus title="No messages returned in this conversation." />
    case 'labels': return model.labels.length ? <ul className="email-label-list">{model.labels.map((label, index) => <li key={index}>
      <span className="email-label-name">{typeof label.name === 'string' ? label.name : 'Unnamed label'}</span>
      {label.type === 'system' || label.type === 'user' ? <span className="email-label-kind">{label.type === 'system' ? 'System' : 'Custom'}</span> : null}
      <span className="email-label-id">{typeof label.id === 'string' ? label.id : ''}</span>
    </li>)}</ul> : <EmailStatus title="No labels returned." />
    case 'send': return <><p className="email-sent"><span className="email-sent-check" aria-hidden="true">✓</span>Email sent</p><EmailFields values={[
      ['From', model.from], ['Message', model.messageId], ['Thread', model.threadId],
    ]} /></>
    case 'dry-run': return <><EmailStatus title="Email not sent." detail="This request was a preview only." /><EmailFields values={['from', 'to', 'cc', 'bcc', 'subject'].map(name => [name === 'subject' ? 'Subject' : name[0]!.toUpperCase() + name.slice(1), typeof model.request[name] === 'string' ? model.request[name] as string : undefined] as const)} /></>
    case 'accounts': return null
    case 'failure': return <EmailStatus failed title={model.timedOut ? 'Gmail didn’t finish within the time limit.' : 'The email request failed.'} detail={model.identity?.operation === 'send' ? 'Delivery isn’t confirmed. Check Sent before trying again.' : 'No complete result is available.'} />
    case 'unknown': return <EmailStatus title={model.reason === 'Truncated output' ? 'Only part of the tool output was returned.' : model.originalContent ? 'This result doesn’t have a supported format.' : 'The tool returned no output.'} detail={model.identity?.operation === 'send' ? 'Delivery isn’t confirmed.' : 'Original output is available below.'} />
  }
}

export function EmailToolResult({ row, identity, defaultExpanded, originalOutput }: PresentationProps) {
  const { style } = useContext(ToolCardStyleContext)
  const model = useMemo(() => parseEmailToolPresentation(row.toolName, row.input, row.result?.content ?? ''), [row.toolName, row.input, row.result?.content])
  const failed = row.status === 'error' || row.result?.isError === true
  const [expanded, setExpanded] = useToolCardExpanded(row.toolUseId, defaultExpanded || failed)
  const [originalExpanded, setOriginalExpanded] = useToolCardExpanded(`${row.toolUseId}:email-original`, false)
  const bodyId = useId(), originalId = useId()
  const summary = row.status === 'pending' ? 'Waiting…' : row.status === 'cancelled' ? identity.operation === 'send' ? 'Send interrupted' : 'Cancelled' : failed ? model.kind === 'failure' && model.timedOut ? 'Request timed out' : 'Request failed' : resultSummary(model)
  const settled = row.status !== 'pending' && row.status !== 'cancelled'
  return <div className={`${TOOL_CARD_SHELL_CLASS[style]} email-tool`} data-style={style} data-operation={identity.operation}>
    <button type="button" className="email-tool-head" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>
      <EmailProviderIcon provider={identity.provider} /><span className="email-tool-title">{identity.provider === 'gmail' ? 'Gmail' : 'Outlook'}</span>
      <span className="email-tool-summary">{summary}</span><AutoModeReviewMark review={row.autoModeReview} /><EmailToolChevron />
    </button>
    {expanded ? <div className="email-tool-body" id={bodyId}>
      <AutoModeReviewReason review={row.autoModeReview} />
      {row.status === 'pending' ? <EmailStatus title="Waiting for the email request to finish." /> : row.status === 'cancelled' ? <EmailStatus title={identity.operation === 'send' ? 'Send interrupted.' : 'Request cancelled.'} detail={identity.operation === 'send' ? 'Delivery isn’t confirmed. Check Sent before trying again.' : undefined} /> : failed && model.kind !== 'failure' ? <EmailStatus failed title="The email request failed." detail={identity.operation === 'send' ? 'Delivery isn’t confirmed. Check Sent before trying again.' : 'Original output is available below.'} /> : <ResultBody model={model} row={row} />}
      {settled && model.warnings.length ? <p className="email-tool-warning">Some details couldn’t be shown. Original output is available below.</p> : null}
      {row.result ? <div className="email-original">
        <button type="button" className="email-original-head" aria-expanded={originalExpanded} aria-controls={originalId} onClick={() => setOriginalExpanded(!originalExpanded)}><EmailToolChevron />Original output</button>
        {originalExpanded ? <div className="email-original-body" id={originalId}>{originalOutput}</div> : null}
      </div> : null}
    </div> : null}
  </div>
}
