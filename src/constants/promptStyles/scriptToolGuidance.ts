import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'

const introduction = `${REPL_TOOL_NAME} runs JavaScript over your granted tools and returns selected output.`
const contract = 'Follow its discovery, state-reset, and instruction-yield contract.'

export const DIRECT_SCRIPT_TOOL_GUIDANCE = `${introduction} Use it for dependent tool workflows or filtering large intermediate results; direct coding tools remain available. ${contract}`

const scriptFirstGuidance = `${introduction} Use ${REPL_TOOL_NAME} for file and shell operations. ${contract}`
export const DIRECT_GPT_BATCHING = 'Issue independent tool calls together in one turn.'
const scriptFirstGptBatching = 'Batch independent file and shell calls in one REPL script.'

export function withScriptFirstToolGuidance(systemPrompt: SystemPrompt, gpt: boolean): SystemPrompt {
  const directLine = `\n - ${DIRECT_SCRIPT_TOOL_GUIDANCE}\n`
  const section = systemPrompt.findIndex(part =>
    /^# using your tools\n/i.test(part) && part.includes(directLine),
  )
  if (section === -1) return asSystemPrompt([
    ...systemPrompt,
    `# Using Your Tools\n - ${scriptFirstGuidance}${gpt ? `\n - ${scriptFirstGptBatching}` : ''}`,
  ])

  const updated = [...systemPrompt]
  updated[section] = updated[section]!.replace(directLine, `\n - ${scriptFirstGuidance}\n`)
  if (gpt) updated[section] = updated[section]!.replace(DIRECT_GPT_BATCHING, scriptFirstGptBatching)
  return asSystemPrompt(updated)
}
