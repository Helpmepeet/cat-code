import { feature } from 'bun:bundle'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../ResumeAgentTool/constants.js'

export const DESCRIPTION = 'Send a message to another agent'

export function getPrompt(): string {
  if (!isAgentSwarmsEnabled()) {
    return `
# SendMessage

This tool targets recipients that are currently running. To restart a stopped subagent, use ${RESUME_AGENT_TOOL_NAME}. To start a fresh subagent, use ${AGENT_TOOL_NAME}.

\`\`\`json
{"to": "implement-auth", "summary": "fix failing test", "message": "The auth test is failing on the expired-token branch. Please inspect the failure and patch only your assigned files."}
\`\`\`

Use this to queue a follow-up to a relevant running worker instead of spawning a duplicate. A queued message is delivered at the worker's next tool round — it does not interrupt the worker's current work.

Available without Agent Teams:

- plain text messages to running worker handles
- plain text messages to running raw agent IDs

Requires Agent Teams:

- broadcast with \`"*"\`
- teammate mailbox fallback by arbitrary teammate name
- structured protocol messages
- cross-session UDS or bridge messages
`.trim()
  }

  const udsRow = feature('UDS_INBOX')
    ? `\n| \`"uds:/path/to.sock"\` | Local agent session's socket (same machine; use \`ListPeers\`) |
| \`"bridge:session_..."\` | Remote Control peer session (cross-machine; use \`ListPeers\`) |`
    : ''
  const udsSection = feature('UDS_INBOX')
    ? `\n\n## Cross-session

Use \`ListPeers\` to discover targets, then:

\`\`\`json
{"to": "uds:/tmp/cc-socks/1234.sock", "message": "check if tests pass over there"}
{"to": "bridge:session_01AbCd...", "message": "what branch are you on?"}
\`\`\`

A listed peer is alive and will process your message — no "busy" state; messages enqueue and drain at the receiver's next tool round. Your message arrives wrapped as \`<cross-session-message from="...">\`. **To reply to an incoming message, copy its \`from\` attribute as your \`to\`.**`
    : ''
  return `
# SendMessage

Send a message to another running agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |${udsRow}

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. A message is delivered at the recipient's next tool round; it does not interrupt their current work. Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.${udsSection}

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.
`.trim()
}
