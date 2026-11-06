import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { SourceTextView } from './SourceTextView.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function source(text: string, token = 1, line = 1) {
  return <SourceTextView lines={text.split('\n')} body={text} copy={text} gutter={index => index + 1}
    language={null} diffRows={null} wrap={false} onWrap={() => {}} subject="file" lineTarget={{line,token}} />
}

test('a repeated line citation jumps again with top alignment while a source update retains search', async () => {
  const text = Array.from({length: 600}, (_, i) => `source line ${i + 1}`).join('\n')
  const tree = await harness.mount(source(text, 1, 300))
  const region = tree.container.querySelector<HTMLElement>('[role="region"]')!
  Object.defineProperties(region, { clientHeight: {configurable: true,value: 200}, scrollHeight: {configurable: true,value: 12000} })
  expect(region.scrollTop).toBe(5980)
  await act(async () => { region.scrollTop = 100; region.dispatchEvent(new Event('scroll')) })
  await tree.render(source(text, 2, 300))
  expect(region.scrollTop).toBe(5980)
  const input = tree.container.querySelector<HTMLInputElement>('[aria-label="Search file"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'source')
    input.dispatchEvent(new Event('input', {bubbles: true}))
  })
  await tree.render(source(`${text}\nsource line 601`, 2, 300))
  expect(tree.container.querySelector('[aria-label="Search file"]')).toBe(input)
  expect(input.value).toBe('source')
  expect(tree.container.textContent).toContain('1/601')
})

test('long source lines can be paged to the tail and back without searching or mounting the whole line', async () => {
  const text = 'x'.repeat(8000) + 'reachable-tail'
  const tree = await harness.mount(source(text))
  expect(tree.container.textContent).not.toContain('reachable-tail')
  const next = () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Next part of line 1"]')
  await act(async () => { next()!.click() })
  await act(async () => { next()!.click() })
  expect(tree.container.textContent).toContain('reachable-tail')
  expect(tree.container.textContent!.length).toBeLessThan(5000)
  await act(async () => { tree.container.querySelector<HTMLButtonElement>('[aria-label="Previous part of line 1"]')!.click() })
  expect(tree.container.textContent).not.toContain('reachable-tail')
})
