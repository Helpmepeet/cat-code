import { expect, test } from 'bun:test'
import { createLocalhostPopups, type LocalhostPopupSource } from './localhostPopups.js'

const hidden = { id: 'hidden', frameName: 'hidden-frame', url: 'http://localhost:4000/old' }
const active = { id: 'active', frameName: 'active-frame', url: 'http://localhost:4000/current' }

test('only the actual live session receives a same-origin popup note', () => {
  const destinations = new Map<string, string>()
  let queries = 0
  const owner = createLocalhostPopups({ records: () => [hidden, active], frames: () => [active],
    focusedFrameName: async () => { queries++; return active.frameName }, leave: (id, url) => destinations.set(id, url) })
  owner.handle('https://example.com/destination', 'http://localhost:4000/')
  expect(destinations.get('active')).toBe('https://example.com/destination')
  expect(destinations.has('hidden')).toBe(false)
  expect(queries).toBe(0)
})

test('ambiguous popup focus has one pending lookup and revalidates the live identity before reporting', async () => {
  let frames: LocalhostPopupSource[] = [hidden, active]
  let complete!: (value: unknown) => void
  let queries = 0
  const destinations: Array<[string, string]> = []
  const owner = createLocalhostPopups({ records: () => [hidden, active], frames: () => frames,
    focusedFrameName: () => { queries++; return new Promise(resolve => { complete = resolve }) }, leave: (id, url) => destinations.push([id, url]) })
  owner.handle('https://example.com/first', '')
  for (let index = 0; index < 100; index++) owner.handle('https://example.com/dropped', '')
  expect(queries).toBe(1)
  frames = [hidden]
  complete(active.frameName)
  await Bun.sleep(0)
  expect(destinations).toEqual([])
  frames = [hidden, active]
  owner.handle('https://example.com/latest', '')
  complete(active.frameName)
  await Bun.sleep(0)
  expect(queries).toBe(2)
  expect(destinations).toEqual([['active', 'https://example.com/latest']])
  owner.handle('https://example.com/disposed', '')
  owner.dispose()
  complete(active.frameName)
  await Bun.sleep(0)
  expect(destinations).toHaveLength(1)
})
