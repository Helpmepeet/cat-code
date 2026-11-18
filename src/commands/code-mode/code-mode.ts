import { getSessionId } from '../../bootstrap/state.js'
import { REPL_TOOL_NAME } from '../../tools/REPLTool/constants.js'
import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (args, context) => {
  const option = args.trim()
  const sessionId = getSessionId()
  if (option === '') {
    const state = context.getAppState().codeModeFirstSessionId === sessionId ? 'on' : 'off'
    return { type: 'text', value: `Code Mode is ${state} for this chat. Use /code-mode on or /code-mode off.` }
  }
  if (option !== 'on' && option !== 'off') {
    return { type: 'text', value: 'Use /code-mode on or /code-mode off.' }
  }
  if (option === 'on' && (!context.codeModeHost || !context.options.tools.some(
    tool => tool.name === REPL_TOOL_NAME && !tool.isMcp && !tool.mcpInfo,
  ))) {
    return { type: 'text', value: 'Script is not available in this chat.' }
  }
  const enabledSessionId = option === 'on' ? sessionId : undefined
  context.setAppState(state => state.codeModeFirstSessionId === enabledSessionId
    ? state : { ...state, codeModeFirstSessionId: enabledSessionId })
  return {
    type: 'text',
    value: option === 'on'
      ? 'Code Mode is on. Cat Code uses Script first for coding tasks.'
      : 'Code Mode is off. Direct coding tools are available again.',
  }
}
