export type EmailToolIdentity = { provider: 'gmail' | 'outlook'; operation: 'search' | 'message' | 'thread' | 'labels' | 'send' | 'accounts' }
const tools: Record<string, EmailToolIdentity> = {
  mcp__gmail__gmail_search: { provider: 'gmail', operation: 'search' },
  mcp__gmail__gmail_get_message: { provider: 'gmail', operation: 'message' },
  mcp__gmail__gmail_get_thread: { provider: 'gmail', operation: 'thread' },
  mcp__gmail__gmail_list_labels: { provider: 'gmail', operation: 'labels' },
  mcp__gmail__gmail_send_message: { provider: 'gmail', operation: 'send' },
  'mcp__outlook__list-accounts': { provider: 'outlook', operation: 'accounts' },
}
export function getEmailToolIdentity(name: string): EmailToolIdentity | undefined {
  const value = Object.hasOwn(tools, name) ? tools[name] : undefined
  return value ? { ...value } : undefined
}
type JsonRecord = Record<string, unknown>
export type EmailMessage = {
  id?: string; threadId?: string; headers: Record<string, string>; subject?: string
  from?: string; to?: string; cc?: string; bcc?: string; date?: string
  internalDate?: number; internalDateIso?: string; snippet?: string; body?: string; bodyFormat?: 'text' | 'html'
  bodyParts?: { format: 'text' | 'html'; body: string }[]
  labels?: string[]; unread?: boolean; attachments: JsonRecord[]
}
type Base = { identity: EmailToolIdentity | undefined; originalContent: string; warnings: string[] }
export type EmailToolPresentation = Base & (
  | { kind: 'unknown'; reason: string }
  | { kind: 'failure'; exitCode: number; stderr?: string; timedOut: boolean }
  | { kind: 'dry-run'; request: JsonRecord }
  | { kind: 'search'; messages: EmailMessage[]; pageCount?: number; hasMore?: boolean; nextPageToken?: string }
  | { kind: 'message'; message: EmailMessage }
  | { kind: 'thread'; id?: string; messages: EmailMessage[] }
  | { kind: 'labels'; labels: JsonRecord[] }
  | { kind: 'send'; messageId: string; threadId?: string; from?: string }
  | { kind: 'accounts'; accounts: []; count: 0; tip?: string }
)
const record = (v: unknown): v is JsonRecord => v !== null && typeof v === 'object' && !Array.isArray(v)
// Only complete paired wrappers are metadata. Inline markers are email text.
function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const match = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"\r\n]+)">>>\r?\n([\s\S]*)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>$/.exec(v)
  if (!match) return v
  return match[2]!.replace(/^Source: google_api\r?\n---\r?\n/, '')
}
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === 'string') }
function message(value: unknown, warnings: string[], curated?: unknown): EmailMessage | undefined {
  if (!record(value)) return undefined
  const headers: Record<string, string> = Object.create(null)
  const payload = record(value.payload) ? value.payload : undefined
  if (payload && Array.isArray(payload.headers)) {
    if (payload.headers.length > 200) return undefined
    for (const h of payload.headers) if (record(h) && typeof h.name === 'string' && typeof h.value === 'string') headers[h.name.toLowerCase().replaceAll('-', '_')] = text(h.value)!
  }
  for (const source of [value.headers, curated]) if (record(source)) {
    if (Object.keys(source).length > 200) return undefined
    for (const [key, v] of Object.entries(source)) if (typeof v === 'string') headers[key] = text(v)!
  }
  const m: EmailMessage = { headers, attachments: [] }
  for (const key of ['id', 'threadId', 'snippet'] as const) if (typeof value[key] === 'string') m[key] = text(value[key])
  for (const key of ['subject', 'from', 'to', 'cc', 'bcc', 'date'] as const) {
    const v = text(value[key]) ?? headers[key]
    if (v !== undefined) m[key] = v
  }
  const labels = value.labelIds ?? value.labels
  if (labels !== undefined) {
    if (!strings(labels)) return undefined
    m.labels = labels.map(x => text(x)!)
    m.unread = labels.includes('UNREAD')
  }
  if (value.internalDate !== undefined) {
    const n = typeof value.internalDate === 'string' && /^\d+$/.test(value.internalDate) ? Number(value.internalDate) : value.internalDate
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000) m.internalDate = n
    else warnings.push('Invalid message timestamp retained in original output.')
  }
  if (typeof value.internalDateIso === 'string') {
    m.internalDateIso = text(value.internalDateIso)
    if (m.date === undefined) m.date = m.internalDateIso
  }
  if (typeof value.body === 'string') { m.body = text(value.body); m.bodyFormat = 'text' }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 1000 || !value.attachments.every(record)) return undefined
    m.attachments = value.attachments.map(a => ({ ...a, ...(typeof a.filename === 'string' ? { filename: text(a.filename) } : {}) }))
  }
  if (payload && m.body === undefined) {
    let nodes = 0
    type InlinePart = { format: 'text' | 'html'; body: string }
    const visit = (part: JsonRecord, depth: number): InlinePart[] => {
      if (++nodes > 200 || depth > 12) throw new Error('MIME traversal limit')
      const inline: InlinePart[] = []
      if (typeof part.filename === 'string' && part.filename) {
        m.attachments.push({ filename: text(part.filename), mimeType: part.mimeType, ...(record(part.body) ? { size: part.body.size, attachmentId: part.body.attachmentId } : {}) })
        return inline
      }
      if (record(part.body) && typeof part.body.data === 'string' && !part.filename) {
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
          if (Array.isArray(part.headers)) {
            const contentType = part.headers.find(h => record(h) && typeof h.name === 'string' && h.name.toLowerCase() === 'content-type')
            if (record(contentType) && typeof contentType.value === 'string') {
              const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType.value)?.[1]?.toLowerCase()
              if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset)) throw new Error('Unsupported MIME charset')
            }
          }
          const data = part.body.data
          if (data.length > 1_000_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw new Error('Invalid MIME data')
          const bytes = Uint8Array.from(atob(data.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))
          inline.push({ format: part.mimeType === 'text/plain' ? 'text' : 'html', body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
        } else warnings.push('Unsupported MIME body retained in original output.')
      }
      if (part.parts !== undefined) {
        if (!Array.isArray(part.parts) || !part.parts.every(record)) throw new Error('Invalid MIME parts')
        const children = part.parts.map(child => visit(child, depth + 1))
        // Only alternatives represent the same content twice. Mixed/related
        // siblings remain separate, including HTML with its own parse context.
        const selected = part.mimeType === 'multipart/alternative'
          ? children.find(child => child.some(item => item.format === 'text')) ?? children.find(child => child.length) ?? []
          : children.flat()
        inline.push(...selected)
      }
      return inline
    }
    const selected = visit(payload, 0)
    if (selected.length > 1 && selected.some(part => part.format === 'html')) m.bodyParts = selected
    else if (selected.length) { m.body = selected.map(part => part.body).join('\n'); m.bodyFormat = selected[0]!.format }
  }
  return m
}

export function parseEmailToolPresentation(toolName: string, _input: Readonly<Record<string, unknown>>, content: string): EmailToolPresentation {
  const base: Base = { identity: getEmailToolIdentity(toolName), originalContent: content, warnings: [] }
  const unknown = (reason: string): EmailToolPresentation => ({ ...base, kind: 'unknown', reason })
  if (!base.identity) return unknown('Unsupported tool')
  if (content.length > 2_000_000) return unknown('Output exceeds parsing limit')
  if (content.endsWith('\n... [output truncated]')) return unknown('Truncated output')
  try {
    let data: unknown = JSON.parse(text(content)!)
    if (!record(data)) return unknown('Unrecognized output shape')
    if ('exit_code' in data) {
      if (!Number.isInteger(data.exit_code) || typeof data.tool !== 'string' || typeof data.service !== 'string' || typeof data.risk !== 'string') return unknown('Malformed command envelope')
      if (base.identity.provider !== 'gmail'
        || data.tool !== toolName.slice('mcp__gmail__'.length)
        || data.service !== 'gmail'
        || data.risk !== (base.identity.operation === 'send' ? 'write' : 'read')) return unknown('Command envelope does not match tool')
      if (data.exit_code !== 0) return { ...base, kind: 'failure', exitCode: data.exit_code as number, timedOut: data.exit_code === 124, stderr: text(data.stderr) }
      if (typeof data.stderr === 'string' && data.stderr) base.warnings.push(data.stderr)
      if (typeof data.stdout === 'string') {
        if (data.stdout.endsWith('\n... [output truncated]')) return unknown('Truncated output')
        data = JSON.parse(text(data.stdout)!)
      } else data = data.stdout
    }
    if (!record(data)) return unknown('Missing or selected output')
    const op = base.identity.operation
    if (data.dry_run === true) {
      if (op === 'send' && data.op === 'gmail.send' && record(data.request)) return { ...base, kind: 'dry-run', request: { ...data.request } }
      return unknown('Unrecognized dry run')
    }
    if ('error' in data || 'dry_run' in data) return unknown('Unrecognized command status')
    if (op === 'send' && typeof data.messageId === 'string' && data.messageId.trim()) return { ...base, kind: 'send', messageId: data.messageId, threadId: text(data.threadId), from: text(data.from) }
    if (op === 'accounts' && Array.isArray(data.accounts) && data.accounts.length === 0 && data.count === 0) return { ...base, kind: 'accounts', accounts: [], count: 0, tip: text(data.tip) }
    // gogcli serializes the API's nil label slice as an explicit null.
    if (op === 'labels' && data.labels === null) return { ...base, kind: 'labels', labels: [] }
    if (op === 'labels' && Array.isArray(data.labels) && data.labels.length <= 1000 && data.labels.every(l => record(l) && typeof l.id === 'string' && typeof l.name === 'string')) return { ...base, kind: 'labels', labels: data.labels.map(l => ({ ...l, name: text(l.name) })) }
    if (op === 'message' && record(data.message)) {
      const m = message({
        ...data.message,
        ...(data.body !== undefined ? { body: data.body } : {}),
        ...(data.attachments !== undefined ? { attachments: data.attachments } : {}),
      }, base.warnings, data.headers)
      if (m && (m.id || Object.keys(m.headers).length || m.body !== undefined || m.bodyParts?.length)) return { ...base, kind: 'message', message: m }
    }
    if (op === 'thread' && !record(data.thread)) return unknown('Missing thread container')
    const container = op === 'thread' && record(data.thread) ? data.thread : data
    if ((op === 'search' || op === 'thread') && Array.isArray(container.messages) && container.messages.length <= (op === 'search' ? 100 : 1000)) {
      const messages = container.messages.map(m => message(m, base.warnings))
      if (messages.some(m => !m || (op === 'search' ? !m.id : !m.id && !Object.keys(m.headers).length && m.body === undefined && !m.bodyParts?.length))) return unknown('Malformed message list')
      if (op === 'thread') return { ...base, kind: 'thread', id: text(container.id), messages: messages as EmailMessage[] }
      if (data.count !== undefined && (typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count !== messages.length)) return unknown('Invalid page count')
      if (data.has_more !== undefined && typeof data.has_more !== 'boolean') return unknown('Invalid pagination')
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') return unknown('Invalid pagination')
      return { ...base, kind: 'search', messages: messages as EmailMessage[], pageCount: data.count as number | undefined, hasMore: data.has_more as boolean | undefined, nextPageToken: text(data.nextPageToken) }
    }
    return unknown('Unrecognized or selected output')
  } catch {
    return unknown('Malformed or unsupported output')
  }
}
