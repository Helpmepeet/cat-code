import { expect, test } from 'bun:test'
import { emailToolDiscovery, requestedEmailToolDiscovery } from './emailToolDiscovery.js'

test('email-only discovery lists every loaded capability with its provider', () => {
  const names = ['mcp__gmail__gmail_search', 'mcp__outlook__list-accounts', 'mcp__outlook__list-mail-messages']
  expect(emailToolDiscovery(names)).toEqual([
    { provider: 'gmail', label: 'Search messages' },
    { provider: 'outlook', label: 'List accounts' },
    { provider: 'outlook', label: 'List messages' },
  ])
  expect(requestedEmailToolDiscovery(`select:${names.join(',')}`)).toEqual(emailToolDiscovery(names))
  expect(emailToolDiscovery(['mcp__gmail__gmail_get_message', 'mcp__gmail__gmail_get_thread', 'mcp__gmail__gmail_list_labels', 'mcp__gmail__gmail_send_message'])).toHaveLength(4)
})

test('mixed, unknown, empty and unconfirmed keyword selections keep the generic presentation', () => {
  for (const names of [undefined, [], ['mcp__gmail__gmail_search', 'WebSearch'], ['mcp__unknown__gmail_search'], ['toString'], ['__proto__'], Array(101).fill('mcp__gmail__gmail_search')]) {
    expect(emailToolDiscovery(names)).toBeNull()
  }
  for (const query of [undefined, 'gmail', 'select:', 'select:mcp__gmail__gmail_search,WebFetch', 'select:mcp__gmail__gmail_search,']) {
    expect(requestedEmailToolDiscovery(query)).toBeNull()
  }
})
