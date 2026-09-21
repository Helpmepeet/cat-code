import { afterEach, describe, expect, test } from 'bun:test'

import {
  hasEmbeddedRipgrep,
  hasEmbeddedSearchTools,
} from './embeddedTools.js'

const savedSearchTools = process.env.EMBEDDED_SEARCH_TOOLS
const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT

afterEach(() => {
  if (savedSearchTools === undefined) delete process.env.EMBEDDED_SEARCH_TOOLS
  else process.env.EMBEDDED_SEARCH_TOOLS = savedSearchTools
  if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
  else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint
})

describe('embedded search capabilities', () => {
  test('ordinary Bun builds do not advertise argv0 ripgrep dispatch', () => {
    delete process.env.EMBEDDED_SEARCH_TOOLS
    expect(hasEmbeddedRipgrep()).toBe(false)
  })

  test('SDK entrypoints retain binary capability without exposing shell search tools', () => {
    process.env.EMBEDDED_SEARCH_TOOLS = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    expect(hasEmbeddedRipgrep()).toBe(true)
    expect(hasEmbeddedSearchTools()).toBe(false)
  })
})
