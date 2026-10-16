import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderLogo } from './ProviderLogo.js'

test('anthropic and openai render distinct marks, cloud hosts render nothing', () => {
  const claude = renderToStaticMarkup(<ProviderLogo provider="anthropic" />)
  const openai = renderToStaticMarkup(<ProviderLogo provider="openai" />)
  expect(claude).toContain('<path')
  expect(openai).toContain('<path')
  expect(claude).not.toBe(openai)
  expect(claude).toContain('aria-hidden="true"')
  for (const provider of ['bedrock', 'vertex', 'foundry']) {
    expect(renderToStaticMarkup(<ProviderLogo provider={provider} />)).toBe('')
  }
})
