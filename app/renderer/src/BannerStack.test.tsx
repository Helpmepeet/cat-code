import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BannerStack,
  type BannerNotice,
} from './BannerStack.js'
import { dismissBanner, upsertBanner } from './bannerStackModel.js'

const reauth: BannerNotice = {
  id: 'reauth',
  tone: 'danger',
  title: 'Account signed out',
  detail: 'work-account',
  actions: [{ key: 'reauth', label: 'Re-authenticate', primary: true }],
}

test('upsertBanner appends a new id to the bottom of the stack', () => {
  const next = upsertBanner([reauth], {
    id: 'rate',
    tone: 'warn',
    title: 'Rate limited',
  })
  expect(next.map(b => b.id)).toEqual(['reauth', 'rate'])
})

test('upsertBanner replaces an existing id in place (no duplicate)', () => {
  const updated = upsertBanner([reauth], {
    ...reauth,
    detail: 'work-account · retry in 30s',
  })
  expect(updated).toHaveLength(1)
  expect(updated[0].detail).toBe('work-account · retry in 30s')
})

test('dismissBanner removes the addressed banner only', () => {
  const stacked = upsertBanner([reauth], {
    id: 'rate',
    tone: 'warn',
    title: 'Rate limited',
  })
  expect(dismissBanner(stacked, 'reauth').map(b => b.id)).toEqual(['rate'])
})

test('BannerStack renders one bar per banner, stacked', () => {
  const stacked = upsertBanner([reauth], {
    id: 'rate',
    tone: 'warn',
    title: 'Rate limited',
  })
  const html = renderToStaticMarkup(<BannerStack banners={stacked} />)
  expect(html).toContain('Account signed out')
  expect(html).toContain('Rate limited')
  expect(html).toContain('Re-authenticate')
  // Danger + warn tones both painted.
  expect(html).toContain('bg-tone-danger/10')
  expect(html).toContain('bg-tone-warn/10')
})

test('a non-dismissable banner hides the × control', () => {
  const gate: BannerNotice = {
    id: 'gate',
    tone: 'danger',
    title: 'No healthy accounts',
    dismissable: false,
  }
  const html = renderToStaticMarkup(<BannerStack banners={[gate]} />)
  expect(html).not.toContain('Dismiss:')
})

test('BannerStack renders nothing for an empty stack', () => {
  expect(renderToStaticMarkup(<BannerStack banners={[]} />)).toBe('')
})
