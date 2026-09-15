import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../ResumeAgentTool/constants.js'
import { TASK_OUTPUT_TOOL_NAME } from '../TaskOutputTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentContinuationCapabilities } from './agentToolUtils.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { type APIProvider } from '../../utils/model/providers.js'

function getToolsDescription(agent: AgentDefinition): string {
  if (agent.agentType === 'verification') {
    return 'Read-only async verification tools when available: Bash, Read, search, web, and MCP tools; excludes edit/write, recursive-agent, and worker-control tools'
  }

  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // Both defined: filter allowlist by denylist to match runtime behavior
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // Allowlist only: show the specific tools available
    return tools.join(', ')
  } else if (hasDenylist) {
    // Denylist only: show "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // No restrictions
  return 'All tools'
}

/**
 * Format one agent line for the agent_listing_delta attachment message:
 * `- type: whenToUse (Tools: ...)`.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * Whether the agent list should be injected as an attachment message instead
 * of embedded in the tool description. When true, getPrompt() returns a static
 * description and attachments.ts emits an agent_listing_delta attachment.
 *
 * The dynamic agent list was ~10.2% of fleet cache_creation tokens: MCP async
 * connect, /reload-plugins, or permission-mode changes mutate the list →
 * description changes → full tool-schema cache bust.
 *
 * Override with CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false for testing.
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
  provider?: APIProvider,
  capabilities?: AgentContinuationCapabilities,
): Promise<string> {
  // Undefined capabilities means an older call site that hasn't been wired
  // to pass them — default to "everything available" rather than the
  // conservative default used for persisted result rendering, since
  // AgentTool.tsx's own prompt() always passes real capabilities now and an
  // unknown/other caller shouldn't have guidance silently stripped.
  const canResumeAgent = capabilities?.canResumeAgent ?? true
  const canSendMessage = capabilities?.canSendMessage ?? true
  const canStopTask = capabilities?.canStopTask ?? true
  // Filter agents by allowed types when Agent(x,y) restricts which agents can be spawned
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork subagent feature: when enabled, insert the "When to fork" section
  // (fork semantics, directive-style prompts) and swap in fork-aware examples.
  const forkEnabled = isForkSubagentEnabled()

  const delegationGuidance = `DELEGATION BOUNDARIES:
- Give the worker a bounded objective, relevant context, constraints, and acceptance criteria. Delegate only when permitted by the applicable instructions.
- When the selected worker is in the same capability tier or stronger for the task, let it investigate, synthesize findings, and choose its approach within that scope. Supply exact implementation steps when the user requires them or they are already decided.
- For a weaker worker, narrow the assignment and provide more concrete guidance where needed. Do not infer capability from price alone; if relative capability is unknown, state what is known and provide enough context without inventing a model ranking.
- Freedom to choose a method does not expand permissions or the assigned scope. Assess the worker's findings, actual changes, and verification evidence before relying on its result.`

  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative — "will I need this output again" — not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this — it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. A fork may investigate and implement within the assigned scope.

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork — a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

**Don't peek.** The tool result includes an \`output_file\` path, but it is a debug transcript path — do not use it for progress or results. If your next step depends on the fork's result before the completion notification arrives, use ${TASK_OUTPUT_TOOL_NAME} with \`block=true\`. Inspect the transcript only when the user explicitly asks for raw transcript forensics. Pulling transcript content mid-flight brings the fork's tool noise into your context, which defeats the point of forking.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Handoff completeness.** Include known files and evidence, relevant current state (uncommitted changes, prior failed attempts, or a dirty baseline), what "done" looks like, and the constraints the agent must follow. Distinguish established facts from hypotheses. If the affected files or solution are not yet known, make finding them part of the bounded assignment; do not invent paths or require the parent to solve the task first.
`

  const isGPTPromptStyle = provider === 'openai'

  const forkExamplesGPT = `Example usage:

user: "What's left on this branch before we can ship?"
assistant: [Forking — survey question, I want the punch list not the git output in my context.]
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
[Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn — the notification arrives from outside, as a user-role message. It is not something the coordinator writes.]
[later turn — notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.

---

user: "so is the gate wired up or not"
[User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.]
assistant: Still waiting on the audit — that's one of the things it's checking. Should land shortly.

---

user: "Can you get a second opinion on whether this migration is safe?"
assistant: [Spawning code-reviewer — it won't see my analysis, so it gives an independent read.]
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
`

  const forkExamplesClaude = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this — it's a survey question. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list — done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn — the notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn — notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit — that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  const forkExamples = isGPTPromptStyle ? forkExamplesGPT : forkExamplesClaude

  // When the gate is on, the agent list lives in an agent_listing_delta
  // attachment (see attachments.ts) instead of inline here. This keeps the
  // tool description static across MCP/plugin/permission changes so the
  // tools-block prompt cache doesn't bust every time an agent loads.
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // Shared core prompt used by both coordinator and non-coordinator modes
  const shared = isGPTPromptStyle
    ? `Launch a new agent to handle complex, multi-step tasks autonomously.

TOOL PURPOSE:
- Use the ${AGENT_TOOL_NAME} tool to delegate work that benefits from specialization, independent research, or parallel execution.
- Each agent type has specific capabilities and tool access.

${agentListSection}

${
  forkEnabled
    ? `AGENT SELECTION:
- Set \`subagent_type\` to use a specialized agent.
- Omit \`subagent_type\` to fork yourself. A fork inherits your full conversation context.`
    : `AGENT SELECTION:
- Set \`subagent_type\` to select which agent type to use.
- If you omit it, the general-purpose agent is used.`
}`
    : `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}`

  if (isCoordinator) {
    return `${shared}\n\n${delegationGuidance}`
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // The "class Foo" example is a content search, so both paths point at a
  // content searcher: embedded builds have no dedicated Grep tool and use grep
  // via Bash; everywhere else uses the Grep tool. Glob matches file names only.
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GREP_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : isGPTPromptStyle
      ? `
WHEN NOT TO USE THE ${AGENT_TOOL_NAME} TOOL:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead.
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead.
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead.
- Do not use ${AGENT_TOOL_NAME} for tasks unrelated to the available agent roles.`
      : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // Removed: this note pushed aggressive concurrent/background spawning
  // based on the Anthropic subscription tier (getSubscriptionType()), which
  // has no relation to the account actually executing requests when routed
  // through a non-Anthropic provider (e.g. a Codex/ChatGPT account) — the
  // gate was blind to the tier that actually matters for that session.
  const concurrencyNote = ''

  const usageHeader = isGPTPromptStyle ? 'USAGE RULES:' : 'Usage notes:'

  // Non-coordinator gets the full prompt with all sections
  return `${shared}

${delegationGuidance}
${whenNotToUseSection}

${usageHeader}
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
${canStopTask ? `- To stop a running background agent, use ${TASK_STOP_TOOL_NAME} with \`task_id\` set to the \`agentId\` returned by ${AGENT_TOOL_NAME}.${canSendMessage ? ` ${SEND_MESSAGE_TOOL_NAME} does not cancel it.` : ''}\n` : ''}- ${
    canResumeAgent
      ? `To continue a previously spawned stopped agent, use ${RESUME_AGENT_TOOL_NAME} with the agent's ID or name as the \`agentId\` field. The agent resumes from its prior transcript. `
      : `A completed or stopped agent cannot be resumed from this context — ${RESUME_AGENT_TOOL_NAME} is not available here; spawn a fresh ${AGENT_TOOL_NAME} instead. `
  }${canSendMessage ? `Use ${SEND_MESSAGE_TOOL_NAME} only for agents that are still running; a queued message is delivered in the worker's next model round and does not interrupt its current work. ` : ''}${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context; provide a complete task description.' : 'Each Agent invocation starts fresh; provide a complete task description.'}
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ', since it is not aware of the user\'s intent'}.
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    process.env.USER_TYPE === 'ant'
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}${forkEnabled ? `\n\n${forkExamples}` : ''}`
}
