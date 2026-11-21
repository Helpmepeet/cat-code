import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'

const introduction = `${REPL_TOOL_NAME} runs JavaScript over your granted tools and returns selected output.`
const contract = 'Follow its discovery, state-reset, and instruction-yield contract.'

export const DIRECT_SCRIPT_TOOL_GUIDANCE = `${introduction} Use it for dependent tool workflows or filtering large intermediate results; direct coding tools remain available. ${contract}`

const scriptFirstGuidance = `${introduction} Use ${REPL_TOOL_NAME} for file and shell operations. ${contract}`

export function withScriptFirstToolGuidance(systemPrompt: SystemPrompt): SystemPrompt {
  const directLine = `\n - ${DIRECT_SCRIPT_TOOL_GUIDANCE}\n`
  const section = systemPrompt.findIndex(part =>
    /^# using your tools\n/i.test(part) && part.includes(directLine),
  )
  if (section === -1) return systemPrompt

  const updated = [...systemPrompt]
  updated[section] = updated[section]!.replace(directLine, `\n - ${scriptFirstGuidance}\n`)
  return asSystemPrompt(updated)
}
