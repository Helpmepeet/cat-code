import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { TranscriptRowsView } from './TranscriptView.js'
import { ToolCardExpansionContext, createToolCardExpansionStore } from './toolCardExpansion.js'
import { ToolCardStyleContext, type ToolCardStyle } from './toolCardStyle.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import type { NestedToolUseRow } from './transcriptProjector.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

const names = {
  search: 'mcp__gmail__gmail_search', message: 'mcp__gmail__gmail_get_message', thread: 'mcp__gmail__gmail_get_thread',
  labels: 'mcp__gmail__gmail_list_labels', send: 'mcp__gmail__gmail_send_message', accounts: 'mcp__outlook__list-accounts',
}
const wrap = (value: string) => `<<<EXTERNAL_UNTRUSTED_CONTENT id="example">>>\nSource: google_api\n---\n${value}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="example">>>`
function row(toolName: string, content: unknown, extra: Partial<NestedToolUseRow> = {}): NestedToolUseRow {
  return {
    id: toolName, frameId: toolName, sessionId: 'email-tests', messageId: toolName, blockIndex: 0, parentToolUseId: null,
    kind: 'tool-use', toolUseId: toolName, toolName, toolFamily: toolName === 'ToolSearch' ? 'other' : 'mcp', input: {},
    status: 'success', agentCompletion: null, children: [], result: { isError: false, content: typeof content === 'string' ? content : JSON.stringify(content), diff: null }, ...extra,
  }
}
function envelope(toolName: string, stdout: unknown, extra: Record<string, unknown> = {}) {
  return { tool: toolName.slice('mcp__gmail__'.length), service: 'gmail', risk: toolName === names.send ? 'write' : 'read', exit_code: 0, stdout, ...extra }
}
const message = {
  id: 'message-a', threadId: 'thread-a', from: wrap('Example team <team@example.invalid>'),
  subject: wrap('รายละเอียดการประชุมและข้อมูลเพิ่มเติมสำหรับการประชุมครั้งถัดไป'),
  date: '2026-11-11 13:14', internalDateIso: '2026-11-11T13:14:30+07:00', labels: ['UNREAD', 'INBOX'],
}
const store = () => createToolCardExpansionStore()
const view = (rows: NestedToolUseRow[], expansion = store(), expanded = true, style: ToolCardStyle = 'lines') => (
  <ToolCardExpansionContext.Provider value={expansion}>
    <ToolsExpandedContext.Provider value={{ expanded, setExpanded: () => {} }}>
      <ToolCardStyleContext.Provider value={{ style, setStyle: () => {} }}>
        <TranscriptRowsView rows={rows} />
      </ToolCardStyleContext.Provider>
    </ToolsExpandedContext.Provider>
  </ToolCardExpansionContext.Provider>
)
async function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

test('the observed Gmail search shape becomes compact text rows without raw wrappers, dots or time-zone labels', async () => {
  const original = JSON.stringify(envelope(names.search, { count: 1, messages: [message], has_more: false, nextPageToken: '' }))
  const input = row(names.search, original)
  const tree = await harness.mount(view([input]))
  expect(tree.container.querySelector('[data-provider="gmail"]')).not.toBeNull()
  expect(tree.container.querySelector('.email-tool-summary')?.textContent).toBe('1 email')
  expect(tree.container.querySelector('.email-message-sender')?.textContent).toBe('Example team')
  expect(tree.container.querySelector('.email-message-subject')?.textContent).toBe('รายละเอียดการประชุมและข้อมูลเพิ่มเติมสำหรับการประชุมครั้งถัดไป')
  expect(tree.container.querySelector('.email-message-time')?.textContent).toBe('13:14')
  expect(tree.container.textContent).toContain('1 unread')
  for (const hidden of ['EXTERNAL_UNTRUSTED_CONTENT', 'google_api', 'Thailand time', 'mcp__gmail', 'exit_code']) expect(tree.container.textContent).not.toContain(hidden)
  expect(tree.container.querySelector('.unread-dot')).toBeNull()
  await click(tree.container, '.email-message-head')
  expect(tree.container.textContent).toContain('team@example.invalid')
  expect(tree.container.querySelector('.email-message-head')?.getAttribute('aria-expanded')).toBe('true')
  await click(tree.container, '.email-original-head')
  expect(tree.container.textContent).toContain('exit_code')
  expect(input.result?.content).toBe(original)
})

test('tool discovery shows both provider icons and preserves all capabilities', async () => {
  const matches = [names.search, names.accounts, 'mcp__outlook__list-mail-messages']
  const input = row('ToolSearch', '', { input: { query: `select:${matches.join(',')}` }, result: { isError: false, content: '', diff: null, toolSearch: { matches } } })
  const tree = await harness.mount(view([input]))
  expect(tree.container.textContent).toContain('Email tools ready')
  expect([...tree.container.querySelectorAll('.email-discovery-list dd')].map(node => node.textContent)).toEqual(['Search messages', 'List accounts', 'List messages'])
  expect(tree.container.querySelectorAll('.email-discovery-list [data-provider="gmail"]')).toHaveLength(1)
  expect(tree.container.querySelectorAll('.email-discovery-list [data-provider="outlook"]')).toHaveLength(2)
  expect(tree.container.textContent).not.toContain('mcp__')
  await tree.render(view([{ ...input, result: { ...input.result!, toolSearch: { matches: [names.search, 'WebSearch'] } } }]))
  expect(tree.container.querySelector('.email-tool-discovery')).toBeNull()
  expect(tree.container.textContent).toContain('WebSearch')
})

test('pending or denied discovery never claims tools are ready', async () => {
  const input = row('ToolSearch', '', { status: 'pending', result: null, input: { query: `select:${names.search},${names.accounts}` } })
  const tree = await harness.mount(view([input]))
  expect(tree.container.textContent).toContain('Loading email tools')
  expect(tree.container.querySelector('.email-discovery-list')).toBeNull()
  await tree.render(view([{ ...input, status: 'error', result: { isError: true, content: 'Permission denied', diff: null } }]))
  expect(tree.container.textContent).toContain('Email tools unavailable')
  expect(tree.container.textContent).toContain('Permission denied')
  expect(tree.container.textContent).not.toContain('Email tools ready')
})

test('Outlook empty accounts are a readable status while nonempty unfamiliar shapes retain original output', async () => {
  const input = row(names.accounts, { accounts: [], count: 0, tip: 'Internal parameter guidance' })
  const tree = await harness.mount(view([input]))
  expect(tree.container.querySelector('[data-provider="outlook"]')).not.toBeNull()
  expect(tree.container.textContent).toContain('No connected accounts')
  expect(tree.container.textContent).not.toContain('Internal parameter guidance')
  await tree.render(view([row(names.accounts, { accounts: [{ custom: 'unrecognized account' }], count: 1 })]))
  expect(tree.container.textContent).not.toContain('No connected accounts')
  await click(tree.container, '.email-original-head')
  expect(tree.container.textContent).toContain('unrecognized account')
})

test('message HTML is converted to inert text, attachment names remain text, and no remote element is mounted', async () => {
  const html = '<div>Hello <b>Peet</b><br>Project notes</div><script>window.emailExecuted=true</script><style>body{display:none}</style><img src="https://example.invalid/pixel"><iframe src="https://example.invalid/frame"></iframe>'
  const payload = { mimeType: 'text/html', body: { data: btoa(html).replaceAll('+', '-').replaceAll('/', '_') } }
  const tree = await harness.mount(view([row(names.message, envelope(names.message, { message: { id: 'html', payload, headers: { subject: 'Example notes' }, attachments: [{ filename: wrap('<img src=x>notes.pdf'), mimeType: 'application/pdf' }] } }))]))
  expect(tree.container.querySelector('.email-body')?.textContent).toContain('Hello Peet')
  expect(tree.container.querySelector('.email-body')?.textContent).toContain('Project notes')
  expect(tree.container.querySelector('.email-body')?.textContent).not.toContain('emailExecuted')
  expect(tree.container.querySelector('.email-body')?.textContent).not.toContain('display:none')
  expect(tree.container.querySelector('.email-attachments')?.textContent).toContain('<img src=x>notes.pdf')
  expect(tree.container.querySelectorAll('img,iframe,script,style,a')).toHaveLength(0)
  expect((window as unknown as Record<string, unknown>).emailExecuted).toBeUndefined()
})

test('independent MIME sections stay visible and literal plain-text markup is not interpreted', async () => {
  const part = (mimeType: string, body: string) => ({ mimeType, body: { data: btoa(body).replaceAll('+', '-').replaceAll('/', '_') } })
  const payload = { mimeType: 'multipart/mixed', parts: [part('text/plain', 'Introduction <script>literal code</script>'), part('text/html', '<p>Important separate section</p>')] }
  const tree = await harness.mount(view([row(names.message, envelope(names.message, { message: { id: 'mixed', payload } }))]))
  expect(tree.container.querySelector('.email-body')?.textContent).toContain('Introduction <script>literal code</script>')
  expect(tree.container.querySelector('.email-body')?.textContent).toContain('Important separate section')
  expect(tree.container.querySelectorAll('script')).toHaveLength(0)
})

test('HTML table cell boundaries keep adjacent values and headers separate', async () => {
  const html = '<table><thead><tr><th>Amount</th><th>Value</th></tr></thead><tbody><tr><td>12</td><td>34</td></tr></tbody></table>'
  const payload = { mimeType: 'text/html', body: { data: btoa(html).replaceAll('+', '-').replaceAll('/', '_') } }
  const tree = await harness.mount(view([row(names.message, envelope(names.message, { message: { id: 'table', payload } }))]))
  expect(tree.container.querySelector('.email-body')?.textContent).toBe('Amount\tValue\n12\t34')
})

test('malformed calendar dates and suffixes stay original rather than becoming compact timestamps', async () => {
  for (const date of ['2026-02-30T09:15:00+07:00', '2026-11-11T09:15:broken', '2026-11-11T09:15:00+99:99']) {
    const input = row(names.message, envelope(names.message, { message: { id: 'date', headers: { date }, body: 'Test' } }))
    const tree = await harness.mount(view([input]))
    const values = [...tree.container.querySelectorAll('.email-fields dd')].map(node => node.textContent)
    expect(values).toContain(date)
    expect(values).not.toContain(`${date.slice(0, 10)}, 09:15`)
    await tree.unmount()
    const list = await harness.mount(view([row(names.search, envelope(names.search, { messages: [{ id: 'date', date, internalDateIso: date }] }))]))
    expect(list.container.querySelector('.email-message-time')?.textContent).toBe('')
    await list.unmount()
  }
  const valid = await harness.mount(view([row(names.search, envelope(names.search, { messages: [{ id: 'leap', date: '2024-02-29 09:15', internalDateIso: '2024-02-29T09:15:00+07:00' }] }))]))
  expect(valid.container.querySelector('.email-message-time')?.textContent).toBe('09:15')
})

test('oversized HTML previews fall back explicitly instead of parsing an unbounded document', async () => {
  for (const html of ['<div>' + 'x'.repeat(200_001) + '</div>', '<p>x</p>'.repeat(10_001)]) {
    const payload = { mimeType: 'text/html', body: { data: btoa(html).replaceAll('+', '-').replaceAll('/', '_') } }
    const tree = await harness.mount(view([row(names.message, envelope(names.message, { message: { id: 'large-html', payload } }))]))
    expect(tree.container.querySelector('.email-body')).toBeNull()
    expect(tree.container.textContent).toContain('HTML message preview isn’t available.')
    expect(tree.container.querySelector('.email-original-head')).not.toBeNull()
    await tree.unmount()
  }
})

test('thread bodies remain available for full:false and headers, labels, and missing fields stay faithful', async () => {
  const stdout = { thread: { id: 't', messages: [{ id: 'one', headers: { from: wrap('First sender'), subject: 'A conversation' }, body: 'First body', internalDate: 1794387600000 }, { id: 'two', headers: { from: 'Second sender', subject: 'Re: A conversation' }, body: 'Second body' }] }, downloaded: null }
  const tree = await harness.mount(view([row(names.thread, envelope(names.thread, stdout), { input: { thread_id: 't', full: false } })]))
  expect(tree.container.querySelectorAll('.email-message')).toHaveLength(2)
  await click(tree.container, '.email-message-head')
  expect(tree.container.textContent).toContain('First body')
  await tree.render(view([row(names.labels, envelope(names.labels, { labels: [{ id: 'INBOX', name: wrap('Inbox'), type: 'system' }, { id: 'Label_sample', name: 'Applications', type: 'user' }] }))]))
  expect(tree.container.querySelectorAll('.email-label-list li')).toHaveLength(2)
  expect(tree.container.textContent).toContain('Applications')
  expect(tree.container.textContent).not.toContain('EXTERNAL_UNTRUSTED_CONTENT')
  await tree.render(view([row(names.search, envelope(names.search, { messages: [{ id: 'unknown' }] }))]))
  expect(tree.container.textContent).toContain('Unknown sender')
  expect(tree.container.textContent).toContain('(No subject)')
  expect(tree.container.textContent).not.toContain('0 unread')
})

test('only a successful send receipt shows Email sent; errors, cancellations, dry runs and truncation never do', async () => {
  const success = row(names.send, envelope(names.send, { messageId: 'sent-id', threadId: 'thread-id', from: 'sender@example.invalid' }))
  const tree = await harness.mount(view([success]))
  expect(tree.container.querySelector('.email-sent')?.textContent).toContain('Email sent')
  expect([...tree.container.querySelectorAll('.email-fields dt')].map(node => node.textContent)).toEqual(['From', 'Message', 'Thread'])
  const attempts = [
    row(names.send, envelope(names.send, { messageId: 'not-sent' }, { exit_code: 1, stderr: 'Failure' }), { status: 'error' }),
    { ...success, status: 'error' as const, result: { ...success.result!, isError: true } },
    { ...success, status: 'cancelled' as const },
    { ...success, status: 'pending' as const, result: null },
    row(names.send, envelope(names.send, { dry_run: true, op: 'gmail.send', request: { subject: 'Preview', to: 'sample@example.invalid' } })),
    row(names.send, envelope(names.send, '{"messageId":"partial"}\n... [output truncated]')),
    row(names.send, 'body or body_html is required', { status: 'error' }),
    row(names.send, ''),
  ]
  for (const attempt of attempts) {
    await tree.render(view([attempt]))
    expect(tree.container.querySelector('.email-sent')).toBeNull()
    expect(tree.container.querySelector('.email-tool-summary')?.textContent).not.toBe('Email sent')
  }
})

test('page counts never imply all search results and empty results remain distinct from errors', async () => {
  const tree = await harness.mount(view([row(names.search, envelope(names.search, { messages: [message], count: 1, has_more: true, nextPageToken: 'next' }))]))
  expect(tree.container.textContent).toContain('More results available')
  expect(tree.container.querySelectorAll('button').length).toBe(3)
  await tree.render(view([row(names.search, envelope(names.search, { messages: [], count: 0, has_more: false, nextPageToken: '' }))]))
  expect(tree.container.textContent).toContain('No emails match this search.')
  await tree.render(view([row(names.search, envelope(names.search, { messages: [] }, { exit_code: 124 }), { status: 'error' })]))
  expect(tree.container.textContent).toContain('Request timed out')
  expect(tree.container.textContent).not.toContain('No emails match this search.')
})

test('disclosures survive remounts, respect tool detail settings, and work in both card styles', async () => {
  const expansion = store()
  const input = row(names.search, envelope(names.search, { messages: [message], count: 1 }))
  for (const style of ['lines', 'cards'] as const) {
    const tree = await harness.mount(view([input], expansion, false, style))
    expect(tree.container.querySelector('.email-tool')?.getAttribute('data-style')).toBe(style)
    if (style === 'lines') await click(tree.container, '.email-tool-head')
    expect(tree.container.querySelector('.email-message')).not.toBeNull()
    if (style === 'lines') await click(tree.container, '.email-message-head')
    expect(tree.container.textContent).toContain('team@example.invalid')
    await tree.unmount()
  }
})
