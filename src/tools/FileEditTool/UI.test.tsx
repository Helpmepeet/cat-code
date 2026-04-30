import { describe, expect, test } from 'bun:test'
import * as React from 'react'

import { renderToolUseErrorMessage } from './UI.js'

function extractText(node: React.ReactNode): string {
  if (
    node == null ||
    typeof node === 'boolean' ||
    typeof node === 'number' ||
    typeof node === 'string'
  ) {
    return String(node ?? '')
  }

  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }

  if (React.isValidElement(node)) {
    return extractText(node.props.children)
  }

  return ''
}

describe('FileEditTool UI error labels', () => {
  test('shows specific labels for common edit failures in non-verbose mode', () => {
    const multipleMatches = renderToolUseErrorMessage(
      '<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>',
      {
        progressMessagesForMessage: [],
        tools: [],
        verbose: false,
      },
    )
    const stringNotFound = renderToolUseErrorMessage(
      '<tool_use_error>String to replace not found in file.</tool_use_error>',
      {
        progressMessagesForMessage: [],
        tools: [],
        verbose: false,
      },
    )
    const staleRead = renderToolUseErrorMessage(
      '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>',
      {
        progressMessagesForMessage: [],
        tools: [],
        verbose: false,
      },
    )
    const invalidParams = renderToolUseErrorMessage(
      '<tool_use_error>InputValidationError: Missing required field old_string</tool_use_error>',
      {
        progressMessagesForMessage: [],
        tools: [],
        verbose: false,
      },
    )

    expect(extractText(multipleMatches)).toContain('Multiple matches found')
    expect(extractText(stringNotFound)).toContain('String not found')
    expect(extractText(staleRead)).toContain('File changed since read')
    expect(extractText(invalidParams)).toContain('Invalid tool parameters')
  })
})
