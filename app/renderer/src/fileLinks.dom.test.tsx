import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { ProseArrivalContext, type ProseArrival } from './proseArrival.js'
import { FileLinkTicker } from './FileLinkTicker.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { CatCodeBridge } from '../../shared/protocol.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function draw(content: string, arrival: ProseArrival = 'smooth', streaming = true) {
  const row: NestedTranscriptRow = {
    id: 'reply', sessionId: 'session', messageId: 'message', frameId: 'frame',
    blockIndex: 0, parentToolUseId: null, kind: 'assistant-text', role: 'assistant',
    content, isStreaming: streaming ? true : undefined, children: [],
  }
  return <ProseArrivalContext.Provider value={{ arrival, setArrival: () => {} }}>
    <TranscriptRowsView rows={[row]} />
  </ProseArrivalContext.Provider>
}

for (const arrival of ['instant', 'smooth', 'flowing'] as const) {
  for (const lead of ['See ', '- ']) {
    test(`${arrival}: a pending file link is one inert chip, retained when it closes (${lead.trim() || 'list'})`, async () => {
      const calls: string[] = []
      window.catcode = { openWorkspaceFile: async (_session, path) => { calls.push(path); return true } } as CatCodeBridge
      const prefix = `${lead}[supervisor.ts](/Users/pt/cat-code/app/supervisor/`
      const tree = await harness.mount(draw(prefix, arrival))
      const prose = tree.container.querySelector('.md-prose')!
      const chip = prose.querySelector<HTMLButtonElement>('button')!
      expect(chip).not.toBeNull()
      expect(prose.querySelectorAll('button')).toHaveLength(1)
      expect(chip.disabled).toBe(true)
      expect(chip.textContent).toBe('supervisor.ts')
      expect(prose.textContent).not.toContain('/Users/')
      const icon = chip.querySelector('svg')
      const label = Array.from(chip.childNodes).find(node => node.textContent === 'supervisor.ts')!
      await act(async () => { chip.click(); chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
      expect(calls).toEqual([])
      await tree.render(draw(`${prefix}supervisor.ts:212`, arrival))
      expect(prose.querySelector('button')).toBe(chip)
      const ticker = chip.querySelector('.file-link-ticker')!
      expect(ticker.textContent).toBe('supervisor.ts:212')
      expect(ticker.getAttribute('aria-hidden')).toBe('true')
      expect(prose.textContent).not.toContain('/Users/')
      await tree.render(draw(`${prefix}supervisor.ts:212)`, arrival))
      expect(prose.querySelector('button')).toBe(chip)
      expect(chip.querySelector('svg')).toBe(icon)
      expect(Array.from(chip.childNodes)).toContain(label)
      expect(chip.disabled).toBe(false)
      expect(chip.textContent).toBe('supervisor.ts')
      expect(chip.querySelector('.file-link-ticker')).toBeNull()
      await act(async () => { chip.click() })
      expect(calls).toEqual(['/Users/pt/cat-code/app/supervisor/supervisor.ts:212'])
    })
  }
}

test('an unfinished label stays literal and cannot produce a bare file chip', async () => {
  const tree = await harness.mount(draw('See [src/supervisor.ts'))
  const prose = tree.container.querySelector('.md-prose')!
  expect(prose.textContent).toBe('See [src/supervisor.ts')
  expect(prose.querySelector('button') === null).toBe(true)
})

test('non-file links never flash a file chip at any pending prefix', async () => {
  const tree = await harness.mount(draw('See [src/file.ts]('))
  for (const target of ['https://example.com/readme.md', '//example.com/readme.md', '#section', 'mailto:person@example.com', 'javascript:alert(1)']) {
    for (let length = 0; length < target.length; length++) {
      await tree.render(draw(`See [src/file.ts](${target.slice(0, length)}`))
      const prose = tree.container.querySelector('.md-prose')!
      expect(prose.querySelector('button') === null).toBe(true)
      expect(prose.querySelector('.file-link-ticker') === null).toBe(true)
      expect(prose.querySelector('a[href]') === null).toBe(true)
      expect(prose.textContent).toBe('See src/file.ts')
    }
  }
  await tree.render(draw('See [src/file.ts](https://example.com/readme.md)'))
  expect(tree.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/readme.md')
})

for (const arrival of ['smooth', 'flowing'] as const) {
  test(`${arrival}: a bare path crossing an arrival boundary remains one whole chip`, async () => {
    const tree = await harness.mount(draw('See /Users/pt/cat-code/app/super', arrival))
    const path = '/Users/pt/cat-code/app/supervisor/supervisor.ts'
    await tree.render(draw(`See ${path}`, arrival))
    const prose = tree.container.querySelector('.md-prose')!
    const chips = prose.querySelectorAll('button')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.getAttribute('aria-label')).toBe(`Open ${path}`)
    expect(chips[0]?.textContent).toBe(path)
    expect(chips[0]?.querySelector(`.prose-arrive-${arrival}`)).not.toBeNull()
    expect(prose.textContent).toBe(`See ${path}`)
  })
}

test('pending formatted labels retain their formatting and do not chip inline code twice', async () => {
  const tree = await harness.mount(draw('See [**source** `supervisor.ts`](/Users/pt/src/sup'))
  const chip = tree.container.querySelector('.md-prose button')!
  expect(chip.querySelector('strong')?.textContent).toBe('source')
  expect(chip.querySelector('code')?.textContent).toBe('supervisor.ts')
  expect(chip.querySelector('button') === null).toBe(true)
  await tree.render(draw('See [source](</Users/pt/src/supervisor.ts>'))
  const angleChip = tree.container.querySelector<HTMLButtonElement>('.md-prose button')!
  expect(angleChip.disabled).toBe(true)
  expect(angleChip.querySelector('.file-link-ticker')?.textContent).toBe('supervisor.ts')
})

test('settled incomplete syntax remains ordinary markdown', async () => {
  const tree = await harness.mount(draw('See [label](/Users/pt/a.ts', 'instant', false))
  expect(tree.container.querySelector('.md-prose')?.textContent).toBe('See [label](/Users/pt/a.ts')
  expect(tree.container.querySelector('.file-link-ticker')).toBeNull()
})

test('ticker clips to remaining line room, keeps its newest segment, and hides in a tiny gap', async () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  let right = 400
  HTMLElement.prototype.getBoundingClientRect = function () {
    const width = this.tagName === 'P' ? right : this.tagName === 'BUTTON' ? 300 : 180
    return { ...original.call(this), right: width, width } as DOMRect
  }
  try {
    const drawTicker = (destination: string) => <p><button><FileLinkTicker destination={destination} /></button></p>
    const tree = await harness.mount(drawTicker('/long/path/supervisor.ts'))
    const ticker = tree.container.querySelector<HTMLElement>('.file-link-ticker')!
    expect(ticker.textContent).toBe('supervisor.ts')
    expect(ticker.style.getPropertyValue('--file-link-ticker-room')).toBe('97px')
    expect(ticker.hasAttribute('data-clipped')).toBe(true)
    expect(ticker.hasAttribute('data-no-room')).toBe(false)
    right = 310
    await tree.render(drawTicker('/long/path/supervisor.ts:2'))
    expect(ticker.hasAttribute('data-no-room')).toBe(true)
    right = 1_000
    await tree.render(drawTicker('</long/path/supervisor.ts:21>'))
    expect(ticker.textContent).toBe('supervisor.ts:21')
    expect(ticker.hasAttribute('data-clipped')).toBe(false)
    expect(ticker.hasAttribute('data-no-room')).toBe(false)
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
})
