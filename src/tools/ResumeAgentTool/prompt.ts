import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'Restart a stopped subagent with a new prompt, keeping its prior context (background)'

export function getPrompt(): string {
  return `
# ${RESUME_AGENT_TOOL_NAME}

Restart a stopped subagent or Agent Mode worker with a new prompt. It resumes from the agent's prior transcript after API-validity cleanup (unresolved tool calls from an interrupted run are dropped).

\`\`\`json
{"agentId": "agent-a1b", "prompt": "Continue from your previous findings and patch src/auth/validate.ts. Run the focused auth tests and report the result."}
\`\`\`

Use ${RESUME_AGENT_TOOL_NAME} when a worker has completed, failed, been stopped, or been evicted from live task state but still has a transcript. Use ${SEND_MESSAGE_TOOL_NAME} only to queue a message into a worker that is currently running. Use ${AGENT_TOOL_NAME} to start a fresh subagent when the previous context is not useful.

Resuming replays the agent's whole prior transcript, so its context size carries over. When that context is already large relative to the model's window, prefer a fresh ${AGENT_TOOL_NAME} with a tight brief — the resume/stopped-agent messages report the target's approximate context size to help you judge.

This resumes in the background only and returns once the resumed run is scheduled. You will be notified when it completes.
`.trim()
}
