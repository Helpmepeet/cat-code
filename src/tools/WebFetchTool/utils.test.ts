import { afterEach, describe, expect, mock, test } from 'bun:test'

import * as realClaudeApi from '../../services/api/claude.js'

const queryHaiku = mock(async () => ({
  message: {
    content: [{ type: 'text', text: 'summarized content' }],
  },
}))

mock.module('../../services/api/claude.js', () => ({
  ...realClaudeApi,
  queryHaiku,
}))

describe('applyPromptToMarkdown', () => {
  afterEach(() => {
    queryHaiku.mockClear()
  })

  test('passes its tool-context agent owner to the Haiku request', async () => {
    const { applyPromptToMarkdown } = await import('./utils.js')

    await expect(
      applyPromptToMarkdown(
        'Extract the key facts.',
        'Fetched markdown content.',
        new AbortController().signal,
        false,
        false,
        'web-fetch-agent' as never,
      ),
    ).resolves.toBe('summarized content')

    expect(queryHaiku).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          agentId: 'web-fetch-agent',
          querySource: 'web_fetch_apply',
        }),
      }),
    )
  })
})
