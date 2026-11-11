import { describe, expect, test } from 'bun:test'
import { getEmailToolIdentity, parseEmailToolPresentation } from './emailToolPresentation'
const names = { search: 'mcp__gmail__gmail_search', message: 'mcp__gmail__gmail_get_message', thread: 'mcp__gmail__gmail_get_thread', labels: 'mcp__gmail__gmail_list_labels', send: 'mcp__gmail__gmail_send_message', accounts: 'mcp__outlook__list-accounts' }
const parse = (op: keyof typeof names, data: unknown) => parseEmailToolPresentation(names[op], {}, JSON.stringify(data))
const envelope = (stdout?: unknown, exit_code = 0, op: keyof typeof names = 'send') => ({
  tool: names[op].slice('mcp__gmail__'.length), service: 'gmail',
  risk: op === 'send' ? 'write' : 'read', exit_code, stdout,
})
describe('email presentation', () => {
  test('all Gmail envelopes require matching tool, service and risk', () => {
    const outputs = {
      search: { messages: [], count: 0 },
      message: { message: { id: 'm', body: 'body' } },
      thread: { thread: { id: 't', messages: [] } },
      labels: { labels: [] },
      send: { messageId: 'm' },
    }
    for (const op of Object.keys(outputs) as (keyof typeof outputs)[]) {
      const valid = envelope(outputs[op], 0, op)
      expect(parse(op, valid).kind).toBe(op)
      for (const patch of [
        { tool: 'gmail' },
        { tool: op === 'send' ? 'gmail_search' : 'gmail_send_message' },
        { service: 'drive' },
        { risk: op === 'send' ? 'read' : 'write' },
      ]) {
        const invalid = { ...valid, ...patch }
        const result = parse(op, invalid)
        expect(result.kind).toBe('unknown')
        expect(result.originalContent).toBe(JSON.stringify(invalid))
      }
    }
    expect(parse('accounts', { ...envelope({ accounts: [], count: 0 }), service: 'outlook', tool: 'list-accounts' }).kind).toBe('unknown')
    expect(parse('send', { ...envelope({ messageId: 'm' }, 124), tool: 'gmail_search' }).kind).toBe('unknown')
  })
  test('explicit null labels is empty, missing or malformed labels is unknown', () => {
    for (const labels of [null, []]) {
      const result = parse('labels', envelope({ labels }, 0, 'labels'))
      expect(result.kind).toBe('labels')
      if (result.kind === 'labels') expect(result.labels).toEqual([])
    }
    for (const data of [{}, { labels: false }, { labels: '' }, { labels: {} }, { labels: [null] }]) expect(parse('labels', envelope(data, 0, 'labels')).kind).toBe('unknown')
  })
  test('real provenance wrappers across Gmail result contracts remain text', () => {
    const wrap = (body: string) => `<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>\nSource: google_api\n---\n${body}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc">>>`
    const subject = 'LinkedIn <script>not executable</script>'
    const cases: [keyof typeof names, unknown][] = [
      ['search', { messages: [{ id: 'm', subject: wrap(subject) }], count: 1 }],
      ['message', { message: { id: 'm', headers: { subject: wrap(subject) }, body: wrap('body') } }],
      ['thread', { thread: { messages: [{ id: 'm', headers: { subject: wrap(subject) }, body: wrap('body') }] } }],
      ['labels', { labels: [{ id: 'l', name: wrap(subject) }] }],
      ['send', { messageId: 'm', from: wrap(subject) }],
    ]
    for (const [op, data] of cases) {
      const result = parse(op, data)
      expect(result.kind).toBe(op)
      if (result.kind === 'search' || result.kind === 'thread') expect(result.messages[0]?.subject).toBe(subject)
      if (result.kind === 'message') { expect(result.message.subject).toBe(subject); expect(result.message.body).toBe('body') }
      if (result.kind === 'labels') expect(result.labels[0]?.name).toBe(subject)
      if (result.kind === 'send') expect(result.from).toBe(subject)
    }
    for (const original of [`prefix ${wrap(subject)}`, wrap(subject).replace('id="abc">>>\n', 'id="other">>>\n'), 'Source: google_api\n---\nplain']) {
      const result = parse('message', { message: { id: 'm', body: original } })
      if (result.kind !== 'message') throw new Error('Expected message')
      expect(result.message.body).toBe(original)
    }
    const unrecognized = wrap('body').replace('Source: google_api', 'Source: arbitrary')
    const result = parse('message', { message: { id: 'm', body: unrecognized } })
    if (result.kind === 'message') expect(result.message.body).toBe('Source: arbitrary\n---\nbody')
  })
  test('unsanitized get uses top-level body and attachments before raw MIME fallback', () => {
    const raw = { id: 'm', payload: { mimeType: 'text/plain', body: { data: btoa('MIME fallback') } } }
    const filename = '<<<EXTERNAL_UNTRUSTED_CONTENT id="abc">>>\nSource: google_api\n---\nreport.pdf\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="abc">>>'
    const result = parse('message', { message: raw, headers: { subject: 'Curated' }, body: 'Top-level body', attachments: [{ filename, size: 42, attachmentId: 'a' }] })
    if (result.kind !== 'message') throw new Error('Expected message')
    expect(result.message.body).toBe('Top-level body')
    expect(result.message.headers.subject).toBe('Curated')
    expect(result.message.attachments).toEqual([{ filename: 'report.pdf', size: 42, attachmentId: 'a' }])
    const fallback = parse('message', { message: raw })
    if (fallback.kind !== 'message') throw new Error('Expected message')
    expect(fallback.message.body).toBe('MIME fallback')
  })
  test('only exact identities', () => {
    expect(getEmailToolIdentity(names.send)?.operation).toBe('send')
    expect(getEmailToolIdentity('toString')).toBeUndefined()
    expect(getEmailToolIdentity('gmail_send_message')).toBeUndefined()
  })
  test('search page metadata and unknown unread', () => {
    const result = parse('search', envelope({ messages: [{ id: 'a', subject: '<script>evil()</script>' }], count: 1, has_more: true, nextPageToken: 'next' }, 0, 'search'))
    expect(result.kind).toBe('search')
    if (result.kind !== 'search') return
    expect(result.pageCount).toBe(1)
    expect(result.messages[0]?.unread).toBeUndefined()
    expect(result.messages[0]?.subject).toBe('<script>evil()</script>')
    expect(result.hasMore).toBe(true)
    expect(parse('search', { messages: [], count: 0 }).kind).toBe('search')
  })
  test('sanitized get retains headers, attachment metadata, text and label state', () => {
    const result = parse('message', { message: { id: 'm', labelIds: ['UNREAD'], headers: { subject: 'Hi', reply_to: 'person' }, body: 'hello', attachments: [{ filename: 'a', size: 2, attachmentIndex: 0 }] } })
    expect(result.kind).toBe('message')
    if (result.kind === 'message') {
      expect(result.message.unread).toBe(true)
      expect(result.message.headers.reply_to).toBe('person')
      expect(result.message.attachments[0]?.attachmentIndex).toBe(0)
    }
  })
  test('thread preserves bodies even when input full is false', () => {
    const result = parse('thread', { thread: { id: 't', messages: [{ id: 'm', headers: {}, body: 'body' }] }, downloaded: null })
    expect(result.kind).toBe('thread')
    if (result.kind === 'thread') expect(result.messages[0]?.body).toBe('body')
  })
  test('labels without enrichment and accounts only verified empty shape', () => {
    expect(parse('labels', { labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] }).kind).toBe('labels')
    expect(parse('accounts', { accounts: [], count: 0, tip: 'login' }).kind).toBe('accounts')
    expect(parse('accounts', { accounts: [{ email: 'unverified' }], count: 1 }).kind).toBe('unknown')
  })
  test('send requires receipt and dry run is not sent', () => {
    expect(parse('send', envelope({ messageId: 'm', threadId: 't' })).kind).toBe('send')
    expect(parse('send', { dry_run: true, op: 'gmail.send', request: { to: 'x', body_len: 4 } }).kind).toBe('dry-run')
    for (const data of [{}, { messageId: '' }, { messageId: ' ' }, { error: 'failed', messageId: 'm' }, { dry_run: false, messageId: 'm' }, envelope(), { subject: 'selected' }]) expect(parse('send', data).kind).toBe('unknown')
  })
  test('command failures including timeout precede receipts', () => {
    for (const exitCode of [1, 124]) {
      const result = parse('send', { ...envelope({ messageId: 'm' }, exitCode), stderr: 'error' })
      expect(result.kind).toBe('failure')
      if (result.kind === 'failure') expect(result.timedOut).toBe(exitCode === 124)
    }
  })
  test('malformed, argument, selected and truncated results retain original once', () => {
    for (const content of ['', 'argument error', '[]', '{', JSON.stringify(envelope('ok\n... [output truncated]')), '{"messageId":"m"}\n... [output truncated]']) {
      const result = parseEmailToolPresentation(names.send, {}, content)
      expect(result.kind).toBe('unknown')
      expect(result.originalContent).toBe(content)
    }
    expect(parse('search', { messages: [{ subject: 'no id' }] }).kind).toBe('unknown')
  })
  test('unwraps matching entire wrapper only, never inline or mismatched markers', () => {
    const wrap = (s: string) => `<<<EXTERNAL_UNTRUSTED_CONTENT id="a">>>\n${s}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="a">>>`
    for (const subject of [wrap('hello'), `prefix ${wrap('hello')}`, wrap('hello').replace('id="a">>>\n', 'id="b">>>\n')]) {
      const result = parse('message', { message: { id: 'm', headers: { subject } } })
      expect(result.kind).toBe('message')
      if (result.kind === 'message') expect(result.message.subject).toBe(subject === wrap('hello') ? 'hello' : subject)
    }
    expect(parseEmailToolPresentation(names.labels, {}, wrap('{"labels":[]}')).kind).toBe('labels')
  })
  test('raw MIME decoding, HTML is inert text, limits fail closed', () => {
    const payload = { mimeType: 'text/plain', body: { data: btoa('hello') } }
    const result = parse('thread', { thread: { messages: [{ id: 'm', payload }] } })
    expect(result.kind).toBe('thread')
    if (result.kind === 'thread') expect(result.messages[0]?.body).toBe('hello')
    const html = parse('message', { message: { id: 'm', payload: { mimeType: 'text/html', body: { data: btoa('<img src="https://evil">').replaceAll('+', '-').replaceAll('/', '_') } } } })
    if (html.kind === 'message') { expect(html.message.bodyFormat).toBe('html'); expect(html.message.body).toContain('<img') }
    else throw new Error('Expected inert HTML')
    let deep: Record<string, unknown> = payload
    for (let i = 0; i < 14; i++) deep = { parts: [deep] }
    expect(parse('message', { message: { id: 'm', payload: deep } }).kind).toBe('unknown')
    expect(parse('message', { message: { id: 'm', payload: { ...payload, body: { data: '!!!' } } } }).kind).toBe('unknown')
  })
  test('plain-text preference is local to MIME alternatives, not independent mixed sections', () => {
    const part = (mimeType: string, body: string) => ({ mimeType, body: { data: btoa(body).replaceAll('+', '-').replaceAll('/', '_') } })
    const alternative = { mimeType: 'multipart/alternative', parts: [part('text/plain', 'Introduction'), part('text/html', '<p>Alternative introduction</p>')] }
    const simple = parse('message', { message: { id: 'm', payload: alternative } })
    expect(simple.kind).toBe('message')
    if (simple.kind !== 'message') throw new Error('Expected message')
    expect(simple.message.body).toBe('Introduction')
    for (const first of [part('text/plain', 'Introduction'), alternative]) {
      const mixed = parse('message', { message: { id: 'm', payload: { mimeType: 'multipart/mixed', parts: [first, part('text/html', '<p>Important separate section</p>')] } } })
      expect(mixed.kind).toBe('message')
      if (mixed.kind !== 'message') throw new Error('Expected mixed message')
      expect(mixed.message.bodyParts).toEqual([{ format: 'text', body: 'Introduction' }, { format: 'html', body: '<p>Important separate section</p>' }])
    }
  })
  test('does not mutate arguments or retain duplicate raw messages', () => {
    const data = { message: { id: 'm', headers: { from: 'a' } } }
    const before = JSON.stringify(data)
    const result = parse('message', data)
    expect(JSON.stringify(data)).toBe(before)
    expect(result).not.toHaveProperty('raw')
    if (result.kind === 'message') expect(result.message).not.toHaveProperty('originalContent')
  })
  test('oversized header and attachment collections fall back without discarding the original', () => {
    for (const message of [
      { id: 'm', headers: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`header-${index}`, 'value'])) },
      { id: 'm', payload: { headers: Array.from({ length: 201 }, () => ({ name: 'Received', value: 'value' })) } },
      { id: 'm', attachments: Array.from({ length: 1001 }, () => ({ filename: 'file.txt' })) },
    ]) {
      const content = JSON.stringify({ message })
      const result = parseEmailToolPresentation(names.message, {}, content)
      expect(result.kind).toBe('unknown')
      expect(result.originalContent).toBe(content)
    }
  })
})
