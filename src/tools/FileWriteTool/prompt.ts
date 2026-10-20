import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../FilePatchTool/constants.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getWriteConstraintLines(editToolName: string): string[] {
  return [
    'This tool overwrites the existing file at the provided path.',
    'Inspect the relevant current file contents before modifying an existing file.',
    `Before using Write, check whether ${editToolName} is the better tool. Prefer ${editToolName} for modifying an existing file because it sends only the diff. Use Write for creating new files or for complete rewrites.`,
    'NEVER create documentation files (*.md) or README files unless the user explicitly requests them.',
    'Use emojis only if the user explicitly requests them.',
  ]
}

export function getWriteToolDescription(
  provider: APIProvider = getAPIProvider(),
): string {
  const ordered = isGPTPromptStyle(provider)
  const editToolName = ordered ? FILE_PATCH_TOOL_NAME : FILE_EDIT_TOOL_NAME
  const heading = ordered ? 'WRITE CONSTRAINTS:' : 'Usage:'
  const formattedLines = getWriteConstraintLines(editToolName)
    .map((line, index) => (ordered ? `${index + 1}. ${line}` : `- ${line}`))
    .join('\n')

  return `Writes a file to the local filesystem.

${heading}
${formattedLines}`
}
