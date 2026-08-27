/**
 * The provider's own job: read the stored preference, publish it, and stamp it
 * on the injected root.
 *
 * SSR-only, like the rest of the renderer's preference suites. `renderToString`
 * does not run effects, so the stamp is driven through the same `root` the
 * provider would hand `applyGlassMode` rather than by mounting.
 */
import { expect, test } from 'bun:test'
import { useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlassModeProvider } from './GlassModeProvider.js'
import {
  DEFAULT_GLASS_ENABLED,
  GlassModeContext,
  GLASS_STORAGE_KEY,
} from './glassMode.js'

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
}

/** Reads the published value the Settings row will read. */
function Probe() {
  const { glass } = useContext(GlassModeContext)
  return <span>{glass ? 'glass' : 'solid'}</span>
}

function render(store: Parameters<typeof GlassModeProvider>[0]['storage']) {
  return renderToStaticMarkup(
    <GlassModeProvider root={null} storage={store}>
      <Probe />
    </GlassModeProvider>,
  )
}

test('a stored preference reaches the consumers', () => {
  expect(
    render(storage({ [GLASS_STORAGE_KEY]: JSON.stringify({ version: 1, enabled: true }) })),
  ).toContain('glass')
})

test('an empty or unavailable store falls back to the shipped default', () => {
  const expected = DEFAULT_GLASS_ENABLED ? 'glass' : 'solid'
  expect(render(storage())).toContain(expected)
  expect(render(null)).toContain(expected)
})

test('a corrupt stored preference degrades to the shipped default', () => {
  expect(render(storage({ [GLASS_STORAGE_KEY]: '{oops' }))).toContain('solid')
})

/** No wrapper element: the paint target is above `#root` entirely. */
test('the provider adds nothing to the tree', () => {
  expect(render(storage())).toBe('<span>solid</span>')
})
