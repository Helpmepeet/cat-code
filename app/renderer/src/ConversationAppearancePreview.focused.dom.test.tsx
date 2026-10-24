import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { ConversationAppearancePreview } from './ConversationAppearancePreview.js'
import { TranscriptModeContext, type TranscriptMode } from './transcriptMode.js'
import { ToolsExpandedContext } from './toolsExpanded.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROSE_PREVIEW_CHUNKS } from './proseArrivalPreviewModel.js'
import { APPEARANCE_PREVIEW_FOCUSED_TURN } from './appearancePreviewModel.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function preview(mode: TranscriptMode, replay = 0, expanded = false) {
  return <TranscriptModeContext.Provider value={{ mode, setMode: () => {} }}>
    <ToolsExpandedContext.Provider value={{ expanded, setExpanded: () => {} }}>
      <ConversationAppearancePreview replay={replay} />
    </ToolsExpandedContext.Provider>
  </TranscriptModeContext.Provider>
}

test('Focused preview folds completed work, keeps real tools and reasoning reachable, and leaves answer outside', async () => {
  expect(APPEARANCE_PREVIEW_FOCUSED_TURN.completed).toBe(true)
  const { container } = await harness.mount(preview('focused', 0, true))
  const fold = container.querySelector<HTMLButtonElement>('.focused-fold-head')!
  expect(fold.textContent).toContain('Worked')
  expect(fold.textContent).toContain('1m 44s')
  expect(fold.textContent).toContain('read 1 file, searched 1 pattern, ran 1 command')
  expect(fold.getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
  expect(container.querySelector('.appearance-preview-reply')?.textContent).toContain(PROSE_PREVIEW_CHUNKS.join(''))
  expect(container.querySelector('.appearance-preview-reply .focused-turn')).toBeNull()
  expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
  await act(async () => fold.click())
  const step = container.querySelector<HTMLButtonElement>('.focused-step-head')!
  expect(step.getAttribute('aria-expanded')).toBe('false')
  await act(async () => step.click())
  expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(3)
  expect(container.querySelectorAll('[data-tool-row] button[aria-expanded="true"]')).toHaveLength(3)
  expect(container.textContent).toContain('Tracing the module graph')
  expect(container.querySelectorAll('.focused-turn')).toHaveLength(1)
})

test('Full preview retains the original three tool rows without a fold', async () => {
  const { container } = await harness.mount(preview('full'))
  expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(3)
  expect(container.querySelector('.focused-turn')).toBeNull()
  expect(container.textContent).toContain('Can you simplify the loader?')
  expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
})

for (const mode of ['full', 'focused'] as const) {
  test(`${mode} preview preserves Text arrival replay and code sample`, async () => {
    let advance: (() => void) | undefined
    const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
      advance = callback
      return 123
    }) as typeof setInterval)
    const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    try {
      const { container } = await harness.mount(preview(mode, 1))
      const reply = () => container.querySelector('.appearance-arrival > div:not([aria-hidden])')!
      expect(reply().textContent).toBe('')
      await act(async () => advance!())
      expect(reply().textContent).toBe(PROSE_PREVIEW_CHUNKS[0]!.trimEnd())
      expect(reply().querySelector('.prose-arrive-smooth')).not.toBeNull()
      expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
    } finally {
      timer.mockRestore()
      clear.mockRestore()
    }
  })
}
