import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import { SettingsShell } from './SettingsShell.js'

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

async function searchFor(input: HTMLInputElement, query: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a search result opens Appearance and focuses the Code theme control', async () => {
  const tree = await harness.mount(createElement(SettingsShell, { snapshot: null }))
  try {
    const search = tree.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search all settings"]',
    )
    expect(search).not.toBeNull()
    await searchFor(search!, 'code theme')

    const result = tree.container.querySelector<HTMLButtonElement>(
      'section[aria-label="Search results"] button',
    )
    expect(result?.textContent).toContain('Code theme')
    await act(async () => result!.click())

    const select = tree.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Code theme"]',
    )
    expect(select).not.toBeNull()
    expect(harness.document.activeElement).toBe(select)
  } finally {
    const general = Array.from(tree.container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Settings categories"] button',
    )).find(button => button.textContent === 'General')
    if (general) await act(async () => general.click())
  }
})
