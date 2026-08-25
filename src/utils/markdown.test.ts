import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Tokens } from 'marked'

const hyperlinkCalls: Array<{ url: string; content?: string }> = []
const actualHyperlink = await import('./hyperlink.js')
const realCreateHyperlink = actualHyperlink.createHyperlink

mock.module('./hyperlink.js', () => ({
  ...actualHyperlink,
  createHyperlink: (...args: Parameters<typeof realCreateHyperlink>) => {
    hyperlinkCalls.push({ url: args[0], content: args[1] })
    return realCreateHyperlink(...args)
  },
}))

const { applyMarkdown, formatToken } = await import('./markdown.js')

beforeEach(() => {
  hyperlinkCalls.length = 0
})

afterEach(() => {
  hyperlinkCalls.length = 0
})

function renderLink(markdown: string): { url: string; content?: string } {
  const callCount = hyperlinkCalls.length
  applyMarkdown(markdown, 'dark')
  expect(hyperlinkCalls).toHaveLength(callCount + 1)
  return hyperlinkCalls[callCount]!
}

function formatLinkToken(
  href: string,
): { url: string; content?: string } {
  const callCount = hyperlinkCalls.length
  const link: Tokens.Link = {
    type: 'link',
    raw: `[folder](${href})`,
    href,
    title: null,
    text: 'folder',
    tokens: [{ type: 'text', raw: 'folder', text: 'folder', escaped: false }],
  }

  formatToken(link, 'dark')
  expect(hyperlinkCalls).toHaveLength(callCount + 1)
  return hyperlinkCalls[callCount]!
}

describe('Markdown links', () => {
  test('encodes absolute filesystem paths as file URLs while preserving the visible text', () => {
    const link = renderLink(
      '[`review-impl/SKILL.md`](/Users/pt/.agents/skills/review-impl/SKILL.md)',
    )

    expect(link.url).toBe(
      'file:///Users/pt/.agents/skills/review-impl/SKILL.md',
    )
    expect(link.content).toContain('review-impl/SKILL.md')
  })

  test('percent-encodes filesystem paths and leaves relative and web links unchanged', () => {
    expect(formatLinkToken('/Users/pt/My Folder/file.md').url).toBe(
      'file:///Users/pt/My%20Folder/file.md',
    )
    expect(renderLink('[README](docs/README.md)').url).toBe('docs/README.md')
    expect(renderLink('[docs](https://example.com/docs)').url).toBe(
      'https://example.com/docs',
    )
  })

  test('keeps mailto links as plain email text', () => {
    expect(applyMarkdown('[email](mailto:a@example.com)', 'dark')).toBe(
      'a@example.com',
    )
    expect(hyperlinkCalls).toHaveLength(0)
  })
})
