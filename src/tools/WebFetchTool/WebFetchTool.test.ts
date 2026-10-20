import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { ToolPermissionContext } from '../../Tool.js'

const applyPromptToMarkdown = mock(async () => 'summarized content')
const actualUtils = await import('./utils.js')
const realUtils = { ...actualUtils }
const realApplyPromptToMarkdown = actualUtils.applyPromptToMarkdown
const realGetURLMarkdownContent = actualUtils.getURLMarkdownContent
const realIsPreapprovedUrl = actualUtils.isPreapprovedUrl
let webFetchStubActive = false

mock.module('./utils.js', () => {
  const getURLMarkdownContent = mock(async () => ({
    bytes: 24,
    code: 200,
    codeText: 'OK',
    content: 'Fetched markdown content.',
    contentType: 'text/html',
  }))
  return {
    ...realUtils,
    applyPromptToMarkdown: async (...args: Parameters<typeof actualUtils.applyPromptToMarkdown>) =>
      webFetchStubActive
        ? applyPromptToMarkdown(...args)
        : realApplyPromptToMarkdown(...args),
    getURLMarkdownContent: async (
      ...args: Parameters<typeof actualUtils.getURLMarkdownContent>
    ) =>
      webFetchStubActive
        ? getURLMarkdownContent(...args)
        : realGetURLMarkdownContent(...args),
    isPreapprovedUrl: (...args: Parameters<typeof actualUtils.isPreapprovedUrl>) =>
      webFetchStubActive
        ? false
        : realIsPreapprovedUrl(...args),
  }
})

describe('WebFetchTool', () => {
  beforeEach(() => {
    webFetchStubActive = true
  })

  afterEach(() => {
    webFetchStubActive = false
    applyPromptToMarkdown.mockClear()
    mock.restore()
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

// checkPermissions reads isPreapprovedHost from './preapproved.js', not the
// isPreapprovedUrl mocked out of './utils.js' above, so these cases run
// against the real preapproved list. 'docs.python.org' is on it.
function permissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
    ...overrides,
  }
}

function toolUseContext(toolPermissionContext: ToolPermissionContext) {
  return { getAppState: () => ({ toolPermissionContext }) } as never
}

describe('WebFetchTool.checkPermissions', () => {
  test('an explicit deny rule beats the preapproved host list', async () => {
    const { WebFetchTool } = await import('./WebFetchTool.js')

    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://docs.python.org/3/library/os.html', prompt: 'Summarize.' },
      toolUseContext(
        permissionContext({
          alwaysDenyRules: {
            localSettings: ['WebFetch(domain:docs.python.org)'],
          },
        }),
      ),
    )

    expect(decision.behavior).toBe('deny')
  })

  test('an explicit ask rule beats the preapproved host list', async () => {
    const { WebFetchTool } = await import('./WebFetchTool.js')

    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://docs.python.org/3/library/os.html', prompt: 'Summarize.' },
      toolUseContext(
        permissionContext({
          alwaysAskRules: {
            localSettings: ['WebFetch(domain:docs.python.org)'],
          },
        }),
      ),
    )

    expect(decision.behavior).toBe('ask')
  })

  test('a preapproved host with no matching rule still allows without prompting', async () => {
    const { WebFetchTool } = await import('./WebFetchTool.js')

    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://docs.python.org/3/library/os.html', prompt: 'Summarize.' },
      toolUseContext(
        permissionContext({
          alwaysDenyRules: {
            localSettings: ['WebFetch(domain:huggingface.co)'],
          },
        }),
      ),
    )

    expect(decision.behavior).toBe('allow')
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: 'Preapproved host',
    })
  })

  test('a non-preapproved host with no matching rule still asks', async () => {
    const { WebFetchTool } = await import('./WebFetchTool.js')

    const decision = await WebFetchTool.checkPermissions(
      { url: 'https://example.com/docs', prompt: 'Summarize.' },
      toolUseContext(permissionContext()),
    )

    expect(decision.behavior).toBe('ask')
  })
})
