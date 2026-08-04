import { describe, expect, test } from 'bun:test'
import * as React from 'react'

import { MAX_PERSISTED_FIRST_LINE_LENGTH } from '../../utils/diff.js'
import { renderToolResultMessage, renderToolUseErrorMessage } from './UI.js'

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

describe('FileEditTool result rendering', () => {
  const structuredPatch = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-const a = 1', '+const a = 2'],
    },
  ]
  const base = {
    filePath: '/x/a.ts',
    oldString: 'const a = 1',
    newString: 'const a = 2',
    userModified: false,
    replaceAll: false,
    structuredPatch,
  }
  const renderOptions = { verbose: false } as never

  function render(result: object) {
    return renderToolResultMessage(result as never, [], renderOptions) as {
      props: Record<string, unknown>
    }
  }

  test('uses the persisted firstLine for language detection', () => {
    const element = render({ ...base, firstLine: '#!/usr/bin/env node' })

    expect(element.props.firstLine).toBe('#!/usr/bin/env node')
    // The whole-file prop is inert downstream (ColorDiff voids prefixContent).
    expect(element.props.fileContent).toBeUndefined()
  })

  test('falls back to a legacy result that only has originalFile', () => {
    const element = render({
      ...base,
      originalFile: '#!/usr/bin/env node\nconst a = 1\n',
    })

    expect(element.props.firstLine).toBe('#!/usr/bin/env node')
  })

  test('bounds the first line it hands the language detector', () => {
    const element = render({
      ...base,
      originalFile: `var a=1;${'x'.repeat(500_000)}\n`,
    })

    expect(element.props.firstLine).toHaveLength(
      MAX_PERSISTED_FIRST_LINE_LENGTH,
    )
  })
})
