import { afterEach, describe, expect, mock, test } from 'bun:test'

const applyPromptToMarkdown = mock(async () => 'summarized content')

mock.module('./utils.js', () => ({
  applyPromptToMarkdown,
  getURLMarkdownContent: mock(async () => ({
    bytes: 24,
    code: 200,
    codeText: 'OK',
    content: 'Fetched markdown content.',
    contentType: 'text/html',
  })),
  isPreapprovedUrl: () => false,
  MAX_MARKDOWN_LENGTH: 100_000,
}))

describe('WebFetchTool', () => {
  afterEach(() => {
    applyPromptToMarkdown.mockClear()
  })

  test('forwards the public tool-context agent owner to markdown processing', async () => {
    const { WebFetchTool } = await import('./WebFetchTool.js')
    const abortController = new AbortController()

    await WebFetchTool.call(
      {
        url: 'https://example.com',
        prompt: 'Extract the key facts.',
      },
      {
        abortController,
        agentId: 'web-fetch-agent',
        options: { isNonInteractiveSession: false },
      } as never,
    )

    expect(applyPromptToMarkdown).toHaveBeenCalledWith(
      'Extract the key facts.',
      'Fetched markdown content.',
      abortController.signal,
      false,
      false,
      'web-fetch-agent',
    )
  })
})
