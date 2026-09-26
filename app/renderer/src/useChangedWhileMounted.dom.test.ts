import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { useChangedWhileMounted } from './useChangedWhileMounted.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

function Probe({ value }: { value: string }) {
  const fresh = useChangedWhileMounted(value)
  return createElement('span', { 'data-fresh': fresh })
}

test('a change is fresh for one render while mounted, but first mounts and remounts are still', async () => {
  const tree = await harness.mount(createElement(Probe, { value: 'pending' }))
  const freshness = () => tree.container.querySelector('span')?.getAttribute('data-fresh')

  expect(freshness()).toBe('false')
  await tree.render(createElement(Probe, { value: 'resolved' }))
  expect(freshness()).toBe('true')
  await tree.render(createElement(Probe, { value: 'resolved' }))
  expect(freshness()).toBe('false')

  await tree.unmount()
  const remounted = await harness.mount(createElement(Probe, { value: 'resolved' }))
  expect(remounted.container.querySelector('span')?.getAttribute('data-fresh')).toBe('false')
  await remounted.render(createElement(Probe, { value: 'reopened' }))
  expect(remounted.container.querySelector('span')?.getAttribute('data-fresh')).toBe('true')
})
