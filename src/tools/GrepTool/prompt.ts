import { isGPTPromptStyle } from '../../constants/promptStyle.js'
import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(provider: APIProvider = getAPIProvider()): string {
  if (isGPTPromptStyle(provider)) {
    return `A powerful search tool built on ripgrep

WHEN TO USE:
- Use ${GREP_TOOL_NAME} for content-search tasks.
- Use ${AGENT_TOOL_NAME} for open-ended searches that are likely to require multiple rounds.

SEARCH CONSTRAINTS:
1. ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command when this tool can do the search.
2. The \`pattern\` parameter uses ripgrep regex syntax. Example patterns: "log.*Error", "function\\s+\\w+".
3. Narrow the search with \`glob\` (for example, "*.js" or "**/*.tsx") or \`type\` (for example, "js", "py", "rust") when that improves precision.
4. \`output_mode\` options:
   - \`content\`: return matching lines
   - \`files_with_matches\`: return only file paths (default)
   - \`count\`: return match counts
5. Literal braces must be escaped. Example: use \`interface\\{\\}\` to find \`interface{}\` in Go code.
6. Patterns match within a single line by default. For cross-line matching such as \`struct \\{[\\s\\S]*?field\`, set \`multiline: true\`.`
  }

  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
}
