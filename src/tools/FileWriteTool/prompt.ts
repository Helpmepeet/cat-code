import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getWriteConstraintLines(): string[] {
  return [
    'This tool overwrites the existing file at the provided path.',
    `If the target file already exists, you MUST use the ${FILE_READ_TOOL_NAME} tool first to read its current contents. This tool will fail if you did not read the file first.`,
    'Before using Write, check whether Edit is the better tool. Prefer Edit for modifying an existing file because it sends only the diff. Use Write for creating new files or for complete rewrites.',
    'NEVER create documentation files (*.md) or README files unless the user explicitly requests them.',
    'Use emojis only if the user explicitly requests them.',
  ]
}

export function getWriteToolDescription(
  provider: APIProvider = getAPIProvider(),
): string {
  const ordered = isGPTPromptStyle(provider)
  const heading = ordered ? 'WRITE CONSTRAINTS:' : 'Usage:'
  const formattedLines = getWriteConstraintLines()
    .map((line, index) => (ordered ? `${index + 1}. ${line}` : `- ${line}`))
    .join('\n')

  return `Writes a file to the local filesystem.

${heading}
${formattedLines}`
}
