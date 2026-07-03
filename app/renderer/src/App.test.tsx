import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from './App.js'

test('renders the live prompt input, permission surface, projected transcript, and raw SDKMessage dump', () => {
  const html = renderToStaticMarkup(<App />)

  expect(html).toContain('aria-label="Prompt"')
  expect(html).toContain('aria-label="Permission requests"')
  expect(html).toContain('Transcript (projected)')
  expect(html).toContain('<pre')
  expect(html).toContain('Raw SDKMessage events')
})
