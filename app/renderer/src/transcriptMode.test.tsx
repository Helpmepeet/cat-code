import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptModeProvider } from './TranscriptModeProvider.js'
import { DEFAULT_TRANSCRIPT_MODE, TRANSCRIPT_MODE_STORAGE_KEY, TranscriptModeContext, readTranscriptModeFromStorage, writeTranscriptModeToStorage } from './transcriptMode.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { AppearanceSettings } from './AppearanceSettings.js'

function Mode() {
  const { mode } = useContext(TranscriptModeContext)
  return <span>{mode}</span>
}

test('versioned codec accepts both modes and rejects malformed or unsupported records', () => {
  expect(DEFAULT_TRANSCRIPT_MODE).toBe('full')
  const storage = memoryStorage()
  for (const mode of ['full', 'focused'] as const) {
    writeTranscriptModeToStorage(storage, mode)
    expect(JSON.parse(storage.getItem(TRANSCRIPT_MODE_STORAGE_KEY)!)).toEqual({ version: 1, mode })
    expect(readTranscriptModeFromStorage(storage)).toBe(mode)
  }
  for (const raw of ['{oops', 'null', '[]', '1', '{"version":2,"mode":"focused"}', '{"version":1,"mode":"unknown"}', '{"mode":"focused"}']) {
    storage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, raw)
    expect(readTranscriptModeFromStorage(storage)).toBeNull()
  }
  expect(readTranscriptModeFromStorage(null)).toBeNull()
  const unavailable = { getItem() { throw new Error('unavailable') }, setItem() { throw new Error('unavailable') } }
  expect(readTranscriptModeFromStorage(unavailable)).toBeNull()
  expect(() => writeTranscriptModeToStorage(unavailable, 'focused')).not.toThrow()
})

test('provider publishes the persisted choice and falls back to Full', () => {
  const storage = memoryStorage()
  writeTranscriptModeToStorage(storage, 'focused')
  expect(renderToStaticMarkup(<TranscriptModeProvider storage={storage}><Mode /></TranscriptModeProvider>)).toBe('<span>focused</span>')
  expect(renderToStaticMarkup(<TranscriptModeProvider storage={null}><Mode /></TranscriptModeProvider>)).toBe('<span>full</span>')
  storage.setItem(TRANSCRIPT_MODE_STORAGE_KEY, '{oops')
  expect(renderToStaticMarkup(<TranscriptModeProvider storage={storage}><Mode /></TranscriptModeProvider>)).toBe('<span>full</span>')
})

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

test('Transcript is first in Conversation, persists, and participates in section reset', async () => {
  const storage = memoryStorage()
  const preferences = () => <TranscriptModeProvider storage={storage}><AppearanceSettings /></TranscriptModeProvider>
  let tree = await harness.mount(preferences())
  const selected = (mode: string) => tree.container.querySelector(`[aria-label="Transcript"] [value="${mode}"]`)?.getAttribute('aria-checked')
  expect(tree.container.querySelector('[aria-label="Conversation"] .appearance-controls > :first-child')?.getAttribute('data-setting-key')).toBe('transcriptMode')
  expect(selected('full')).toBe('true')
  expect(tree.container.querySelector('[aria-label="Restore conversation defaults"]')).toBeNull()
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Transcript"] [value="focused"]')!.click())
  expect(selected('focused')).toBe('true')
  expect(readTranscriptModeFromStorage(storage)).toBe('focused')
  await tree.unmount()
  tree = await harness.mount(preferences())
  expect(selected('focused')).toBe('true')
  await act(async () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Restore conversation defaults"]')!.click())
  expect(selected('full')).toBe('true')
  expect(readTranscriptModeFromStorage(storage)).toBe('full')
  expect(tree.container.querySelector('[aria-label="Restore conversation defaults"]')).toBeNull()
})
