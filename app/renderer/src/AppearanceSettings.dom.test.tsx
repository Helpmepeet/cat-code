import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { AppearanceSettings } from './AppearanceSettings.js'
import { AccentThemeProvider } from './AccentThemeProvider.js'
import { ColorSchemeProvider } from './ColorSchemeProvider.js'
import { GlassModeProvider } from './GlassModeProvider.js'
import { ProseArrivalProvider } from './ProseArrivalProvider.js'
import { ToolCardStyleProvider } from './ToolCardStyleProvider.js'
import { ToolsExpandedProvider } from './ToolsExpandedProvider.js'
import { ReasoningLayoutProvider } from './ReasoningLayoutProvider.js'
import { CodeThemeProvider } from './CodeThemeProvider.js'
import { memoryStorage } from './viewPreferenceStorageFixture.js'
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { PROSE_PREVIEW_CHUNKS } from './proseArrivalPreviewModel.js'
import { NotificationPreferencesProvider } from './NotificationPreferencesProvider.js'
import type { NotificationPreferences } from '../../shared/notificationPreferences.js'

let harness: DomTestHarness
beforeAll(async () => { harness = await createDomTestHarness() })
afterEach(async () => { await harness.unmountAll() })
afterAll(async () => { await harness.teardown() })

function preferences(storage = memoryStorage()) {
  return (
    <ColorSchemeProvider storage={storage} root={null} media={null} onScheme={() => {}}>
      <AccentThemeProvider storage={storage}>
        <GlassModeProvider storage={storage} root={null}>
          <ProseArrivalProvider storage={storage}>
            <ToolCardStyleProvider storage={storage}>
              <ToolsExpandedProvider storage={storage}>
                <ReasoningLayoutProvider storage={storage}>
                  <CodeThemeProvider storage={storage}><AppearanceSettings /></CodeThemeProvider>
                </ReasoningLayoutProvider>
              </ToolsExpandedProvider>
            </ToolCardStyleProvider>
          </ProseArrivalProvider>
        </GlassModeProvider>
      </AccentThemeProvider>
    </ColorSchemeProvider>
  )
}

function choice(container: HTMLElement, group: string, value: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] button[value="${value}"]`)
  expect(button).not.toBeNull()
  return button!
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click())
}

test('controls update the real preview, persist through remount and restore only their own section', async () => {
  const storage = memoryStorage()
  const tree = await harness.mount(preferences(storage))
  const container = tree.container
  const preview = () => container.querySelector<HTMLElement>('[aria-label="Conversation preview"]')!
  expect(container.querySelector('.appearance-reset')).toBeNull()
  expect(preview().querySelectorAll('[data-tool-row]')).toHaveLength(3)
  expect(preview().querySelectorAll('[data-tool-row] button[aria-expanded="true"]')).toHaveLength(0)

  await click(choice(container, 'Appearance', 'light'))
  await click(choice(container, 'Accent color', 'blue'))
  await click(container.querySelector<HTMLButtonElement>('[role="switch"]')!)
  await click(choice(container, 'Text arrival', 'flowing'))
  await click(choice(container, 'Tool call style', 'lines'))
  expect(preview().querySelector('[data-card-style="lines"]')).not.toBeNull()
  await click(choice(container, 'Tool call detail', 'expanded'))
  expect(preview().querySelectorAll('[data-tool-row] button[aria-expanded="true"]')).toHaveLength(3)
  await click(choice(container, 'Reasoning layout', 'blocks'))
  expect(preview().querySelector('ol')).toBeNull()
  expect(preview().textContent).toContain('Thinking')
  await click(choice(container, 'Code theme', 'github'))
  expect(container.querySelector('[data-code-theme="github"] .appearance-settings')).not.toBeNull()
  expect(preview().querySelector('button[aria-label="Copy code"]')).not.toBeNull()

  await tree.unmount()
  const remounted = await harness.mount(preferences(storage))
  for (const [group, value] of [
    ['Appearance', 'light'], ['Accent color', 'blue'], ['Text arrival', 'flowing'],
    ['Tool call style', 'lines'], ['Tool call detail', 'expanded'],
    ['Reasoning layout', 'blocks'], ['Code theme', 'github'],
  ]) expect(choice(remounted.container, group!, value!).getAttribute('aria-checked')).toBe('true')
  expect(remounted.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')

  // Use the remounted controls so persistence and reset are exercised together.
  const windowReset = remounted.container.querySelector<HTMLButtonElement>('button[aria-label="Restore window defaults"]')!
  await click(windowReset)
  expect(choice(remounted.container, 'Appearance', 'system').getAttribute('aria-checked')).toBe('true')
  expect(choice(remounted.container, 'Accent color', 'pink').getAttribute('aria-checked')).toBe('true')
  expect(remounted.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(choice(remounted.container, 'Code theme', 'github').getAttribute('aria-checked')).toBe('true')
  expect(remounted.container.querySelector('button[aria-label="Restore window defaults"]')).toBeNull()
  await click(remounted.container.querySelector<HTMLButtonElement>('button[aria-label="Restore conversation defaults"]')!)
  for (const [group, value] of [
    ['Text arrival', 'smooth'], ['Tool call style', 'cards'], ['Tool call detail', 'collapsed'],
    ['Reasoning layout', 'trail'], ['Code theme', 'dracula'],
  ]) expect(choice(remounted.container, group!, value!).getAttribute('aria-checked')).toBe('true')
  expect(remounted.container.querySelector('.appearance-reset')).toBeNull()
})

test('radio groups support arrows, wrapping, Home and End with one keyboard stop', async () => {
  const tree = await harness.mount(preferences())
  const current = () => tree.container.querySelector<HTMLButtonElement>('[aria-label="Code theme"] [aria-checked="true"]')!
  for (const [key, expected] of [['ArrowLeft', 'monokai'], ['Home', 'dracula'], ['End', 'monokai'], ['ArrowRight', 'dracula']]) {
    await act(async () => current().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(current().value).toBe(expected!)
    expect(harness.document.activeElement).toBe(current())
    expect(tree.container.querySelectorAll('[aria-label="Code theme"] [tabindex="0"]')).toHaveLength(1)
  }
})

test('notifications use main preferences, persist controls, and restore only their section', async () => {
  let saved: NotificationPreferences = { notify: 'all', dockBadge: true }
  const writes: NotificationPreferences[] = []
  const bridge = {
    getNotificationPreferences: async () => saved,
    setNotificationPreferences: async (value: NotificationPreferences) => {
      saved = value
      writes.push(value)
      return value
    },
  }
  const tree = await harness.mount(<NotificationPreferencesProvider bridge={bridge}>{preferences()}</NotificationPreferencesProvider>)
  expect(Array.from(tree.container.querySelectorAll('.appearance-section > .appearance-section-heading h3')).map(node => node.textContent)).toEqual(['Window', 'Notifications', 'Conversation'])
  expect(choice(tree.container, 'Notify', 'all').getAttribute('aria-checked')).toBe('true')
  expect(tree.container.querySelector('[aria-label="Notifications"] .appearance-section-description')?.textContent).toBe('Banners appear only while Cat Code is in the background.')
  expect(choice(tree.container, 'Notify', 'waiting').textContent).toBe('Needs input')
  await click(choice(tree.container, 'Notify', 'waiting'))
  await click(tree.container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Dock badge"]')!)
  expect(saved).toEqual({ notify: 'waiting', dockBadge: false })
  await click(choice(tree.container, 'Accent color', 'blue'))
  await click(tree.container.querySelector<HTMLButtonElement>('[aria-label="Restore notifications defaults"]')!)
  expect(saved).toEqual({ notify: 'all', dockBadge: true })
  expect(choice(tree.container, 'Accent color', 'blue').getAttribute('aria-checked')).toBe('true')
  expect(writes).toHaveLength(3)
})

test('notification read failure preserves defaults and write failure restores confirmed preferences', async () => {
  const bridge = {
    getNotificationPreferences: async (): Promise<NotificationPreferences> => { throw new Error('unavailable') },
    setNotificationPreferences: async (): Promise<NotificationPreferences> => { throw new Error('unavailable') },
  }
  const tree = await harness.mount(<NotificationPreferencesProvider bridge={bridge}><AppearanceSettings /></NotificationPreferencesProvider>)
  expect(choice(tree.container, 'Notify', 'all').getAttribute('aria-checked')).toBe('true')
  await click(choice(tree.container, 'Notify', 'off'))
  expect(choice(tree.container, 'Notify', 'all').getAttribute('aria-checked')).toBe('true')
})

test('Replay and a new arrival choice restart delivery through the real word marker', async () => {
  let advance: (() => void) | undefined
  const timer = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    advance = callback
    return 123
  }) as typeof setInterval)
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
  try {
    const tree = await harness.mount(preferences())
    const reply = () => tree.container.querySelector<HTMLElement>('.appearance-arrival > div:not([aria-hidden])')!
    expect(reply().textContent).toBe(PROSE_PREVIEW_CHUNKS.join(''))
    await click(tree.container.querySelector<HTMLButtonElement>('.appearance-replay')!)
    expect(reply().textContent).toBe('')
    await act(async () => advance!())
    expect(reply().textContent).toBe(PROSE_PREVIEW_CHUNKS[0]!.trimEnd())
    expect(reply().querySelector('.prose-arrive-smooth')).not.toBeNull()
    await click(choice(tree.container, 'Text arrival', 'instant'))
    expect(reply().textContent).toBe('')
    await act(async () => advance!())
    expect(reply().textContent).toBe(PROSE_PREVIEW_CHUNKS[0]!.trimEnd())
    expect(reply().querySelector('[class*="prose-arrive"]')).toBeNull()
    await tree.unmount()
    expect(clear).toHaveBeenCalled()
  } finally {
    timer.mockRestore()
    clear.mockRestore()
  }
})
