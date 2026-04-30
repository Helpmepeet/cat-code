import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getEditConstraintLines(): string[] {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const lines = [
    `You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.`,
    `When copying text from Read output, preserve the exact indentation (tabs/spaces) that appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the real file content to match. Never include any part of the line number prefix in \`old_string\` or \`new_string\`.`,
    'Prefer editing existing files in the codebase. Do not create new files unless explicitly required.',
    'Use emojis only if the user explicitly requests them.',
    '\`old_string\` must identify the intended edit location unambiguously. If it is not unique, either include slightly more surrounding context or set \`replace_all\` to true to change every match.',
    'Use \`replace_all\` for repeated replacements or renames across the file.',
  ]

  if (process.env.USER_TYPE === 'ant') {
    lines.push(
      'Use the smallest \`old_string\` that is clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.',
    )
  }

  return lines
}

export function getEditToolDescription(
  provider: APIProvider = getAPIProvider(),
): string {
  const ordered = isGPTPromptStyle(provider)
  const heading = ordered ? 'EDITING CONSTRAINTS:' : 'Usage:'
  const formattedLines = getEditConstraintLines()
    .map((line, index) => (ordered ? `${index + 1}. ${line}` : `- ${line}`))
    .join('\n')

  return `Performs exact string replacements in files.

${heading}
${formattedLines}`
}
