import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'

const introduction = `${REPL_TOOL_NAME} runs JavaScript over your granted tools and returns selected output.`
const contract = 'Follow its discovery, state-reset, and instruction-yield contract.'

export const DIRECT_SCRIPT_TOOL_GUIDANCE = `${introduction} Use it for dependent tool workflows or filtering large intermediate results; direct coding tools remain available. ${contract}`

const scriptFirstGuidance = `${introduction} Use ${REPL_TOOL_NAME} for file and shell operations. ${contract}`
export const DIRECT_GPT_BATCHING = 'Issue independent tool calls together in one turn.'
const scriptFirstGptBatching = 'Put independent tool calls together in one REPL script.'

const scriptAgent = `${AGENT_TOOL_NAME} through ${REPL_TOOL_NAME}`

export function routeAgentGuidanceThroughScript(text: string): string {
  // Only apply to built-in prompt sections and tool descriptions.
  return text
    .replaceAll(`the ${AGENT_TOOL_NAME} tool's available-agent list`, `the ${AGENT_TOOL_NAME} description discovered through ${REPL_TOOL_NAME}`)
    .replaceAll(`the ${AGENT_TOOL_NAME} tool prompt`, `the ${AGENT_TOOL_NAME} description discovered through ${REPL_TOOL_NAME}`)
    .replaceAll(`the ${AGENT_TOOL_NAME} tool`, scriptAgent)
    .replaceAll(`Calling ${AGENT_TOOL_NAME} without`, `Calling ${scriptAgent} without`)
    .replaceAll(`Use ${AGENT_TOOL_NAME} to start`, `Use ${scriptAgent} to start`)
    .replaceAll(`use ${AGENT_TOOL_NAME}.`, `use ${scriptAgent}.`)
    .replaceAll(`with ${AGENT_TOOL_NAME} instead`, `with ${scriptAgent} instead`)
    .replaceAll(`a fresh ${AGENT_TOOL_NAME} with`, `a fresh subagent launched through ${REPL_TOOL_NAME} with`)
}

export function withScriptAgentGuidance(systemPrompt: SystemPrompt): SystemPrompt {
  const guidance = `Discover ${scriptAgent} using tools.discover, then use tools.call inside the script to launch a worker.`
  const guideSection = systemPrompt.findIndex(section => /^# (using your tools|session-specific guidance)\n/i.test(section))
  if (guideSection === -1) return systemPrompt
  return asSystemPrompt(systemPrompt.map((section, index) => {
    if (!/^# (using your tools|session-specific guidance)\n/i.test(section)) return section
    const routed = routeAgentGuidanceThroughScript(section)
    return index === guideSection ? `${routed}\n - ${guidance}` : routed
  }))
}

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
