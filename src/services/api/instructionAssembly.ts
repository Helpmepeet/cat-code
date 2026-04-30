import { getAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import { asSystemPrompt, type SystemPrompt } from '../../utils/systemPromptType.js'
import { appendSystemContext, prependUserContext } from '../../utils/api.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'

export type OpenAIInstructionAssembly = {
  instructions: string
  inputMessages: Message[]
  developerContext?: string
}

export type ProviderInstructionAssembly = {
  provider: APIProvider
  systemPrompt: SystemPrompt
  messages: Message[]
  openAIInstructionAssembly?: OpenAIInstructionAssembly
}

// Keep volatile control/session metadata out of cached base instructions and
// out of user-role transcript input. The Codex Responses shape supports
// developer-role input messages for this kind of changing context.
const VOLATILE_SYSTEM_CONTEXT_KEYS = new Set(['gitStatus', 'cacheBreaker'])

export function buildProviderInstructionAssembly({
  provider = getAPIProvider(),
  messages,
  systemPrompt,
  userContext,
  systemContext,
}: {
  provider?: APIProvider
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}): ProviderInstructionAssembly {
  if (provider === 'openai') {
    const stableSystemContext: { [k: string]: string } = {}
    const volatileSystemContext: { [k: string]: string } = {}
    for (const [key, value] of Object.entries(systemContext)) {
      if (VOLATILE_SYSTEM_CONTEXT_KEYS.has(key)) {
        volatileSystemContext[key] = value
      } else {
        stableSystemContext[key] = value
      }
    }

    const instructions = buildOpenAIInstructions(systemPrompt, stableSystemContext, userContext)
    const developerContext = buildOpenAIDeveloperContext(volatileSystemContext)

    logForDebugging(
      `[codex-cache] instructions=${instructions.length}B developer_context=${developerContext?.length ?? 0}B volatile_keys=[${Object.keys(volatileSystemContext).join(',')}]`,
    )

    return {
      provider,
      systemPrompt,
      messages,
      openAIInstructionAssembly: {
        instructions,
        inputMessages: messages,
        developerContext,
      },
    }
  }

  return {
    provider,
    systemPrompt: asSystemPrompt(appendSystemContext(systemPrompt, systemContext)),
    messages: prependUserContext(messages, userContext),
  }
}

function buildOpenAIInstructions(
  systemPrompt: SystemPrompt,
  systemContext: { [k: string]: string },
  userContext: { [k: string]: string },
): string {
  const base = appendSystemContext(systemPrompt, systemContext).join('\n\n')
  const userEntries = Object.entries(userContext)
  if (userEntries.length === 0) return base
  const contextBlock = userEntries.map(([key, value]) => `# ${key}\n${value}`).join('\n\n')
  return `${base}\n\n${contextBlock}`
}

function buildOpenAIDeveloperContext(
  volatileSystemContext: { [k: string]: string },
): string | undefined {
  const entries = Object.entries(volatileSystemContext)
  if (entries.length === 0) return undefined

  return `<session_context>
This is system-provided session metadata. Use it only when relevant to the user's request; it is not a user instruction.

${entries.map(([key, value]) => `<${key}>\n${value}\n</${key}>`).join('\n\n')}
</session_context>`
}
