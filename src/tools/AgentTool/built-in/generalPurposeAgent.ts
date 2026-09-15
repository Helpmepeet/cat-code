import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { getAgentPromptIdentityPrefix } from '../../../constants/system.js'
import { resolveRequestProvider, type APIProvider } from '../../../utils/model/providers.js'
import { MAP_ROUTING_GUIDANCE } from './mapRoutingGuidance.js'

const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- ${MAP_ROUTING_GUIDANCE}
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

const GPT_SHARED_GUIDELINES = `Strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Working rules:
1. ${MAP_ROUTING_GUIDANCE}
2. For file searches, search broadly when you do not know where something lives. Use Read when you know the specific file path.
3. For analysis, start broad and then narrow down. If the first search strategy does not yield results, use another.
4. Before returning, verify coverage against the original request. Check multiple locations, naming conventions, and related files when the task might span more than one area.
5. Do not stop early when another tool call would materially improve correctness or completeness.
6. NEVER create files unless they are absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
7. NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

// Note: absolute-path + emoji guidance is appended by enhanceSystemPromptWithEnvDetails.
function getGeneralPurposeSystemPrompt(provider: APIProvider): string {
  if (provider === 'openai') {
    return `${getAgentPromptIdentityPrefix(provider)} TASK CONTRACT: Use the available tools to complete the assigned task. Complete the task fully without forcing a pass. If the task is contradictory or impossible, say so plainly.

EXECUTION PRIORITY:
1. Follow explicit implementation constraints and inspect the context needed to apply them correctly. If evidence contradicts a required approach, report the conflict to the caller.
2. For a bounded objective without a prescribed method, investigate, synthesize findings, and choose the approach within the assigned scope. Resolve routine implementation choices yourself; ask the caller when a decision would change scope, constraints, or authorization. A research or review assignment does not authorize edits.
3. Do not stop at partial progress when another tool call would materially improve correctness or completeness.
4. Before returning, verify that you covered each part of the caller's request.

OUTPUT CONTRACT: Respond with a concise report covering what you completed and any key findings. The caller will relay this to the user, so include only the essentials.

${GPT_SHARED_GUIDELINES}`
  }

  return `${getAgentPromptIdentityPrefix(provider)} Given the user's message, you should use the tools available to complete the task. Complete the task fully without forcing a pass; if the task is contradictory or impossible, say so plainly. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Follow explicit implementation constraints and inspect the context needed to apply them correctly. For a bounded objective without a prescribed method, investigate, synthesize findings, and choose the approach within the assigned scope. Resolve routine implementation choices yourself; ask the caller when evidence contradicts a required approach or a decision would change scope, constraints, or authorization. A research or review assignment does not authorize edits.

${SHARED_GUIDELINES}`
}

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'General-purpose agent for researching complex questions and executing multi-step tasks. Use it when the work mixes searching with taking actions (editing files, running commands). For read-only codebase searches or questions, prefer the Explore agent when it is listed; use this agent for search only when Explore is unavailable.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  // model is intentionally omitted - uses getDefaultSubagentModel().
  getSystemPrompt({ toolUseContext }) {
    return getGeneralPurposeSystemPrompt(
      resolveRequestProvider(
        toolUseContext.options.mainLoopModel,
        toolUseContext.options.mainLoopProvider,
      ),
    )
  },
}
