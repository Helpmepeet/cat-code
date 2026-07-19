import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReauthWall } from './ReauthWall.js'
import type { ReauthWall as ReauthWallModel } from './reauthBannerState.js'

const noop = () => {}

const wall: ReauthWallModel = {
  id: 'reauth:wall:main,personal',
  title: 'Sign in again to continue',
  summary: 'No healthy account remains — new turns are blocked until you re-link.',
  accounts: [
    {
      id: 'main',
      label: 'main',
      reason: 'refresh_token_invalidated',
      actionKey: 'reauthenticate:main',
    },
    {
      id: 'personal',
      label: 'personal',
      reason: 'Token expired (>7 days since last refresh)',
      actionKey: 'reauthenticate:personal',
    },
  ],
  collapsedLabel: 'New turns blocked — 2 accounts need re-authentication',
}

function render(collapsed: boolean): string {
  return renderToStaticMarkup(
    <ReauthWall
      wall={wall}
      collapsed={collapsed}
      onReauth={noop}
      onAcknowledge={noop}
      onExpand={noop}
    />,
  )
}

test('expanded: the pool-level "blocked" sentence appears exactly ONCE (finding #1: merged, not per-account)', () => {
  const html = render(false)
  expect(html.split('new turns are blocked').length - 1).toBe(1)
  expect(html).toContain('Sign in again to continue')
})

test('expanded: each dead account renders its OWN preserved reason + a re-authenticate action', () => {
  const html = render(false)
  expect(html).toContain('main')
  expect(html).toContain('refresh_token_invalidated')
  expect(html).toContain('personal')
  expect(html).toContain('Token expired (&gt;7 days since last refresh)')
  // One Re-authenticate button per dead account.
  expect(html.split('Re-authenticate').length - 1).toBe(wall.accounts.length)
  // A Collapse control (acknowledge → minimize), not a hide/×.
  expect(html).toContain('Collapse')
})

test('expanded: paints the danger tone from the shared BannerStack grammar', () => {
  const html = render(false)
  expect(html).toContain('bg-tone-danger/10')
})

test('collapsed: minimal persistent chip — still says blocked, offers re-auth + re-expand, never fully hidden', () => {
  const html = render(true)
  expect(html).not.toBe('')
  expect(html).toContain('New turns blocked')
  expect(html).toContain('Re-authenticate')
  expect(html).toContain('Show details')
})

test('collapsed: minimized — per-account reason detail is hidden until re-expanded', () => {
  const html = render(true)
  expect(html).not.toContain('refresh_token_invalidated')
  expect(html).not.toContain('Token expired')
})
