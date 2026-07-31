import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ExtensionsSnapshot } from '../../shared/protocol.js'
import { McpPanel, PluginsPanel } from './SettingsExtensions.js'

/**
 * P4-45 — the extensions panels must not print roadmap notes at the user.
 *
 * These two panels outlived the 2026-07-27 sweep that deleted `DeferredNote`
 * and its six notes from `SettingsShell.tsx`: this module declared a component
 * of the SAME NAME with a different prop shape, so it was never looked at, and
 * its two notes were merely reworded. Both are now gone. What is deferred is
 * recorded in the ledger and STATUS; the marketplace tab keeps only the half
 * that tells the user what to DO instead (CLAUDE.md §7).
 *
 * The marketplace copy is pinned at the SOURCE, not through SSR: the tab is
 * `useState`-selected, so `renderToStaticMarkup` only ever reaches the default
 * "installed" tab. This is the `App.test.tsx` / `userVisibleText.test.ts`
 * precedent for text a static render cannot observe.
 */

const MODULE = readFileSync(new URL('./SettingsExtensions.tsx', import.meta.url), 'utf8')

function snapshot(fields: Partial<ExtensionsSnapshot> = {}): ExtensionsSnapshot {
  return { mcp: [], plugins: [], skills: [], hooks: [], ...fields }
}

test('the MCP panel lists its servers and explains nothing about what we have not built', () => {
  const html = renderToStaticMarkup(
    <McpPanel
      snapshot={snapshot({
        mcp: [{ name: 'linear', transport: 'sse', scope: 'user', url: 'https://x/sse' }],
      })}
    />,
  )

  // The real row still renders, and the pill still says what is true of it.
  expect(html).toContain('linear')
  expect(html).toContain('Configured')
  // The removed note, by each of its distinguishing phrases.
  expect(html).not.toContain('not available here yet')
  expect(html).not.toContain('Connection status')
  expect(html).not.toContain('Shown from configuration only')
})

test('an empty MCP panel says only that nothing is configured', () => {
  const html = renderToStaticMarkup(<McpPanel snapshot={snapshot()} />)

  expect(html).toContain('No MCP servers configured.')
  expect(html).not.toContain('not available')
})

test('the installed-plugins tab carries no deferral note', () => {
  const html = renderToStaticMarkup(<PluginsPanel snapshot={snapshot()} />)

  expect(html).toContain('No plugins installed.')
  expect(html).not.toContain('not available')
})

test('the marketplace tab tells the user what to do, not what we have not built', () => {
  const start = MODULE.indexOf("tab === 'marketplace'")
  expect(start).toBeGreaterThan(-1)
  const branch = MODULE.slice(start, MODULE.indexOf(': plugins === null', start))

  expect(branch).toContain('Install plugins from the terminal.')
  expect(branch).not.toContain('not available')
  expect(branch).not.toContain('Browsing and installing')
})

test('the DeferredNote twin that survived the 2026-07-27 sweep is gone', () => {
  // Named explicitly: a helper whose only job is to print roadmap notes must
  // not survive to be reused by the next panel added here.
  expect(MODULE).not.toContain('DeferredNote')
})
