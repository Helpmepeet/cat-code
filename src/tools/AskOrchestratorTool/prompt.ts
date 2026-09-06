export const ASK_ORCHESTRATOR_TOOL_NAME = 'ask_orchestrator'

export const DESCRIPTION = `Hand one question or blocker to the orchestrator and end your run.

This is terminal, not a conversation. The call is the last thing you do: your turn ends the moment it returns, no answer comes back to you, and any work you were planning after it does not happen. The harness reports the run as blocked and carries your \`message\` and \`evidence\` to the orchestrator, which replies by starting or resuming a run, never inside this one.

Call it only when a decision that is not yours to make is what stops you: an instruction that has two defensible readings, context you cannot obtain with the tools you hold, or a next step you judge unsafe. Do NOT call it for anything a read, a search, or a command would settle, and do NOT call it to report work you have finished.

Put the exact question in \`message\`, worded so it can be answered without reading your transcript. Put the attempts, file references, and command output that justify it in \`evidence\`.`
