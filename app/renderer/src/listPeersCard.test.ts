import { expect, test } from 'bun:test'
import { formatNoticePostedAt, parseListPeersResult } from './listPeersCard.js'

const ROSTER = JSON.stringify({
  asOf: '2026-10-17T04:17:01.960Z',
  peers: [
    { name: 'Litharge', status: 'live', presence: 'running', model: 'gpt-6.1-sol', effort: 'high', title: 'Add five-minute awake lid option', lastActivity: '2026-10-17T04:15:53.961Z' },
    { name: 'Moonstone', status: 'live', presence: 'needs_user', title: 'Fix &lt;Composer&gt; &amp; tabs', lastActivity: '2026-10-17T04:10:00.000Z',
      notice: { doing: 'Composer redesign. Editing.', touches: ['app/renderer/src/composer/'], note: 'Owns &lt;ComposerActionsBar&gt;', postedAt: '2026-10-17T04:02:00.000Z' } },
    { name: 'Sunstone', status: 'parked', title: null, lastActivity: '2026-10-17T03:00:00.000Z', noticeOmitted: true },
    { name: 'Homunculus', status: 'closed', title: 'Improve macOS sleep prevention safety', lastActivity: '2026-10-17T03:35:08.361Z' },
  ],
  note: '103 peers that closed earlier are not listed. Set all to true to see them.',
})

test('keeps open sessions only, with their state, title and notice', () => {
  expect(parseListPeersResult(ROSTER)).toEqual([
    { name: 'Litharge', title: 'Add five-minute awake lid option', state: 'running', notice: null },
    {
      name: 'Moonstone',
      title: 'Fix <Composer> & tabs',
      state: 'needs_user',
      notice: {
        doing: 'Composer redesign. Editing.',
        touches: ['app/renderer/src/composer/'],
        note: 'Owns <ComposerActionsBar>',
        postedAt: Date.parse('2026-10-17T04:02:00.000Z'),
      },
    },
    { name: 'Sunstone', title: null, state: 'parked', notice: null },
  ])
})

test('a result that is not a narrowable roster falls back to the raw text', () => {
  expect(parseListPeersResult('This workspace has no other peer, live, parked or closed.')).toBeNull()
  expect(parseListPeersResult(JSON.stringify({ peers: [{ name: 'A', status: 'sleeping' }] }))).toBeNull()
  expect(parseListPeersResult(JSON.stringify({ peers: [{ name: 'A', status: 'live', presence: 'dozing' }] }))).toBeNull()
  expect(parseListPeersResult(JSON.stringify({ peers: [{ name: 'A', status: 'live', presence: 'idle', notice: { doing: 'x' } }] }))).toBeNull()
})

test('an all-closed roster has no open sessions', () => {
  expect(parseListPeersResult(JSON.stringify({ peers: [{ name: 'A', status: 'closed', title: 't' }] }))).toEqual([])
})

test('notice times are bare today and day-labelled otherwise', () => {
  const now = Date.parse('2026-10-17T10:00:00Z')
  expect(formatNoticePostedAt(Date.parse('2026-10-17T04:02:00Z'), now, 'UTC')).toBe('04:02')
  expect(formatNoticePostedAt(Date.parse('2026-10-16T22:15:00Z'), now, 'UTC')).toBe('Yesterday 22:15')
})
