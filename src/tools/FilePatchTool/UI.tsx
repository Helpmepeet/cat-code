import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { Text } from '../../ink.js'
import type { ToolProgressData, Tools } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { extractTag } from '../../utils/messages.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  type FilePatchToolInput,
  type FilePatchToolOutput,
  firstLineForLanguageDetection,
} from './types.js'

export function userFacingName(input?: Partial<FilePatchToolInput>): string {
  if (!input) return 'Update'
  const ops = 'ops' in input ? input.ops : undefined
  if (!ops?.length) return 'Update'
  if (ops.length === 1) {
    const type = ops[0]?.type
    if (type === 'add') return 'Create'
    if (type === 'delete') return 'Delete'
  }
  return 'Update'
}

export function getToolUseSummary(
  input: Partial<FilePatchToolInput> | undefined,
): string | null {
  if (!input) {
    return null
  }

  if ('ops' in input && input.ops?.length) {
    const firstPath = input.ops[0]?.path
    if (!firstPath) {
      return null
    }
    return input.ops.length === 1
      ? getDisplayPath(firstPath)
      : `${getDisplayPath(firstPath)} +${input.ops.length - 1}`
  }

  return 'patch'
}

export function renderToolUseMessage(
  input: Partial<FilePatchToolInput>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const summary = getToolUseSummary(input)
  if (!summary) {
    return null
  }

  if ('ops' in input && input.ops?.length === 1 && input.ops[0]?.path) {
    return (
      <FilePathLink filePath={input.ops[0].path}>
        {verbose ? input.ops[0].path : summary}
      </FilePathLink>
    )
  }

  return summary
}

// Language detection only ever needed the file's first line. New results carry
// it directly; transcripts written before that still carry the full
// before/after text, so fall back to those with the same precedence. The bound
// applies on this path too: it is display-only, so nothing is persisted, but a
// legacy result holding a one-line minified bundle would otherwise re-scan the
// whole file for shebang markers on every render.
function firstLineOf(file: FilePatchToolOutput['files'][number]): string | null {
  return firstLineForLanguageDetection(
    file.firstLine ?? file.before ?? file.after,
  )
}

export function renderToolResultMessage(
  output: FilePatchToolOutput,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean; tools: Tools },
): React.ReactNode {
  if (output.files.length === 0) {
    return (
      <MessageResponse>
        <Text>(No changes)</Text>
      </MessageResponse>
    )
  }

  if (output.files.length === 1) {
    const file = output.files[0]
    return (
      <FileEditToolUpdatedMessage
        filePath={file.path}
        structuredPatch={file.structuredPatch}
        firstLine={firstLineOf(file)}
        style={style}
        verbose={verbose}
      />
    )
  }

  return (
    <MessageResponse>
      {output.files.map(file => (
        <FileEditToolUpdatedMessage
          key={`${file.type}:${file.path}`}
          filePath={file.path}
          structuredPatch={file.structuredPatch}
          firstLine={firstLineOf(file)}
          style={style}
          verbose={verbose}
        />
      ))}
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (
    !verbose &&
    typeof result === 'string' &&
    extractTag(result, 'tool_use_error')
  ) {
    return (
      <MessageResponse>
        <Text color="error">Edit failed</Text>
      </MessageResponse>
    )
  }

  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}
